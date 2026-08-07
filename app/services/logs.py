"""Persist an audit trail of ES queries and webhook deliveries.

Every monitor poll and every ad-hoc Query page run records one row in
``monitor_logs`` (best-effort — a storage failure must never break the
monitor itself). The Logs page reads these rows to show exactly which
query DSL was sent to Elasticsearch and what the webhook delivered.
"""
import json
from datetime import UTC, datetime, timedelta

from app.config import get_settings


async def write_log(entry: dict) -> None:
    """Insert a monitor log row. ``entry`` keys match the table columns."""
    from app.database import get_db

    db = await get_db()
    try:
        query_json = None
        if entry.get("es_query") is not None:
            try:
                query_json = json.dumps(entry["es_query"])
            except (TypeError, ValueError):
                query_json = str(entry["es_query"])

        await db.execute(
            "INSERT INTO monitor_logs"
            " (kind, started_at, duration_ms, minutes, es_online, matches, filtered,"
            "  stored, es_query, webhook_url, webhook_status, webhook_error, error)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                entry.get("kind", "poll"),
                entry.get("started_at") or datetime.now(UTC).isoformat(),
                int(entry.get("duration_ms") or 0),
                entry.get("minutes"),
                1 if entry.get("es_online", True) else 0,
                int(entry.get("matches") or 0),
                int(entry.get("filtered") or 0),
                int(entry.get("stored") or 0),
                query_json,
                entry.get("webhook_url"),
                entry.get("webhook_status"),
                entry.get("webhook_error"),
                entry.get("error"),
            ),
        )
        await db.commit()
    except Exception as e:
        print(f"[{datetime.now(UTC).isoformat()}][WARN] Failed to write monitor log: {e}")
    finally:
        await db.close()

    # Keep the audit trail bounded regardless of who writes (polls, query
    # runs, manual runs). Best-effort — a prune failure must never surface.
    await prune_logs()


async def prune_logs(
    retention_days: int | None = None, max_rows: int | None = None
) -> dict:
    """Delete old and surplus monitor log rows (best-effort).

    Two independent bounds, both optional: rows whose ``started_at`` is older
    than ``retention_days`` are removed, and anything beyond the newest
    ``max_rows`` rows is trimmed. Defaults come from settings
    (``LOG_RETENTION_DAYS`` / ``LOG_MAX_ROWS``). Returns the number of rows
    removed by each rule.
    """
    from app.database import get_db

    settings = get_settings()
    if retention_days is None:
        retention_days = settings.log_retention_days
    if max_rows is None:
        max_rows = settings.log_max_rows

    db = await get_db()
    try:
        pruned_by_age = 0
        if retention_days and retention_days > 0:
            cutoff = (datetime.now(UTC) - timedelta(days=retention_days)).isoformat()
            cursor = await db.execute(
                "DELETE FROM monitor_logs WHERE started_at < ?", (cutoff,)
            )
            pruned_by_age = cursor.rowcount or 0

        pruned_by_count = 0
        if max_rows and max_rows > 0:
            cursor = await db.execute(
                "DELETE FROM monitor_logs WHERE id NOT IN ("
                " SELECT id FROM monitor_logs"
                " ORDER BY started_at DESC, id DESC LIMIT ?)",
                (max_rows,),
            )
            pruned_by_count = cursor.rowcount or 0

        await db.commit()
        return {"by_age": pruned_by_age, "by_count": pruned_by_count}
    except Exception as e:
        print(f"[{datetime.now(UTC).isoformat()}][WARN] Failed to prune monitor logs: {e}")
        return {"by_age": 0, "by_count": 0}
    finally:
        await db.close()


def default_log(kind: str, minutes: int | None) -> dict:
    """Fresh log entry shared by poll and query run paths."""
    settings = get_settings()
    return {
        "kind": kind,
        "started_at": datetime.now(UTC).isoformat(),
        "minutes": minutes,
        "es_online": True,
        "matches": 0,
        "filtered": 0,
        "stored": 0,
        "es_query": None,
        "webhook_url": settings.webhook_url or None,
        "webhook_status": None,
        "webhook_error": None,
        "error": None,
    }
