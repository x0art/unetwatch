from fastapi import APIRouter, Depends

from app.database import get_db_conn

router = APIRouter(prefix="/api/monitor", tags=["monitor"])


@router.get("/status")
async def monitor_status(db=Depends(get_db_conn)):
    cursor = await db.execute(
        "SELECT pattern_type, COUNT(*) as count FROM url_patterns GROUP BY pattern_type"
    )
    rows = await cursor.fetchall()
    counts = {r["pattern_type"]: r["count"] for r in rows}

    return {
        "status": "active",
        "block_patterns": counts.get("block", 0),
        "whitelist_patterns": counts.get("whitelist", 0),
        "poll_interval_minutes": 10,
    }


@router.post("/run")
async def trigger_manual_run():
    from app.services.monitor import fetch_logs

    await fetch_logs()
    return {"status": "run_complete"}
