"""Upstream jaillist sync: periodic fetch from a remote plain-text list.

Single feed configured via ``UPSTREAM_JAILLIST_URLS`` (one IP per line,
``#``/``;`` comment lines allowed). Empty value = disabled. Entries are
inserted with ``source='upstream'`` using ``INSERT OR IGNORE``, so
re-fetches are idempotent (dedup via the ``UNIQUE(value)`` constraint) and
manual/finding entries are never touched or deleted.

After any insert, the static jail feed is regenerated via
``sync_regenerate_jail`` so the public ``/api/jaillist/ips.txt`` feed
(file ``jail-ips.txt``) matches.
"""

import logging
import asyncio
from datetime import UTC, datetime

log = logging.getLogger("unetwatch")

from app.services.upstream_blacklist import (  # noqa: E402
    MAX_UPSTREAM_BYTES,
    UPSTREAM_USER_AGENT,
    _fetch_text,
    parse_upstream_body,
)

__all__ = [
    "MAX_UPSTREAM_BYTES",
    "UPSTREAM_USER_AGENT",
    "parse_upstream_body",
    "sync_upstream_jaillist",
    "get_upstream_status",
]

_LAST_SYNC: dict = {
    "last_sync": None,
    "last_added": 0,
    "last_skipped": 0,
    "last_errors": 0,
    "last_error": None,
    "last_deleted": 0,
    "last_deleted_sample": [],
}
# Serialises the whole sync critical section (fetch → insert → prune →
# commit → regenerate) so manual, scheduled, and boot syncs never interleave.
_SYNC_LOCK = asyncio.Lock()

# Max deleted values included in the `deleted_sample` (sync result) and
# `last_deleted_sample` (status). Also the chunk size for the prune
# DELETE, comfortably below SQLite's variable limit even for ~50k feeds.
_DELETED_SAMPLE_CAP = 100


async def sync_upstream_jaillist(allow_empty_prune: bool = False) -> dict:
    """Fetch the configured upstream jaillist and merge it into
    ``jaillist_entries``.

    Never raises — every failure is returned as
    ``{"ok": False, "reason": ...}``. No configured feed means disabled.

    Rows with ``source='upstream'`` that are missing from the fetched
    set are pruned (manual/finding rows are never touched). An empty
    parsed set skips the prune unless ``allow_empty_prune`` is set —
    a transient empty/comment-only/all-invalid file must not wipe
    enforcement.
    """
    try:
        async with _SYNC_LOCK:
            result = await _do_sync(allow_empty_prune)
        _LAST_SYNC["last_error"] = None
        return result
    except Exception as e:
        reason = str(e) or type(e).__name__
        log.warning("upstream jaillist sync failed: %s", reason)
        _LAST_SYNC["last_error"] = reason
        return {"ok": False, "reason": reason}


async def _do_sync(allow_empty_prune: bool = False) -> dict:
    from app.config import get_settings
    from app.database import get_db
    from app.services.feeds import sync_regenerate_jail
    from app.services.jaillist import normalize_jaillist_value

    url = get_settings().upstream_jaillist_urls
    if not url:
        return {"ok": False, "reason": "disabled"}

    added = 0
    skipped = 0
    errors: list[dict] = []
    fetched = 0
    touched = False
    seen: set[str] = set()

    db = await get_db()
    try:
        text = await _fetch_text(url)
        lines = parse_upstream_body(text)
        fetched = len(lines)
        for raw in lines:
            try:
                value = normalize_jaillist_value(raw)
            except ValueError as e:
                errors.append({"value": raw, "error": str(e)})
                continue
            if value in seen:
                # Duplicate within this fetch — report, don't re-insert.
                skipped += 1
                continue
            seen.add(value)
            cursor = await db.execute(
                "INSERT OR IGNORE INTO jaillist_entries (value, source)"
                " VALUES (?, 'upstream')",
                (value,),
            )
            if cursor.rowcount:
                added += 1
                touched = True
            else:
                skipped += 1
        deleted = 0
        deleted_sample: list[str] = []
        deleted_truncated = False
        prune_skipped: str | None = None
        if not seen and not allow_empty_prune:
            # Empty parsed set (comments / invalid / blank file): pruning
            # would wipe all upstream enforcement, so skip the DELETE and
            # keep existing rows.
            prune_skipped = "empty-feed"
            log.warning("upstream jaillist sync: empty parsed set, skipping prune")
        else:
            # Collect existing upstream values and diff against `seen`.
            cursor = await db.execute(
                "SELECT value FROM jaillist_entries WHERE source = 'upstream'"
                " ORDER BY value"
            )
            existing = [row[0] for row in await cursor.fetchall()]
            stale = sorted(v for v in existing if v not in seen)
            if stale:
                deleted = len(stale)
                deleted_sample = stale[:_DELETED_SAMPLE_CAP]
                deleted_truncated = deleted > _DELETED_SAMPLE_CAP
                # Chunked DELETE stays under SQLite's variable limit
                # (~50k-line feeds).
                for i in range(0, deleted, _DELETED_SAMPLE_CAP):
                    chunk = stale[i:i + _DELETED_SAMPLE_CAP]
                    placeholders = ",".join("?" for _ in chunk)
                    await db.execute(
                        "DELETE FROM jaillist_entries"
                        f" WHERE source = 'upstream' AND value IN"
                        f" ({placeholders})",
                        tuple(chunk),
                    )
        await db.commit()
        if touched or deleted:
            # Regenerate the jail feed so the public .txt matches.
            await sync_regenerate_jail(db)
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
    log.info(
        "upstream jaillist sync: added=%d skipped=%d errors=%d fetched=%d"
        " deleted=%d",
        added, skipped, len(errors), fetched, deleted,
    )
    if errors:
        log.debug(
            "upstream jaillist sync error samples: %r",
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
    }
    if prune_skipped is not None:
        result["prune_skipped"] = prune_skipped
    return result


async def get_upstream_status() -> dict:
    """Current upstream jaillist sync status for the admin API."""
    from app.config import get_settings
    from app.database import get_db

    settings = get_settings()
    urls_configured = bool(settings.upstream_jaillist_urls)
    upstream_count = 0
    try:
        db = await get_db()
        try:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM jaillist_entries WHERE source = 'upstream'"
            )
            row = await cursor.fetchone()
            upstream_count = row[0] if row else 0
        finally:
            await db.close()
    except Exception as e:
        log.warning("upstream jaillist status count failed: %s", e)
    # `last_*` describe the last *successful* sync — failures leave them
    # untouched and surface via `last_error`.
    return {
        "enabled": urls_configured,
        "urls_configured": urls_configured,
        "last_sync": _LAST_SYNC["last_sync"],
        "last_added": _LAST_SYNC["last_added"],
        "last_skipped": _LAST_SYNC["last_skipped"],
        "last_errors": _LAST_SYNC["last_errors"],
        "last_error": _LAST_SYNC["last_error"],
        "last_deleted": _LAST_SYNC["last_deleted"],
        "last_deleted_sample": _LAST_SYNC["last_deleted_sample"],
        "upstream_count": upstream_count,
    }
