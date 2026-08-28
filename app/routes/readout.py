from fastapi import APIRouter, Depends, Query

from app.config import verify_admin

router = APIRouter(prefix="/api/readout", tags=["readout"], dependencies=[Depends(verify_admin)])


@router.get("/ranked")
async def get_ranked(
    minutes: int = Query(1440, ge=1, le=20160),
    limit: int = Query(50, ge=1, le=200),
    source: str = Query("sqlite", pattern="^(sqlite|es|auto)$"),
    search: str | None = Query(None, max_length=200),
):
    """Ranked readout: clients ranked by risk ."""
    from app.services.readout import get_ranked

    return await get_ranked(minutes=minutes, limit=limit, source=source, search=search)


@router.get("/client/{client}")
async def get_client_timeline(
    client: str,
    minutes: int = Query(1440, ge=1, le=20160),
    limit: int = Query(200, ge=1, le=1000),
):
    """Per-client session drilldown: timeline from live ES + persisted breakdown ."""
    from app.services.readout import get_client_timeline

    return await get_client_timeline(client=client, minutes=minutes, limit=limit)


@router.get("/policy-classes")
async def get_policy_classes(
    minutes: int = Query(1440, ge=1, le=20160),
):
    """Policy class breakdown across all clients."""
    from app.services.readout import get_policy_classes

    return await get_policy_classes(minutes=minutes)


@router.get("/risk-explain")
async def get_risk_explain():
    """Read-only explain of risk scoring formula and weights."""
    from app.services.readout import get_risk_explain

    return await get_risk_explain()
