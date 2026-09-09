import asyncio
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from app.database import get_db_conn
from app.models import RedirectCheckRequest, RedirectTrackCreate
from app.services.redirects import blacklist_tracked_hosts, check_all, is_valid_url

router = APIRouter(prefix="/api/redirects", tags=["redirects"])

# Derived per-row count of distinct targets a URL has ever pointed at.
_HISTORY_COUNT_SQL = (
    "(SELECT COUNT(*) FROM redirect_edges e WHERE e.source_url = t.url) AS history_count"
)

# In-process store of background redirect check runs, polled by the UI so the
# heavy HTTP work never blocks the request that kicked it off.
_RUNS: dict[str, dict] = {}

# Strong references to the asyncio tasks so a running check is never garbage
# collected mid-flight; the callback removes the reference on completion.
_TASKS: set[asyncio.Task] = set()


async def _run_check(run_id: str, urls: list[str] | None) -> None:
    """Run `check_all` in the background and persist the outcome on the run."""
    _RUNS[run_id]["status"] = "running"
    _RUNS[run_id]["started_at"] = datetime.now(UTC).isoformat()
    try:
        result = await check_all(urls)
        _RUNS[run_id]["checked"] = result["checked"]
        _RUNS[run_id]["updated"] = result["updated"]
        _RUNS[run_id]["status"] = "done"
    except Exception as e:  # noqa: BLE001 - a failed run must not kill the worker
        _RUNS[run_id]["status"] = "error"
        _RUNS[run_id]["error"] = str(e)
    finally:
        _RUNS[run_id]["finished_at"] = datetime.now(UTC).isoformat()


def _spawn_check(run_id: str, urls: list[str] | None) -> None:
    """Fire `_run_check` on the loop, keeping a strong ref until it finishes."""
    # Prune finished runs (keep the latest 20) so _RUNS never grows unbounded.
    finished = [rid for rid, r in _RUNS.items() if r["status"] in ("done", "error")]
    for rid in sorted(finished)[:-20]:
        _RUNS.pop(rid, None)
    task = asyncio.create_task(_run_check(run_id, urls))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


async def _validate_tracked(db, urls: list[str] | None) -> None:
    """Raises 404 for any requested URL that is not being tracked."""
    if not urls:
        return
    placeholders = ", ".join("?" * len(urls))
    cursor = await db.execute(
        f"SELECT url FROM tracked_urls WHERE url IN ({placeholders})", urls
    )
    known = {r[0] for r in await cursor.fetchall()}
    missing = [u for u in urls if u not in known]
    if missing:
        raise HTTPException(404, f"URL is not being tracked: {missing[0]}")


@router.get("/")
async def list_tracked_urls(
    db=Depends(get_db_conn),
    search: str | None = Query(None, max_length=200),
    # Cap matches list_patterns (5000): the Findings page loads the full
    # tracked-URL index with limit=5000 to badge "Tracked" rows.
    limit: int = Query(50, ge=1, le=5000),
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
    already_tracked = False
    try:
        cursor = await db.execute(
            "INSERT INTO tracked_urls (url, source) VALUES (?, ?)",
            (url, payload.source),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            already_tracked = True
        else:
            raise HTTPException(500, str(e))
    # Tracking a URL implies its host belongs on the block feed — every
    # tracked host (new or pre-existing) is ensured on the blacklist.
    await blacklist_tracked_hosts(db, [url])
    if already_tracked:
        raise HTTPException(409, f"URL already tracked: {url}")
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
    background: bool = Query(False, description="Run in the background and return 202"),
    db=Depends(get_db_conn),
):
    """Re-check all tracked URLs, or a specific set via ``{url}`` / ``{urls}``.

    The heavy per-URL HTTP work in ``check_all`` blocks the request that runs
    it, so the UI opts into ``background=true``: the route validates, spawns an
    asyncio task, returns ``202`` immediately, and the frontend polls
    ``GET /api/redirects/check/status`` for completion. The synchronous path
    (default) is kept for the scheduler and small inline checks.
    """
    urls: list[str] | None = None
    if payload:
        if payload.urls is not None:
            urls = [u.strip() for u in payload.urls if u.strip()]
        elif payload.url:
            urls = [payload.url.strip()]

    await _validate_tracked(db, urls)

    if background:
        run_id = uuid.uuid4().hex
        _RUNS[run_id] = {
            "run_id": run_id,
            "status": "queued",
            "requested": datetime.now(UTC).isoformat(),
            "started_at": None,
            "finished_at": None,
            "checked": 0,
            "updated": [],
            "error": None,
        }
        # Fire the heavy check without awaiting it; it owns its own DB session.
        _spawn_check(run_id, urls)
        return JSONResponse(status_code=202, content={"accepted": True, "check_id": run_id})

    return await check_all(urls)


@router.get("/check/status")
async def redirect_check_status(check_id: str = Query(...)):
    """Poll the progress of a background redirect check run."""
    run = _RUNS.get(check_id)
    if not run:
        raise HTTPException(404, "Unknown check run")
    return run


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
