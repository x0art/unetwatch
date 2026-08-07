"""Persist an audit trail of ES queries and webhook deliveries.

Every monitor poll and every ad-hoc Query page run records one row in
``monitor_logs`` (best-effort — a storage failure must never break the
monitor itself). The Logs page reads these rows to show exactly which
query DSL was sent to Elasticsearch and what the webhook delivered.
"""
import json
from datetime import UTC, datetime

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
