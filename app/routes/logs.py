import json

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.database import get_db_conn
from app.models import LogBulkDelete

router = APIRouter(prefix="/api/logs", tags=["logs"])

_SORTABLE = (
    "id",
    "kind",
    "started_at",
    "duration_ms",
    "minutes",
    "matches",
    "filtered",
    "stored",
    "webhook_status",
)


@router.get("/")
async def list_logs(
    db=Depends(get_db_conn),
    kind: str | None = Query(None, pattern="^(poll|query)$"),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("started_at", pattern="|".join(_SORTABLE)),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    where: list[str] = []
    params: list = []
    if kind:
        where.append("kind = ?")
        params.append(kind)
    if search:
        where.append(
            "(error LIKE ? OR webhook_error LIKE ? OR webhook_reason LIKE ?"
            " OR es_query LIKE ?)"
        )
        params.extend([f"%{search}%"] * 4)

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    count_cursor = await db.execute(
        f"SELECT COUNT(*) AS total FROM monitor_logs {clause}", params
    )
    total = (await count_cursor.fetchone())["total"]

    cursor = await db.execute(
        f"SELECT * FROM monitor_logs {clause}"
        f" ORDER BY {sort_by} {sort_order.upper()} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return {"items": [dict(r) for r in rows], "total": total}


@router.post("/bulk-delete")
async def bulk_delete_logs(payload: LogBulkDelete, db=Depends(get_db_conn)):
    if not payload.ids:
        return {"deleted": 0}
    placeholders = ", ".join("?" * len(payload.ids))
    cursor = await db.execute(
        f"DELETE FROM monitor_logs WHERE id IN ({placeholders})", payload.ids
    )
    await db.commit()
    return {"deleted": cursor.rowcount}


@router.delete("")
async def clear_logs(db=Depends(get_db_conn)):
    cursor = await db.execute("DELETE FROM monitor_logs")
    await db.commit()
    return {"deleted": cursor.rowcount}


@router.delete("/{log_id}", status_code=204)
async def delete_log(log_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("DELETE FROM monitor_logs WHERE id = ?", (log_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Log not found")
    return None


@router.post("/{log_id}/retry/{provider}")
async def retry_webhook(
    log_id: int,
    provider: str,
    db=Depends(get_db_conn),
):
    """Re-send a failed webhook for a specific provider.

    ``provider`` must be ``webhook`` (n8n) or ``msteams`` (MS Teams).
    The stored payload is re-posted to the same URL and the log row
    is updated with the new status.
    """
    if provider not in ("webhook", "msteams"):
        raise HTTPException(400, "provider must be 'webhook' or 'msteams'")

    cursor = await db.execute(
        "SELECT * FROM monitor_logs WHERE id = ?", (log_id,)
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Log not found")
    log_entry = dict(row)

    settings = get_settings()

    if provider == "webhook":
        webhook_url = log_entry.get("webhook_url") or settings.webhook_url
        payload_raw = log_entry.get("webhook_payload")
        if not webhook_url:
            raise HTTPException(400, "No webhook URL configured for this log entry")
        if not payload_raw:
            raise HTTPException(400, "No stored payload for n8n webhook retry")

        try:
            payload = json.loads(payload_raw)
        except (json.JSONDecodeError, TypeError):
            raise HTTPException(400, "Stored payload is corrupted")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                webhook_url, json=payload, timeout=15
            ) as resp:
                status = resp.status
                body = await resp.text()

        await db.execute(
            "UPDATE monitor_logs SET webhook_status = ?, webhook_error = ?"
            " WHERE id = ?",
            (status, None if 200 <= status < 300 else body, log_id),
        )
        await db.commit()
        return {"provider": "webhook", "status": status, "body": body}

    else:  # msteams
        webhook_url = settings.msteams_webhook_url
        payload_raw = log_entry.get("msteams_payload")
        if not webhook_url:
            raise HTTPException(400, "MS Teams webhook URL not configured")
        if not payload_raw:
            raise HTTPException(400, "No stored payload for MS Teams retry")

        try:
            payload = json.loads(payload_raw)
        except (json.JSONDecodeError, TypeError):
            raise HTTPException(400, "Stored MS Teams payload is corrupted")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                webhook_url, json=payload, timeout=15
            ) as resp:
                status = resp.status
                body = await resp.text()

        await db.execute(
            "UPDATE monitor_logs SET msteams_status = ?, msteams_error = ?"
            " WHERE id = ?",
            (status, None if 200 <= status < 300 else body, log_id),
        )
        await db.commit()
        return {"provider": "msteams", "status": status, "body": body}
