from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/query", tags=["query"])


async def _run_pipeline_query(
    db,
    *,
    minutes: int,
    search: str | None,
    kql: str | None,
) -> dict:
    """Task 12 pipeline: QueryBuilder + Normalizer + persisted Kibana FieldMap.

    Builds the ES ``_search`` body through ``QueryBuilder.build`` (globalSearch
    → multi_match over the mapped src/dest/url/domain fields, timeRange →
    mapped timestamp range, KQL → term clauses) and maps every hit through
    ``Normalizer.to_app_state`` using the field map persisted in System
    Settings (``load_field_map`` returns the spec defaults when nothing is
    saved, so custom index schemas work without code changes).

    Returns ``{window_minutes, es_online, total, items}`` where ``items`` are
    §5.2 NormalizedAppState rows. ES failures degrade gracefully
    (``es_online: False``, empty items) — the endpoint never 5xx.
    """
    from app.config import get_settings
    from app.routes.settings import load_field_map
    from app.services.es_client import es_client
    from app.services.normalizer import Normalizer
    from app.services.query_builder import QueryBuilder

    field_map = await load_field_map(db)
    filters: dict = {"size": 500}
    if minutes > 0:
        # minutes=0 is the all-time sentinel — omit the range clause entirely.
        filters["timeRange"] = f"{minutes}m"
    if search:
        filters["globalSearch"] = search
    if kql:
        filters["patternFilter"] = kql

    body = QueryBuilder.build(filters, field_map)
    settings = get_settings()
    result = {"window_minutes": minutes, "es_online": True, "total": 0, "items": []}
    try:
        async with es_client(settings, timeout=30) as es:
            res = await es.search(index=settings.elastic_index, body=body)
    except Exception:
        result["es_online"] = False
        return result

    hits = res.get("hits", {}).get("hits", [])
    total = res.get("hits", {}).get("total", 0)
    if isinstance(total, dict):  # ES 7+ shape: {"value": N, "relation": ...}
        total = total.get("value", len(hits))
    result["total"] = int(total) if isinstance(total, int) else len(hits)
    result["items"] = [Normalizer.to_app_state(h, field_map) for h in hits]
    return result


@router.get("/run")
async def run_query(
    minutes: int = Query(60, ge=0, le=43200),
    q: str | None = Query(
        None, max_length=200, description="ES substring filter (URL / client IP / server IP)"
    ),
    exclude_whitelist: bool = Query(
        False, description="Exclude whitelisted matches from the result set"
    ),
    exclude_blacklist: bool = Query(
        False, description="Exclude blacklisted hosts/IPs from the result set"
    ),
    kql: str | None = Query(
        None,
        max_length=500,
        description="KQL→ES DSL filter through QueryBuilder (Task 12 pipeline; opt-in)",
    ),
    normalized: bool = Query(
        False,
        description="Return §5.2 NormalizedAppState rows via Normalizer (Task 12 pipeline; opt-in)",
    ),
):
    """Run the block-pattern ES query for the Query page.

    `q` narrows the query inside Elasticsearch itself (instead of changing
    the time window); `exclude_whitelist` drops whitelisted matches so fewer
    documents come back; `exclude_blacklist` drops rows whose host or client
    IP is on the blacklist. Returns matching documents (table), aggregates
    (charts) and a client_ip → base_url flow. Every run is recorded in the
    Logs page.

    When either `kql` or `normalized` is set the request routes through the
    Task 12 query pipeline (QueryBuilder + Normalizer + persisted FieldMap)
    instead — the default block-pattern shape above is untouched for existing
    consumers.
    """
    if kql is not None or normalized:
        from app.database import get_db

        db = await get_db()
        try:
            return await _run_pipeline_query(
                db, minutes=minutes, search=q or None, kql=kql
            )
        finally:
            await db.close()

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
    minutes: int = Query(60, ge=0, le=43200),
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
