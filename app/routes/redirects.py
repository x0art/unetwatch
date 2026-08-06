from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_db_conn
from app.models import RedirectCheckRequest, RedirectTrackCreate
from app.services.redirects import check_all, is_valid_url

router = APIRouter(prefix="/api/redirects", tags=["redirects"])

# Derived per-row count of distinct targets a URL has ever pointed at.
_HISTORY_COUNT_SQL = (
    "(SELECT COUNT(*) FROM redirect_edges e WHERE e.source_url = t.url) AS history_count"
)


@router.get("/")
async def list_tracked_urls(
    db=Depends(get_db_conn),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("id", pattern="^(id|url|source|status|last_checked_at)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    where = []
    params: list = []
    if search:
        where.append("t.url LIKE ?")
        params.append(f"%{search}%")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    count_cursor = await db.execute(
        f"SELECT COUNT(*) AS total FROM tracked_urls t {clause}", params
    )
    total = (await count_cursor.fetchone())["total"]

    cursor = await db.execute(
        f"SELECT t.*, {_HISTORY_COUNT_SQL} FROM tracked_urls t {clause}"
        f" ORDER BY t.{sort_by} {sort_order.upper()} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return {"items": [dict(r) for r in rows], "total": total}


@router.post("/", status_code=201)
async def add_tracked_url(payload: RedirectTrackCreate, db=Depends(get_db_conn)):
    url = payload.url.strip()
    if not is_valid_url(url):
        raise HTTPException(
            400, "url must start with http:// or https:// and contain no spaces"
        )
    try:
        cursor = await db.execute(
            "INSERT INTO tracked_urls (url, source) VALUES (?, ?)",
            (url, payload.source),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, f"URL already tracked: {url}")
        raise HTTPException(500, str(e))
    pid = cursor.lastrowid
    cursor = await db.execute(
        f"SELECT t.*, {_HISTORY_COUNT_SQL} FROM tracked_urls t WHERE t.id = ?",
        (pid,),
    )
    return dict(await cursor.fetchone())


@router.delete("/{tracked_id}", status_code=204)
async def delete_tracked_url(tracked_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("DELETE FROM tracked_urls WHERE id = ?", (tracked_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Tracked URL not found")
    return None


@router.post("/check")
async def run_redirect_check(
    payload: RedirectCheckRequest | None = None,
    db=Depends(get_db_conn),
):
    url = payload.url.strip() if payload and payload.url else None
    if url is not None:
        cursor = await db.execute("SELECT id FROM tracked_urls WHERE url = ?", (url,))
        if not await cursor.fetchone():
            raise HTTPException(404, "URL is not being tracked")
    return await check_all(url)


@router.get("/graph")
async def redirect_graph(db=Depends(get_db_conn)):
    cursor = await db.execute(f"SELECT t.*, {_HISTORY_COUNT_SQL} FROM tracked_urls t")
    rows = await cursor.fetchall()
    nodes = [
        {
            "id": r["url"],
            "label": r["url"],
            "status": r["status"],
            "final_url": r["final_url"],
            "history_count": r["history_count"],
        }
        for r in rows
    ]
    edge_cursor = await db.execute(
        "SELECT source_url, target_url, http_status, active FROM redirect_edges"
    )
    links = [
        {
            "source": e["source_url"],
            "target": e["target_url"],
            "http_status": e["http_status"],
            "active": bool(e["active"]),
        }
        for e in await edge_cursor.fetchall()
    ]
    return {"nodes": nodes, "links": links}


@router.get("/{tracked_id}/history")
async def url_history(tracked_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT * FROM tracked_urls WHERE id = ?", (tracked_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Tracked URL not found")
    edge_cursor = await db.execute(
        "SELECT target_url, http_status, first_seen_at, last_seen_at, active"
        " FROM redirect_edges WHERE source_url = ? ORDER BY last_seen_at DESC",
        (row["url"],),
    )
    edges = await edge_cursor.fetchall()
    return {
        "url": row["url"],
        "status": row["status"],
        "edges": [
            {
                "target_url": e["target_url"],
                "http_status": e["http_status"],
                "first_seen_at": e["first_seen_at"],
                "last_seen_at": e["last_seen_at"],
                "active": bool(e["active"]),
            }
            for e in edges
        ],
    }
