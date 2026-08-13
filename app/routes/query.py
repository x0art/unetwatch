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
    exclude_blacklist: bool = Query(
        False, description="Exclude blacklisted hosts/IPs from the result set"
    ),
):
    """Run the block-pattern ES query for the Query page.

    `q` narrows the query inside Elasticsearch itself (instead of changing
    the time window); `exclude_whitelist` drops whitelisted matches so fewer
    documents come back; `exclude_blacklist` drops rows whose host or client
    IP is on the blacklist. Returns matching documents (table), aggregates
    (charts) and a client_ip → base_url flow. Every run is recorded in the
    Logs page.
    """
    from app.services.monitor import run_query as run_query_service

    return await run_query_service(
        minutes,
        search=q or None,
        exclude_whitelist=exclude_whitelist,
        exclude_blacklist=exclude_blacklist,
    )


@router.get("/client")
async def client_breakdown_live(
    ip: str = Query(..., min_length=1, max_length=64),
    minutes: int = Query(60, ge=1, le=20160),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(12, ge=1, le=50),
):
    """Per-client URL breakdown aggregated from live ES.

    Same response shape as the persisted-findings breakdown endpoint
    (``source="es"``), for the Traffic page drill-down radial. ES failures
    degrade gracefully (``es_online: False``, empty urls).
    """
    from app.services.monitor import run_client_query

    return await run_client_query(ip, minutes=minutes, search=search or None, limit=limit)
