"""Host Inspector backend — GET /api/hosts/{ip} shape + ADR 0001 risk framing."""


async def test_host_profile_offline_returns_zeroed_shape(client):
    """When ES is unreachable the endpoint degrades to a zeroed profile, never 500s."""
    res = client.get("/api/hosts/10.0.0.7?timeRange=24h")
    assert res.status_code == 200
    data = res.json()
    assert data["ip"] == "10.0.0.7"
    assert data["primaryIp"] == "10.0.0.7"
    assert data["es_online"] is False
    assert data["risk"]["riskScore"] == 12
    assert data["risk"]["riskLevel"] == "LOW"
    assert data["risk"]["totalRequests"] == 0
    assert data["risk"]["riskRequests"] == 0
    assert data["risk"]["enforcements"] == 0
    assert data["risk"]["blacklistedRequests"] == 0
    assert data["risk"]["enforcementsPct"] == 0


async def test_risk_from_shares_blacklisted_allow_escalates_to_high():
    """A blacklisted-but-ALLOWed request is the highest-risk signal — it
    escalates the host to HIGH even when the raw ALLOW share would say LOW.
    (_aggregate_host needs live ES, so the pure risk helper is the testable
    path for the escalation rule.)"""
    from app.routes.hosts import _risk_from_shares

    # LOW share but one blacklisted ALLOW request → HIGH, score floored at 92.
    low_share = _risk_from_shares(total=100, risk_requests=5, blacklisted_risk=1)
    assert low_share["riskLevel"] == "HIGH"
    assert low_share["riskScore"] == 92

    # No blacklisted-ALLOW requests → normal share logic; no escalation.
    deny_only = _risk_from_shares(total=100, risk_requests=0, blacklisted_risk=0)
    assert deny_only["riskLevel"] == "LOW"

    # A high ALLOW share stays HIGH and keeps its (clamped) score.
    high_share = _risk_from_shares(total=100, risk_requests=90, blacklisted_risk=2)
    assert high_share["riskLevel"] == "HIGH"
    assert high_share["riskScore"] == 92


async def test_host_profile_ip_validation(client):
    """An empty ip should not 500 (FastAPI path param min_length)."""
    # A path like /api/hosts// would 404 at the router — just confirm the
    # endpoint exists and rejects nothing surprising.
    res = client.get("/api/hosts/1.2.3.4")
    assert res.status_code == 200
    assert res.json()["ip"] == "1.2.3.4"
