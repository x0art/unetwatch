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


# Bandwidth honesty (product rule: a shown number is a persisted field or an
# explicit unavailable marker — never synthesized). The old
# ``_synthesize_bandwidth`` multiplied a request count by 0.12 and formatted it
# as MB/GB; it is deleted. The host profile now SUMS the persisted
# ``bytes_downloaded``/``bytes_uploaded`` findings columns (same host + window)
# and marks "nothing to sum" with ``bandwidthNeverMeasured``.


async def test_synthesize_bandwidth_is_gone():
    """The fabricator must not come back: no producer of a fake size."""
    import app.routes.hosts as hosts_mod

    assert not hasattr(hosts_mod, "_synthesize_bandwidth")


async def test_host_profile_bandwidth_is_unavailable_when_nothing_persisted(client):
    """No persisted bytes → an explicit unavailable marker, never a number.

    The offline profile is the no-data case: the ES window was never
    persisted, so there is nothing to sum. `bandwidth` must NOT carry a
    synthesized string, and the byte totals must be null (a real "no
    measurement"), not 0 dressed up as a measured zero.
    """
    res = client.get("/api/hosts/10.0.0.7?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]
    assert risk["bandwidth"] is None
    assert risk["bandwidthDownload"] is None
    assert risk["bandwidthUpload"] is None
    assert risk["bandwidthNeverMeasured"] is True


async def test_host_profile_bandwidth_sums_persisted_bytes(client, db_path):
    """Real byte totals are SUMMED from the persisted findings columns."""
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, "
            "log_timestamp, matched_patterns, bytes_downloaded, bytes_uploaded) "
            "VALUES ('10.9.9.9', '10.0.0.1', 'https://evil.example/x', "
            "'evil.example', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), '[]', "
            "'2048', '1024')"
        )
        conn.commit()
    finally:
        conn.close()

    res = client.get("/api/hosts/10.9.9.9?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]
    assert risk["bandwidthDownload"] == 2048
    assert risk["bandwidthUpload"] == 1024
    assert risk["bandwidthNeverMeasured"] is False


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


async def test_host_profile_accepts_90d_and_1y_labels(client):
    """90d/1y/3d timeRange labels map to long windows (no silent 24h fallback)."""
    from app.routes.hosts import _aggregate_host  # noqa: F401  (import guard)
    import app.routes.hosts as hosts_mod
    import inspect

    src = inspect.getsource(hosts_mod)
    assert '"3d": 4320' in src
    assert '"90d": 129600' in src
    assert '"1y": 525600' in src
    # Endpoint still degrades gracefully offline for the new labels.
    res = client.get("/api/hosts/10.0.0.7?timeRange=3d")
    assert res.status_code == 200
    res = client.get("/api/hosts/10.0.0.7?timeRange=90d")
    assert res.status_code == 200
    res = client.get("/api/hosts/10.0.0.7?timeRange=1y")
    assert res.status_code == 200


# ── Risk explanation (2026-09-21) ───────────────────────────────────────────
# The operator saw "Risk Score: HIGH 92/100" with nothing saying WHY: a bare
# score cannot distinguish a MEASURED 92 from the hardcoded blacklist floor,
# nor a real LOW from ES simply being down. A score must never be presented
# without its justification.


def test_risk_reason_blacklisted_floor_carries_its_reason():
    """(a) The operator's exact case: the blacklist floor names itself."""
    from app.routes.hosts import _risk_from_shares

    risk = _risk_from_shares(total=10, risk_requests=10, blacklisted_risk=3)

    assert risk["riskScore"] == 92
    assert risk["riskLevel"] == "HIGH"
    reason = risk["riskReason"]
    assert reason["rule"] == "blacklisted_destination_floor"
    assert reason["floored"] is True
    assert reason["inputs"] == {
        "totalRequests": 10,
        "riskRequests": 10,
        "blacklistedRequests": 3,
        "riskShare": 1.0,
    }
    # The operator-facing sentence must state the rule, not just repeat "92".
    assert "blacklisted-destination" in reason["text"]
    assert "92" in reason["text"]


def test_risk_reason_share_bracket_carries_its_bracket():
    """(c) A normal share bracket reports the bracket that produced it."""
    from app.routes.hosts import _risk_from_shares

    # >0.5 → HIGH bracket.
    high = _risk_from_shares(total=100, risk_requests=90)
    assert high["riskLevel"] == "HIGH"
    assert high["riskReason"]["rule"] == "share_above_0.5"
    assert high["riskReason"]["floored"] is False

    # >0.2 → MEDIUM bracket.
    medium = _risk_from_shares(total=100, risk_requests=30)
    assert medium["riskLevel"] == "MEDIUM"
    assert medium["riskReason"]["rule"] == "share_above_0.2"
    assert medium["riskReason"]["inputs"]["riskShare"] == 0.3

    # <=0.2 → LOW bracket.
    low = _risk_from_shares(total=100, risk_requests=5)
    assert low["riskLevel"] == "LOW"
    assert low["riskReason"]["rule"] == "share_at_or_below_0.2"


def test_risk_reason_zero_traffic_is_labelled_a_baseline():
    """The empty window is the model's baseline, and says so — not a
    measured clean result."""
    from app.routes.hosts import _risk_from_shares

    risk = _risk_from_shares(total=0, risk_requests=0, blacklisted_risk=0)
    assert risk["riskScore"] == 12
    assert risk["riskReason"]["rule"] == "no_traffic"
    assert "baseline" in risk["riskReason"]["text"]


def test_risk_reason_floored_flag_absent_when_not_floored():
    """A share-bracket HIGH that already clears 92 is NOT marked floored."""
    from app.routes.hosts import _risk_from_shares

    # share 1.0 → 72 + 20 = 92 exactly; no blacklist → not the floor rule.
    risk = _risk_from_shares(total=10, risk_requests=10, blacklisted_risk=0)
    assert risk["riskScore"] == 92
    assert risk["riskReason"]["floored"] is False
    assert risk["riskReason"]["rule"] != "blacklisted_destination_floor"


async def test_host_profile_es_unavailable_is_not_a_bare_low_score(client):
    """(b) ES offline / mode UNKNOWN must NOT render as a plausible LOW 12.

    The risk reason must be its own distinct unavailable state carrying no
    score, and the provenance must mark the source unavailable — so an
    un-observed host cannot be confused with a clean one."""
    res = client.get("/api/hosts/10.0.0.7?timeRange=24h")
    assert res.status_code == 200
    data = res.json()
    risk = data["risk"]

    assert data["es_online"] is False
    assert risk["riskScoreAvailable"] is False
    reason = risk["riskReason"]
    assert reason["state"] == "unavailable"
    assert "score" not in reason, "an unavailable reason must carry no score"
    assert "Elasticsearch unavailable" in reason["text"]
    # Provenance says the score is unavailable and still labels the detail
    # source + window, so the two figures are never conflated.
    assert risk["sources"]["risk"]["available"] is False
    assert risk["sources"]["risk"]["source"] is None
    assert risk["sources"]["risk"]["window"] == "1d"
    assert "findings" in risk["sources"]["risk"]["persisted_detail"]
    # Back-compat: the old fields survive unchanged.
    assert risk["riskScore"] == 12
    assert risk["riskLevel"] == "LOW"


async def test_host_profile_carries_explained_reason_when_es_online(
    client, monkeypatch
):
    """When the aggregate resolves, the payload carries the rule that produced
    the level and the source/window of the numbers — the operator's case."""
    import app.routes.hosts as hosts_mod

    async def fake_aggregate(ip: str, minutes: int):
        return {
            "totalRequests": 10,
            "riskRequests": 10,
            "enforcements": 0,
            "blacklistedRequests": 3,
            "es_online": True,
            "bandwidthDownload": None,
            "bandwidthUpload": None,
            "bandwidthNeverMeasured": True,
        }

    monkeypatch.setattr(hosts_mod, "_aggregate_host", fake_aggregate)
    res = client.get("/api/hosts/10.0.0.7?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]

    assert risk["riskScoreAvailable"] is True
    assert risk["riskScore"] == 92
    assert risk["riskReason"]["rule"] == "blacklisted_destination_floor"
    assert risk["riskReason"]["floored"] is True
    assert risk["sources"]["risk"]["available"] is True
    assert "Elasticsearch" in risk["sources"]["risk"]["source"]
    assert risk["sources"]["risk"]["window"] == "1d"
