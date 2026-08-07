from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/query", tags=["query"])


@router.get("/run")
async def run_query(minutes: int = Query(60, ge=1, le=1440)):
    """Run the block-pattern ES query for the Query page.

    Returns matching documents (table), aggregates (charts) and a
    client_ip → base_url flow. Every run is recorded in the Logs page.
    """
    from app.services.monitor import run_query as run_query_service

    return await run_query_service(minutes)
