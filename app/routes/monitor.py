from fastapi import APIRouter, Depends, Query

from app.config import get_settings
from app.database import get_db_conn

router = APIRouter(prefix="/api/monitor", tags=["monitor"])


@router.get("/status")
async def monitor_status(db=Depends(get_db_conn)):
    cursor = await db.execute(
        "SELECT pattern_type, COUNT(*) as count FROM url_patterns GROUP BY pattern_type"
    )
    rows = await cursor.fetchall()
    counts = {r["pattern_type"]: r["count"] for r in rows}

    count_cursor = await db.execute("SELECT COUNT(*) as total FROM findings")
    findings_total = (await count_cursor.fetchone())["total"]

    from app.services.monitor import is_es_online

    online = await is_es_online()

    return {
        "status": "active",
        "block_patterns": counts.get("block", 0),
        "whitelist_patterns": counts.get("whitelist", 0),
        "poll_interval_minutes": get_settings().poll_interval_minutes,
        "es_online": online,
        "findings_count": findings_total,
    }


@router.post("/run")
async def trigger_manual_run(minutes: int = Query(1, ge=1, le=10)):
    from app.services.monitor import fetch_logs

    await fetch_logs(minutes=minutes)
    return {"status": "run_complete", "minutes": minutes}


@router.get("/metrics")
async def monitor_metrics(minutes: int = Query(60, ge=1, le=1440)):
    from app.services.monitor import fetch_metrics

    return await fetch_metrics(minutes)
