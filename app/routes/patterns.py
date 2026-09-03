
import fnmatch
import re
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.database import get_db_conn
from app.models import (
    PatternBulkImport,
    PatternSimulateRequest,
    UrlPatternCreate,
    UrlPatternResponse,
    UrlPatternUpdate,
)

router = APIRouter(prefix="/api/patterns", tags=["patterns"])


# ── Live Kibana pattern simulation ─────────────────────────────────────────

# UI labels → minutes for the simulation window. "24h" is the spec default;
# unknown labels fall back to 1440 (24h).
_TIME_RANGES: dict[str, int] = {
    "1h": 60,
    "24h": 1440,
    "7d": 10080,
    "30d": 43200,
}


def _time_range_minutes(time_range: str) -> int:
    return _TIME_RANGES.get(time_range.strip().lower(), 1440)


def _matches(pattern: str, url: str) -> bool:
    """True when a URL matches a pattern.

    Wildcard patterns (``*``/``?``) match via ``fnmatch``; anything that is
    (or contains) a regex falls back to ``re.search``. Invalid regexes never
    raise — the caller treats them as non-matching.
    """
    if not pattern:
        return False
    if fnmatch.fnmatch(url, pattern):
        return True
    try:
        return re.search(pattern, url) is not None
    except re.error:
        return False


def _normalize_timestamp(ts, fallback: str) -> str:
    """Best-effort ISO timestamp normalization for preview rows."""
    if not ts:
        return fallback
    try:
        return datetime.fromisoformat(str(ts)).isoformat()
    except (TypeError, ValueError):
        return str(ts)


async def _fetch_recent_logs(db, minutes: int, limit: int = 1000) -> list[dict]:
    """Fetch recent proxy-log rows from ES, falling back to persisted findings.

    Elasticsearch is the source of truth for live traffic (full URL field,
    action, duration, host). When ES is unreachable (or the index is empty)
    the simulation degrades to the SQLite ``findings`` table within the same
    time window — a best-effort sandbox that still returns the contract shape
    (``{matchCount, preview}``) instead of 500ing.
    """
    settings = get_settings()
    if not settings.elastic_host:
        return []

    from app.services.es_client import es_client

    fields = [
        "@timestamp",
        "client_ip",
        "server_ip",
        "url",
        "base_url",
        "duration_seconds",
        "action",
    ]
    body: dict = {
        "size": limit,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "_source": fields,
    }
    filters: list[dict] = []
    if minutes > 0:
        filters.append({"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}})
    body["query"] = {"bool": {"filter": filters}} if filters else {"match_all": {}}

    try:
        async with es_client(settings, timeout=15) as es:
            res = await es.search(index=settings.elastic_index, body=body)
    except Exception:
        return []

    hits = res.get("hits", {}).get("hits", [])
    if not hits:
        return []

    now = datetime.now(UTC).isoformat()
    return [
        {
            "@timestamp": _normalize_timestamp(h.get("_source", {}).get("@timestamp"), now),
            "client_ip": str(h.get("_source", {}).get("client_ip") or ""),
            "server_ip": str(h.get("_source", {}).get("server_ip") or ""),
            "url": str(h.get("_source", {}).get("url") or ""),
            "base_url": str(h.get("_source", {}).get("base_url") or ""),
            "duration_seconds": h.get("_source", {}).get("duration_seconds"),
            "action": str(h.get("_source", {}).get("action") or ""),
        }
        for h in hits
    ]


async def _fetch_recent_sqlite_logs(db, minutes: int, limit: int = 1000) -> list[dict]:
    """Fallback: persisted findings within the window, newest first."""
    now = datetime.now(UTC)
    if minutes > 0:
        cutoff = (now - timedelta(minutes=minutes)).isoformat()
        cursor = await db.execute(
            "SELECT client_ip, server_ip, url, base_url, log_timestamp"
            " FROM findings WHERE log_timestamp >= ? ORDER BY log_timestamp DESC LIMIT ?",
            (cutoff, limit),
        )
    else:
        cursor = await db.execute(
            "SELECT client_ip, server_ip, url, base_url, log_timestamp"
            " FROM findings ORDER BY log_timestamp DESC LIMIT ?",
            (limit,),
        )
    rows = await cursor.fetchall()
    return [
        {
            "@timestamp": _normalize_timestamp(r["log_timestamp"], now.isoformat()),
            "client_ip": str(r["client_ip"] or ""),
            "server_ip": str(r["server_ip"] or ""),
            "url": str(r["url"] or ""),
            "base_url": str(r["base_url"] or ""),
            "duration_seconds": None,
            "action": "",
        }
        for r in rows
    ]


@router.post("/simulate")
async def simulate_pattern(body: PatternSimulateRequest, db=Depends(get_db_conn)):
    """Live Kibana-style pattern sandbox (spec §3.3).

    Body: ``{pattern, timeRange}``. ``pattern`` supports wildcards (``*``/``?``)
    plus regex syntax; ``timeRange`` is a UI label (``"1h"``/``"24h"``/``"7d"``/
    ``"30d"``, default ``"24h"``). Fetches the last window of logs (ES first,
    SQLite findings fallback) capped at 1000, matches each URL with
    ``fnmatch`` OR ``re.search``, and returns ``{matchCount, preview}`` with at
    most 10 preview rows.
    """
    minutes = _time_range_minutes(body.timeRange)
    pattern = body.pattern.strip()
    if not pattern:
        raise HTTPException(400, "pattern must not be empty")

    logs = await _fetch_recent_logs(db, minutes)
    if not logs:
        logs = await _fetch_recent_sqlite_logs(db, minutes)

    matched = [log for log in logs if _matches(pattern, log["url"])]
    preview = matched[:10]
    return {"matchCount": len(matched), "preview": preview}


# ── Block/Whitelist patterns CRUD ──────────────────────────────────────────

@router.get("/", response_model=list[UrlPatternResponse])
async def list_patterns(
    db=Depends(get_db_conn),
    pattern_type: str | None = Query(None, pattern="^(block|whitelist)$"),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("id", pattern="^(id|pattern|pattern_type|created_at)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    where = []
    params: list = []
    if pattern_type:
        where.append("pattern_type = ?")
        params.append(pattern_type)
    if search:
        where.append("pattern LIKE ?")
        params.append(f"%{search}%")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    order = f"ORDER BY {sort_by} {sort_order.upper()}"
    cursor = await db.execute(
        f"SELECT * FROM url_patterns {clause} {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/{pattern_id}", response_model=UrlPatternResponse)
async def get_pattern(pattern_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pattern_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Pattern not found")
    return dict(row)


@router.post("/", response_model=UrlPatternResponse, status_code=201)
async def create_pattern(data: UrlPatternCreate, db=Depends(get_db_conn)):
    try:
        cursor = await db.execute(
            "INSERT INTO url_patterns (pattern, pattern_type) VALUES (?, ?)",
            (data.pattern, data.pattern_type),
        )
        await db.commit()
        pid = cursor.lastrowid
        cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pid,))
        return dict(await cursor.fetchone())
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, f"Pattern '{data.pattern}' already exists")
        raise HTTPException(500, str(e))


@router.put("/{pattern_id}", response_model=UrlPatternResponse)
async def update_pattern(pattern_id: int, data: UrlPatternUpdate, db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pattern_id,))
    if not await cursor.fetchone():
        raise HTTPException(404, "Pattern not found")

    updates = {}
    if data.pattern is not None:
        updates["pattern"] = data.pattern
    if data.pattern_type is not None:
        updates["pattern_type"] = data.pattern_type

    if not updates:
        raise HTTPException(400, "No fields to update")

    # Always refresh updated_at; set_clause has zero user-controlled identifiers.
    updates["updated_at"] = "CURRENT_TIMESTAMP"
    set_clause = ", ".join(
        f"{k} = {v}" if k == "updated_at" else f"{k} = ?"
        for k, v in updates.items()
    )
    values = [v for k, v in updates.items() if k != "updated_at"]

    try:
        await db.execute(
            f"UPDATE url_patterns SET {set_clause} WHERE id = ?",
            (*values, pattern_id),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, f"Pattern '{data.pattern}' already exists")
        raise HTTPException(500, str(e))

    cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pattern_id,))
    return dict(await cursor.fetchone())


@router.delete("/{pattern_id}", status_code=204)
async def delete_pattern(pattern_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("DELETE FROM url_patterns WHERE id = ?", (pattern_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Pattern not found")


# ── Bulk import ────────────────────────────────────────────────────────────

@router.post("/bulk", response_model=list[UrlPatternResponse], status_code=201)
async def bulk_import_patterns(data: PatternBulkImport, db=Depends(get_db_conn)):
    results = []
    for p in data.patterns:
        try:
            cursor = await db.execute(
                "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type) VALUES (?, ?)",
                (p, data.pattern_type),
            )
            await db.commit()
            pid = cursor.lastrowid
            if pid:
                cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pid,))
                results.append(dict(await cursor.fetchone()))
        except Exception:
            continue
    return results


# ── Stats ──────────────────────────────────────────────────────────────────

@router.get("/stats/counts")
async def pattern_counts(db=Depends(get_db_conn)):
    cursor = await db.execute(
        "SELECT pattern_type, COUNT(*) as count FROM url_patterns GROUP BY pattern_type"
    )
    rows = await cursor.fetchall()
    return {r["pattern_type"]: r["count"] for r in rows}
