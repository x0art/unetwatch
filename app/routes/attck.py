"""MITRE ATT&CK mapping API routes.

GET /api/attck/host/{ip}          — map a client IP to techniques
GET /api/attck/url/{url}         — map a URL to techniques
GET /api/attck/url/{url}?source=findings — map from persisted findings
GET /api/attck/fleet             — aggregate techniques across every host
"""

from fastapi import APIRouter, Query

from app.services.attck_mapping import map_host, map_url

router = APIRouter(prefix="/api/attck", tags=["attck"])

_TIME_RANGE_MAP = {
    "1h": 60,
    "24h": 1440,
    "3d": 4320,
    "7d": 10080,
    "30d": 43200,
    "90d": 129600,
    "1y": 525600,
}


@router.get("/host/{ip}")
async def host_attck_mapping(
    ip: str,
    timeRange: str = Query("24h", max_length=8),
    minutes: int | None = Query(None, ge=0, le=525600),
):
    """Return the ATT&CK mapping for a single client IP.

    ``timeRange`` is a human-friendly label that maps to a minute window.
    Pass ``minutes`` explicitly to override.
    """
    if minutes is None:
        minutes = _TIME_RANGE_MAP.get(timeRange, 1440)
    return await map_host(ip, minutes)


@router.get("/url/{url:path}")
async def url_attck_mapping(
    url: str,
    source: str = Query("live", pattern="^(live|findings)$"),
    limit: int = Query(50, ge=1, le=500),
):
    """Return the ATT&CK mapping for a single URL.

    ``source="live"`` queries Elasticsearch; ``source="findings"`` queries
    the persisted findings table.
    """
    return await map_url(url, source=source, limit=limit)


@router.get("/fleet")
async def fleet_attck_mapping(
    timeRange: str = Query("24h", max_length=8),
    minutes: int | None = Query(None, ge=0, le=525600),
    hostLimit: int = Query(50, ge=1, le=500),
):
    """Aggregate ATT&CK techniques across every host in the findings table.

    Answers the question the per-entity endpoints cannot — *which techniques
    are present fleet-wide, on how many hosts, and which are most prevalent?*

    The aggregation reads the persisted findings table, not Elasticsearch, so
    it is a fixed number of SQL ``GROUP BY`` queries rather than one ES query
    per host (no N+1). ``hostLimit`` caps only the per-host breakdown; the
    technique aggregate always spans every host in the window.
    """
    from app.services.attck_fleet import map_fleet

    if minutes is None:
        minutes = _TIME_RANGE_MAP.get(timeRange, 1440)
    return await map_fleet(minutes, host_limit=hostLimit)
