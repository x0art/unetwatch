from fastapi import APIRouter, Depends, HTTPException, Query

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
