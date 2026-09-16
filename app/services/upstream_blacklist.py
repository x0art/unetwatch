"""Upstream blacklist sync: periodic fetch from remote plain-text lists.

Two independent feeds configured via ``UPSTREAM_BLACKLIST_URLS``
(domains/hosts) and ``UPSTREAM_BLACKLIST_IPS`` (IPv4s) — one entry per line,
``#``/``;`` comment lines allowed. Each empty value disables that feed.
Entries are inserted with ``source='upstream'`` using ``INSERT OR IGNORE``,
so re-fetches are idempotent (dedup via the ``UNIQUE(kind, value)``
constraint) and manual/finding entries are never touched or deleted.
Cross-feed duplicates count as skipped, not errors.

After any insert that touched a feed kind, the static feed files are
regenerated via ``sync_regenerate`` so the public ``.txt`` feeds match.
"""

import asyncio
import ipaddress
import logging
import re
from datetime import UTC, datetime

import aiohttp

log = logging.getLogger("unetwatch")

UPSTREAM_USER_AGENT = "uNetWatch-upstream-sync/1.0"
UPSTREAM_FETCH_TIMEOUT_SECONDS = 15
# Bound the upstream body: a compromised list serving gigabytes would otherwise
# be fully buffered into memory on every 5-min sync. 1 MiB ≈ ~50k lines, far
# above any sane host list.
MAX_UPSTREAM_BYTES = 1_048_576

_FEEDS = ("urls", "ips")

# Maps each feed to the `kind` its entries carry. Used only when an
# empty feed is explicitly wiped via `allow_empty_prune` (otherwise the
# prune derives the kind from the rows actually seen).
_FEED_KIND = {"urls": "url", "ips": "ip"}

# Max deleted values included in the `deleted_sample` (sync result) and
# `last_deleted_sample` (status). Also the chunk size for each prune
# DELETE, comfortably below SQLite's variable limit even for ~50k feeds.
_DELETED_SAMPLE_CAP = 100


def _empty_feed_stats() -> dict:
    return {
        "last_added": 0,
        "last_skipped": 0,
        "last_errors": 0,
        "last_error": None,
        "last_deleted": 0,
    }


_LAST_SYNC: dict = {
    "last_sync": None,
    "last_added": 0,
    "last_skipped": 0,
    "last_errors": 0,
    "last_error": None,
    "last_deleted": 0,
    "last_deleted_sample": [],
    "feeds": {"urls": _empty_feed_stats(), "ips": _empty_feed_stats()},
}
# Serialises the whole sync critical section (fetch → insert → prune →
# commit → regenerate) so manual, scheduled, and boot syncs never interleave.
_SYNC_LOCK = asyncio.Lock()


def parse_upstream_body(text: str) -> list[str]:
    """Split an upstream body into candidate lines.

    Lines are stripped; empties and lines starting with ``#`` or ``;``
    (comments) are dropped. Trailing inline comments (whitespace + ``#``
    or ``;`` to EOL) are stripped. Hosts-file lines — exactly 2
    whitespace-separated tokens with the first a valid IPv4 address
    (e.g. ``0.0.0.0 host``) — yield the second token. Lines with other
    spaces are returned as-is so ``normalize_*`` rejects them as
    per-line errors, never silent.

    Bare ``localhost`` and bare IPv6 (e.g. ``::1``) are NOT special-cased
    here: they fall through to ``normalize_blacklist_value``, which
    rejects them for the blacklist (FQDN-or-IPv4 only — ``localhost`` has
    no dot and is not IPv4, IPv6 host split on ``:`` yields ``''``),
    while the jaillist's own normalizer accepts IPv6 canonically. The
    shared parser stays compatible with both.
    """
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith(";"):
            continue
        # Strip inline comments: whitespace + # or ; to EOL. The
        # preceding-whitespace requirement keeps URL fragments/queries
        # (e.g. ?x=1;y=2, #frag without space) intact.
        cleaned = re.sub(r"\s+[#;].*$", "", stripped).strip()
        if not cleaned:
            continue
        tokens = cleaned.split()
        if len(tokens) == 2:
            try:
                ipaddress.IPv4Address(tokens[0])
            except ValueError:
                pass
            else:
                cleaned = tokens[1]
        out.append(cleaned)
    return out


async def _fetch_text(url: str) -> str:
    """Fetch the upstream body; raises ``RuntimeError("http_<status>")`` on
    non-200 so the sync wrapper can report it as a ``reason``."""
    headers = {"User-Agent": UPSTREAM_USER_AGENT}
    timeout = aiohttp.ClientTimeout(total=UPSTREAM_FETCH_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, timeout=timeout) as resp:
            if resp.status != 200:
                raise RuntimeError(f"http_{resp.status}")
            # aiohttp's StreamReader caps a single `read(n)` at its internal
            # `limit` (64 KiB by default). A one-shot `read(MAX+1)` therefore
            # silently returns a truncated body for any feed larger than 64 KiB
            # instead of flagging it — entries past the cap are then never
            # inserted and no error is raised. Read in bounded chunks and reject
            # only once the cap is exceeded.
            body = bytearray()
            while True:
                chunk = await resp.content.read(65536)
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > MAX_UPSTREAM_BYTES:
                    raise RuntimeError("body_too_large")
            return bytes(body).decode("utf-8", errors="replace")


def _configured_feeds() -> list[tuple[str, str]]:
    """Return ``[(feed_name, url), ...]`` for each configured feed."""
    from app.config import get_settings

    settings = get_settings()
    feeds: list[tuple[str, str]] = []
    if settings.upstream_blacklist_urls:
        feeds.append(("urls", settings.upstream_blacklist_urls))
    if settings.upstream_blacklist_ips:
        feeds.append(("ips", settings.upstream_blacklist_ips))
    return feeds


async def sync_upstream_blacklist(allow_empty_prune: bool = False) -> dict:
    """Fetch the configured upstream feeds and merge them into
    ``blacklist_entries``.

    Never raises — every failure is returned as
    ``{"ok": False, "reason": ...}``. No configured feed means disabled.

    Rows with ``source='upstream'`` that are missing from a feed's fetched
    set are pruned per-feed (manual/finding rows are never touched). An
    empty parsed set for a feed skips that feed's prune unless
    ``allow_empty_prune`` is set — a transient empty/comment-only/all-invalid
    file must not wipe enforcement.
    """
    try:
        async with _SYNC_LOCK:
            result = await _do_sync(allow_empty_prune)
        _LAST_SYNC["last_error"] = None
        return result
    except Exception as e:
        reason = str(e) or type(e).__name__
        log.warning("upstream blacklist sync failed: %s", reason)
        _LAST_SYNC["last_error"] = reason
        return {"ok": False, "reason": reason}


async def _prune_kind(db, kind: str, keep: set[str]) -> list[str]:
    """Delete upstream rows of ``kind`` not in ``keep``; return stale values.

    Chunked DELETEs stay under SQLite's variable limit for very large feeds.
    Never touches manual/finding rows — the ``source='upstream'`` predicate
    scopes the deletion.
    """
    cursor = await db.execute(
        "SELECT value FROM blacklist_entries WHERE source='upstream' AND kind=?"
        " ORDER BY value",
        (kind,),
    )
    existing = [row[0] for row in await cursor.fetchall()]
    stale = sorted(v for v in existing if v not in keep)
    for i in range(0, len(stale), _DELETED_SAMPLE_CAP):
        chunk = stale[i:i + _DELETED_SAMPLE_CAP]
        placeholders = ",".join("?" for _ in chunk)
        await db.execute(
            "DELETE FROM blacklist_entries WHERE source='upstream' AND kind=?"
            f" AND value IN ({placeholders})",
            (kind, *chunk),
        )
    return stale


async def _do_sync(allow_empty_prune: bool = False) -> dict:
    from app.database import get_db
    from app.services.blacklist import normalize_blacklist_value
    from app.services.feeds import sync_regenerate

    feeds = _configured_feeds()
    if not feeds:
        return {"ok": False, "reason": "disabled"}

    added = 0
    skipped = 0
    errors: list[dict] = []
    fetched = 0
    touched: set[str] = set()
    seen: set[tuple[str, str]] = set()
    # (kind, value) pairs seen per feed, for the post-insert prune.
    feed_seen: dict[str, set[tuple[str, str]]] = {}

    db = await get_db()
    try:
        for feed_name, url in feeds:
            feed_added = 0
            feed_skipped = 0
            feed_errors = 0
            feed_seen_values: set[tuple[str, str]] = set()
            try:
                text = await _fetch_text(url)
            except Exception as e:
                # One dead feed must not starve the other: record the
                # per-feed error and continue. Successful feeds commit below.
                reason = str(e) or type(e).__name__
                log.warning("upstream blacklist feed %s fetch failed: %s", feed_name, reason)
                errors.append({"value": f"<{feed_name} feed>", "error": reason})
                _LAST_SYNC["feeds"][feed_name] = {
                    "last_added": 0,
                    "last_skipped": 0,
                    "last_errors": 1,
                    "last_error": reason,
                }
                continue
            lines = parse_upstream_body(text)
            fetched += len(lines)
            for raw in lines:
                try:
                    kind, value = normalize_blacklist_value(raw)
                except ValueError as e:
                    errors.append({"value": raw, "error": str(e)})
                    feed_errors += 1
                    continue
                key = (kind, value)
                if key in seen:
                    # Duplicate across feeds (or within this fetch) —
                    # report, don't re-insert.
                    skipped += 1
                    feed_skipped += 1
                    continue
                seen.add(key)
                feed_seen_values.add(key)
                cursor = await db.execute(
                    "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
                    " VALUES (?, ?, 'upstream')",
                    (kind, value),
                )
                if cursor.rowcount:
                    added += 1
                    feed_added += 1
                    touched.add(kind)
                else:
                    skipped += 1
                    feed_skipped += 1
            feed_seen[feed_name] = feed_seen_values
            _LAST_SYNC["feeds"][feed_name] = {
                "last_added": feed_added,
                "last_skipped": feed_skipped,
                "last_errors": feed_errors,
                "last_error": None,
            }
            log.info(
                "upstream blacklist feed %s sync: added=%d skipped=%d errors=%d fetched=%d",
                feed_name, feed_added, feed_skipped, feed_errors, len(lines),
            )

        # Prune: delete upstream rows of each kind that are missing from the
        # *union* of every successfully-fetched feed's set for that kind.
        #
        # A single feed must NOT prune a kind using only its own subset: when a
        # feed's content carries the *other* feed's kind (e.g. the URLs feed
        # lists IP literals, or both feeds list overlapping kinds), per-feed
        # pruning would delete the sibling feed's freshly-inserted rows — a
        # silent cross-feed data loss. We therefore compute one keep-set per
        # kind across all content feeds and prune each kind exactly once.
        # Manual/finding rows are never touched (source='upstream' predicate).
        feed_deleted = {name: 0 for name in _FEEDS}
        feed_deleted_sample: dict[str, list[str]] = {name: [] for name in _FEEDS}
        feed_deleted_truncated = {name: False for name in _FEEDS}
        feed_prune_skipped = {name: None for name in _FEEDS}
        deleted_kinds: set[str] = set()

        # Union of (kind, value) seen across every successfully-fetched feed,
        # plus the set of kinds whose only feed came back empty and must be
        # explicitly wiped (allow_empty_prune).
        keep_by_kind: dict[str, set[str]] = {}
        wipe_kinds: set[str] = set()
        kind_owner = {kind: feed for feed, kind in _FEED_KIND.items()}

        for feed_name, _url in feeds:
            s = feed_seen.get(feed_name, set())
            if not s:
                if allow_empty_prune:
                    # Explicit wipe of this feed's declared kind.
                    wipe_kinds.add(_FEED_KIND[feed_name])
                else:
                    # Empty parsed set (comments / invalid / blank, or a failed
                    # fetch): pruning would wipe all upstream enforcement for
                    # this kind, so skip the DELETE and keep existing rows.
                    feed_prune_skipped[feed_name] = "empty-feed"
                    log.warning(
                        "upstream blacklist sync: feed %s empty parsed set, skipping prune",
                        feed_name,
                    )
                continue
            for kind, value in s:
                keep_by_kind.setdefault(kind, set()).add(value)

        # One prune per kind, using the global keep-set (idempotent regardless
        # of how many feeds supplied that kind).
        for kind, keep in keep_by_kind.items():
            stale = await _prune_kind(db, kind, keep)
            if stale:
                owner = kind_owner.get(kind)
                if owner is not None:
                    feed_deleted[owner] += len(stale)
                    feed_deleted_sample[owner].extend(stale[:_DELETED_SAMPLE_CAP])
                deleted_kinds.add(kind)

        # Explicit wipe (allow_empty_prune) for feeds that came back empty.
        for kind in wipe_kinds:
            stale = await _prune_kind(db, kind, set())
            if stale:
                owner = kind_owner.get(kind)
                if owner is not None:
                    feed_deleted[owner] += len(stale)
                    feed_deleted_sample[owner].extend(stale[:_DELETED_SAMPLE_CAP])
                deleted_kinds.add(kind)

        deleted = sum(feed_deleted.values())
        deleted_sample: list[str] = []
        deleted_truncated = False
        for name in _FEEDS:
            sample = feed_deleted_sample[name]
            if len(sample) > _DELETED_SAMPLE_CAP:
                sample = sample[:_DELETED_SAMPLE_CAP]
                feed_deleted_sample[name] = sample
                feed_deleted_truncated[name] = True
            deleted_sample.extend(sample)
        if len(deleted_sample) > _DELETED_SAMPLE_CAP:
            deleted_sample = deleted_sample[:_DELETED_SAMPLE_CAP]
            deleted_truncated = True

        await db.commit()
        if touched or deleted_kinds:
            # Regenerate the affected feeds so the public .txt files match.
            await sync_regenerate(db, tuple(sorted(touched | deleted_kinds)))
    finally:
        await db.close()

    _LAST_SYNC.update(
        {
            "last_sync": datetime.now(UTC).isoformat(),
            "last_added": added,
            "last_skipped": skipped,
            "last_errors": len(errors),
            "last_deleted": deleted,
            "last_deleted_sample": deleted_sample,
        }
    )
    for name in _FEEDS:
        _LAST_SYNC["feeds"][name]["last_deleted"] = feed_deleted[name]
    log.info(
        "upstream blacklist sync: added=%d skipped=%d errors=%d fetched=%d"
        " deleted=%d",
        added, skipped, len(errors), fetched, deleted,
    )
    if errors:
        log.debug(
            "upstream blacklist sync error samples: %r",
            [str(e["value"])[:120] for e in errors[:3]],
        )
    result: dict = {
        "ok": True,
        "added": added,
        "skipped": skipped,
        "errors": errors,
        "fetched": fetched,
        "deleted": deleted,
        "deleted_sample": deleted_sample,
        "deleted_truncated": deleted_truncated,
        "feeds": {
            name: {
                "deleted": feed_deleted[name],
                "deleted_sample": feed_deleted_sample[name],
                "deleted_truncated": feed_deleted_truncated[name],
                **(
                    {"prune_skipped": feed_prune_skipped[name]}
                    if feed_prune_skipped[name] is not None
                    else {}
                ),
            }
            for name in _FEEDS
        },
    }
    return result


async def get_upstream_status() -> dict:
    """Current upstream sync status for the admin API."""
    from app.config import get_settings
    from app.database import get_db

    settings = get_settings()
    urls_configured = bool(settings.upstream_blacklist_urls)
    ips_configured = bool(settings.upstream_blacklist_ips)
    enabled = urls_configured or ips_configured
    upstream_count = 0
    try:
        db = await get_db()
        try:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM blacklist_entries WHERE source = 'upstream'"
            )
            row = await cursor.fetchone()
            upstream_count = row[0] if row else 0
        finally:
            await db.close()
    except Exception as e:
        log.warning("upstream status count failed: %s", e)
    # `url_configured` is kept as a back-compat alias of `urls_configured`.
    # `last_*` describe the last *successful* sync — failures leave them
    # untouched and surface via `last_error`.
    return {
        "enabled": enabled,
        "urls_configured": urls_configured,
        "ips_configured": ips_configured,
        "url_configured": urls_configured,
        "last_error": _LAST_SYNC["last_error"],
        "last_sync": _LAST_SYNC["last_sync"],
        "last_added": _LAST_SYNC["last_added"],
        "last_skipped": _LAST_SYNC["last_skipped"],
        "last_errors": _LAST_SYNC["last_errors"],
        "last_deleted": _LAST_SYNC["last_deleted"],
        "last_deleted_sample": _LAST_SYNC["last_deleted_sample"],
        "upstream_count": upstream_count,
        "feeds": {
            name: dict(_LAST_SYNC["feeds"][name]) for name in _FEEDS
        },
    }
