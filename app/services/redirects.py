"""Redirect tracking service: hop-by-hop HTTP checks of tracked URLs.

Follows redirect chains manually (aiohttp with ``allow_redirects=False``),
records every hop as a ``redirect_edges`` row, auto-adds hop targets to
``tracked_urls`` so whole chains are monitored transitively, and marks
edges the source no longer points at as inactive (history is kept).
"""
from datetime import UTC, datetime
from urllib.parse import urljoin

import aiohttp

from app.config import get_settings


def is_valid_url(value: str) -> bool:
    """A tracked URL must be an absolute http(s) URL with no whitespace."""
    v = value.strip()
    return v.startswith(("http://", "https://")) and " " not in v


async def _request_once(
    session: aiohttp.ClientSession, method: str, url: str, timeout: float
):
    """Single request with redirects disabled; returns (status, Location)."""
    async with session.request(
        method,
        url,
        allow_redirects=False,
        timeout=timeout,
        headers={"User-Agent": "elk-monitor/0.1"},
    ) as resp:
        return resp.status, resp.headers.get("Location")


async def check_url(session: aiohttp.ClientSession, url: str):
    """Follow redirects hop-by-hop for one URL.

    Returns ``(hops, final_status, final_url, error)`` where ``hops`` is a
    list of ``(source_url, target_url, http_status)`` tuples. HEAD first,
    GET fallback when the server rejects HEAD (405/501).
    """
    settings = get_settings()
    max_hops = settings.redirect_max_hops
    timeout = settings.redirect_timeout_seconds

    hops: list[tuple[str, str, int]] = []
    current = url
    seen: set[str] = set()

    for _ in range(max_hops):
        if current in seen:
            return hops, 0, current, "redirect loop detected"
        seen.add(current)

        try:
            status, location = await _request_once(session, "HEAD", current, timeout)
        except Exception as e:
            return hops, 0, current, f"request failed: {e}"

        if status in (405, 501):
            # Server doesn't support HEAD; retry once with GET.
            try:
                status, location = await _request_once(session, "GET", current, timeout)
            except Exception as e:
                return hops, 0, current, f"request failed: {e}"

        if status in (301, 302, 303, 307, 308) and location:
            target = urljoin(current, location)
            if not target.startswith(("http://", "https://")):
                return hops, status, current, "invalid redirect location"
            if target == current:
                return hops, status, current, "redirect loop detected"
            hops.append((current, target, status))
            current = target
            continue

        return hops, status, current, None

    return hops, 0, current, "max hops exceeded"


def _classify_status(hops: list, final_status: int, error: str | None) -> str:
    if error:
        return "error"
    if hops:
        return "redirect"
    if final_status and 300 <= final_status < 400:
        # A 3xx that resolved to no hop (e.g. redirect without Location)
        # is still a redirect, not a healthy final response.
        return "redirect"
    if final_status and 200 <= final_status < 400:
        return "ok"
    return "error"


async def _check_one(db, session: aiohttp.ClientSession, row) -> dict | None:
    """Check a single tracked row, persisting edges + auto-added targets."""
    url = row["url"]
    hops, final_status, final_url, error = await check_url(session, url)
    status = _classify_status(hops, final_status, error)
    now = datetime.now(UTC).isoformat()

    await db.execute(
        "UPDATE tracked_urls SET status = ?, http_status = ?, final_url = ?,"
        " last_checked_at = ?, last_error = ? WHERE id = ?",
        (status, final_status or None, final_url, now, error, row["id"]),
    )

    for source, target, hstatus in hops:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, ?, ?, ?, 1)"
            " ON CONFLICT (source_url, target_url) DO UPDATE SET"
            " last_seen_at = excluded.last_seen_at,"
            " http_status = excluded.http_status, active = 1",
            (source, target, hstatus, now, now),
        )
        await db.execute(
            "INSERT OR IGNORE INTO tracked_urls (url, source) VALUES (?, 'auto')",
            (target,),
        )

    if hops:
        current_targets = [t for _, t, _ in hops]
        placeholders = ", ".join("?" * len(current_targets))
        await db.execute(
            f"UPDATE redirect_edges SET active = 0"
            f" WHERE source_url = ? AND active = 1"
            f" AND target_url NOT IN ({placeholders})",
            (url, *current_targets),
        )
    else:
        await db.execute(
            "UPDATE redirect_edges SET active = 0 WHERE source_url = ? AND active = 1",
            (url,),
        )

    await db.commit()
    return {
        "url": url,
        "status": status,
        "http_status": final_status,
        "final_url": final_url,
        "error": error,
    }


async def check_all(url: str | None = None) -> dict:
    """Re-check every tracked URL (or a single one). Used by scheduler + /check."""
    from app.database import get_db

    db = await get_db()
    try:
        if url:
            cursor = await db.execute("SELECT * FROM tracked_urls WHERE url = ?", (url,))
        else:
            cursor = await db.execute("SELECT * FROM tracked_urls")
        rows = await cursor.fetchall()

        updated: list[dict] = []
        async with aiohttp.ClientSession() as session:
            for row in rows:
                result = await _check_one(db, session, row)
                if result:
                    updated.append(result)
        return {"checked": len(rows), "updated": updated}
    finally:
        await db.close()
