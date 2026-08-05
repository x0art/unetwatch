from fastapi import APIRouter, Depends, Query

from app.database import get_db_conn

router = APIRouter(prefix="/api/findings", tags=["findings"])


@router.get("/")
async def list_findings(
    db=Depends(get_db_conn),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List persisted findings, newest first, with total count for pagination."""
    where = []
    params: list = []
    if search:
        where.append("(client_ip LIKE ? OR url LIKE ? OR base_url LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

    clause = f"WHERE {' AND '.join(where)}" if where else ""

    count_cursor = await db.execute(
        f"SELECT COUNT(*) as total FROM findings {clause}", params
    )
    total = (await count_cursor.fetchone())["total"]

    cursor = await db.execute(
        f"SELECT * FROM findings {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return {"items": [dict(r) for r in rows], "total": total}
