from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/query", tags=["query"])


@router.get("/run")
async def run_query(
    minutes: int = Query(60, ge=1, le=20160),
    q: str | None = Query(
        None, max_length=200, description="ES substring filter (URL / client IP / server IP)"
    ),
    exclude_whitelist: bool = Query(
        False, description="Exclude whitelisted matches from the result set"
    ),
):
    """Run the block-pattern ES query for the Query page.

    `q` narrows the query inside Elasticsearch itself (instead of changing
    the time window); `exclude_whitelist` drops whitelisted matches so fewer
    documents come back. Returns matching documents (table), aggregates
    (charts) and a client_ip → base_url flow. Every run is recorded in the
    Logs page.
    """
    from app.services.monitor import run_query as run_query_service

    return await run_query_service(
        minutes, search=q or None, exclude_whitelist=exclude_whitelist
    )
