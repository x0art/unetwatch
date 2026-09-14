"""Upstream blacklist sync: periodic fetch from a remote plain-text list.

The upstream source is a GitHub raw gist URL (one host/IPv4 per line,
``#``/``;`` comment lines allowed) configured via ``UPSTREAM_BLACKLIST_URL``.
Entries are inserted with ``source='upstream'`` using ``INSERT OR IGNORE``,
so re-fetches are idempotent (dedup via the ``UNIQUE(kind, value)``
constraint) and manual/finding entries are never touched or deleted.

After any insert that touched a feed kind, the static feed files are
regenerated via ``sync_regenerate`` so the public ``.txt`` feeds match.
"""

import logging
from datetime import UTC, datetime

import aiohttp

log = logging.getLogger("unetwatch")

UPSTREAM_USER_AGENT = "uNetWatch-upstream-sync/1.0"
UPSTREAM_FETCH_TIMEOUT_SECONDS = 15
# Bound the upstream body: a compromised list serving gigabytes would otherwise
# be fully buffered into memory on every 5-min sync. 1 MiB ≈ ~50k lines, far
# above any sane host list.
MAX_UPSTREAM_BYTES = 1_048_576

_LAST_SYNC: dict = {
    "last_sync": None,
    "last_added": 0,
    "last_skipped": 0,
    "last_errors": 0,
    "last_error": None,
}


def parse_upstream_body(text: str) -> list[str]:
    """Split an upstream body into candidate lines.

    Lines are stripped; empties and lines starting with ``#`` or ``;``
    (comments) are dropped. Remaining lines are returned as-is — validity
    is decided later by ``normalize_blacklist_value`` during sync (invalid
    lines are counted as per-line errors, not crashes).
    """
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith(";"):
            continue
        out.append(stripped)
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
            body = await resp.content.read(MAX_UPSTREAM_BYTES + 1)
            if len(body) > MAX_UPSTREAM_BYTES:
                raise RuntimeError("body_too_large")
            return body.decode("utf-8", errors="replace")


async def sync_upstream_blacklist() -> dict:
    """Fetch the upstream list and merge it into ``blacklist_entries``.

    Never raises — every failure is returned as
    ``{"ok": False, "reason": ...}``. Empty configured URL means disabled.
    """
    try:
        result = await _do_sync()
        _LAST_SYNC["last_error"] = None
        return result
    except Exception as e:
        reason = str(e) or type(e).__name__
        log.warning("upstream blacklist sync failed: %s", reason)
        _LAST_SYNC["last_error"] = reason
        return {"ok": False, "reason": reason}


async def _do_sync() -> dict:
    from app.config import get_settings
    from app.database import get_db
    from app.services.blacklist import normalize_blacklist_value
    from app.services.feeds import sync_regenerate

    url = get_settings().upstream_blacklist_url
    if not url:
        return {"ok": False, "reason": "disabled"}

    text = await _fetch_text(url)
    lines = parse_upstream_body(text)

    added = 0
    skipped = 0
    errors: list[dict] = []
    touched: set[str] = set()
    seen: set[tuple[str, str]] = set()

    db = await get_db()
    try:
        for raw in lines:
            try:
                kind, value = normalize_blacklist_value(raw)
            except ValueError as e:
                errors.append({"value": raw, "error": str(e)})
                continue
            key = (kind, value)
            if key in seen:
                # Duplicate within this fetch — report, don't re-insert.
                skipped += 1
                continue
            seen.add(key)
            cursor = await db.execute(
                "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
                " VALUES (?, ?, 'upstream')",
                (kind, value),
            )
            if cursor.rowcount:
                added += 1
                touched.add(kind)
            else:
                skipped += 1
        await db.commit()
        if touched:
            # Regenerate the affected feeds so the public .txt files match.
            await sync_regenerate(db, tuple(sorted(touched)))
    finally:
        await db.close()

    _LAST_SYNC.update(
        {
            "last_sync": datetime.now(UTC).isoformat(),
            "last_added": added,
            "last_skipped": skipped,
            "last_errors": len(errors),
        }
    )
    return {
        "ok": True,
        "added": added,
        "skipped": skipped,
        "errors": errors,
        "fetched": len(lines),
    }


async def get_upstream_status() -> dict:
    """Current upstream sync status for the admin API."""
    from app.config import get_settings
    from app.database import get_db

    url = get_settings().upstream_blacklist_url
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
    # `url_configured` is kept as a back-compat alias of `enabled`
    # (both mean a URL is configured). `last_*` describe the last
    # *successful* sync — failures leave them untouched and surface via
    # `last_error`.
    return {
        "enabled": bool(url),
        "url_configured": bool(url),
        "last_error": _LAST_SYNC["last_error"],
        "last_sync": _LAST_SYNC["last_sync"],
        "last_added": _LAST_SYNC["last_added"],
        "last_skipped": _LAST_SYNC["last_skipped"],
        "last_errors": _LAST_SYNC["last_errors"],
        "upstream_count": upstream_count,
    }
