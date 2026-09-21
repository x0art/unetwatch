"""Host Inspector backend — GET /api/hosts/{ip} shape + ADR 0001 risk framing."""


async def test_host_profile_offline_returns_zeroed_shape(client):
    """When ES is unreachable the endpoint degrades to a zeroed profile, never 500s."""
    res = client.get("/api/hosts/10.0.0.7?timeRange=24h")
    assert res.status_code == 200
    data = res.json()
    assert data["ip"] == "10.0.0.7"
    assert data["primaryIp"] == "10.0.0.7"
    assert data["es_online"] is False
    # Graded model baseline is 0 (no evidence) — not the old magic 12.
    assert data["risk"]["riskScore"] == 0
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


def test_risk_from_shares_blacklisted_allow_grades_not_floors():
    """A blacklisted-but-ALLOWed reach is the strongest signal, but the score
    is now GRADED — more reaches score strictly higher, and nothing returns
    the old flat 92 floor.
    (_aggregate_host needs live ES, so the pure risk helper is the testable
    path for the escalation rule.)"""
    from app.routes.hosts import _risk_from_shares

    few = _risk_from_shares(
        total=100, risk_requests=5, blacklisted_risk=1, blacklisted_distinct=1
    )
    # The old model returned a FLAT 92 here. The graded model must not.
    assert few["riskScore"] != 92
    assert few["riskReason"]["floored"] is False

    # No reaches → no reach signal at all (intent-only, capped LOW).
    deny_only = _risk_from_shares(total=100, risk_requests=0, enforcements=5)
    assert deny_only["riskLevel"] == "LOW"

    # More reaches → strictly higher (graded, not flat).
    more = _risk_from_shares(
        total=100, risk_requests=50, blacklisted_risk=5, blacklisted_distinct=1
    )
    assert more["riskScore"] > few["riskScore"]
    assert more["riskLevel"] == "HIGH"


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


# ── Risk explanation + GRADED model (2026-09-21) ────────────────────────────
# The operator saw "Risk Score: HIGH 92/100" with nothing saying WHY, and the
# 92 was a FLAT floor — one reach and five hundred reaches scored the same.
# The model is now graded: the reason must state the graded inputs, and the
# score must move with them. A score is never presented without its basis.


def test_risk_reason_graded_reach_states_its_inputs():
    """(a) A reach-carrying host reports the graded rule and every input."""
    from app.routes.hosts import _risk_from_shares

    risk = _risk_from_shares(
        total=10,
        risk_requests=10,
        blacklisted_risk=3,
        blacklisted_distinct=2,
        enforcements=0,
        newest_reach_age_minutes=10,
    )

    reason = risk["riskReason"]
    assert risk["riskLevel"] == "HIGH"
    assert reason["rule"] == "graded_reach"
    # The flat floor is gone; the flag survives but is always false now.
    assert reason["floored"] is False
    assert reason["inputs"]["totalRequests"] == 10
    assert reason["inputs"]["riskRequests"] == 10
    assert reason["inputs"]["blacklistedDistinct"] == 2
    assert reason["inputs"]["reachCount"] == 10
    assert reason["inputs"]["newestReachAgeMinutes"] == 10
    # The operator-facing sentence states the graded basis.
    assert "reach" in reason["text"]
    assert "distinct blacklisted destination" in reason["text"]


def test_risk_score_grades_with_reach_volume():
    """More reaches to the same destination score strictly higher."""
    from app.routes.hosts import _risk_from_shares

    one = _risk_from_shares(total=100, risk_requests=1, blacklisted_distinct=1)
    five = _risk_from_shares(total=100, risk_requests=5, blacklisted_distinct=1)
    twenty = _risk_from_shares(total=100, risk_requests=20, blacklisted_distinct=1)
    assert one["riskScore"] < five["riskScore"] < twenty["riskScore"]


def test_risk_score_grades_with_distinct_destinations():
    """Breadth beats repeats: 3 distinct destinations > 3 repeats of one."""
    from app.routes.hosts import _risk_from_shares

    distinct = _risk_from_shares(
        total=3, risk_requests=3, blacklisted_distinct=3
    )
    repeats = _risk_from_shares(
        total=3, risk_requests=3, blacklisted_distinct=1
    )
    assert distinct["riskScore"] > repeats["riskScore"]


def test_risk_score_rewards_recency():
    """A recent reach scores above a stale one (current behaviour matters)."""
    from app.routes.hosts import _risk_from_shares

    recent = _risk_from_shares(
        total=1, risk_requests=1, blacklisted_distinct=1,
        newest_reach_age_minutes=5,
    )
    stale = _risk_from_shares(
        total=1, risk_requests=1, blacklisted_distinct=1,
        newest_reach_age_minutes=10_000,
    )
    assert recent["riskScore"] > stale["riskScore"]


def test_attempt_only_scores_below_any_reach_host():
    """A DENY-only host (intent evidence) must rank below any REACH host."""
    from app.routes.hosts import _risk_from_shares

    attempt_only = _risk_from_shares(total=100, risk_requests=0, enforcements=500)
    assert attempt_only["riskReason"]["rule"] == "graded_attempt_only"
    assert attempt_only["riskLevel"] == "LOW"
    # Compare against the weakest possible reach host (1 reach, no breadth,
    # stale): the attempt-only score must still be strictly lower.
    weakest_reach = _risk_from_shares(
        total=100, risk_requests=1, blacklisted_distinct=0,
        newest_reach_age_minutes=10_000,
    )
    assert attempt_only["riskScore"] < weakest_reach["riskScore"]
    # Attempts still CONTRIBUTE (not ignored): more DENYs grade higher.
    few = _risk_from_shares(total=100, risk_requests=0, enforcements=1)
    more = _risk_from_shares(total=100, risk_requests=0, enforcements=5)
    assert more["riskScore"] > few["riskScore"]


def test_risk_score_is_monotonic_across_the_grid():
    """1/5/20 reaches × 1/2/5 destinations: the score is non-decreasing in
    both axes and strictly increasing wherever it is below the 100 ceiling."""
    from app.routes.hosts import _risk_from_shares

    grid = {
        (r, d): _risk_from_shares(
            total=r, risk_requests=r, blacklisted_distinct=d,
            newest_reach_age_minutes=5,
        )["riskScore"]
        for r in (1, 5, 20)
        for d in (1, 2, 5)
    }
    # Non-decreasing in both axes (a saturating ceiling is a legitimate tie).
    for d in (1, 2, 5):
        assert grid[(1, d)] <= grid[(5, d)] <= grid[(20, d)]
    for r in (1, 5, 20):
        assert grid[(r, 1)] <= grid[(r, 2)] <= grid[(r, 5)]
    # Strictly increasing below the ceiling — the grading is real, not flat.
    for d in (1, 2, 5):
        assert grid[(1, d)] < grid[(5, d)]
    assert grid[(1, 1)] < grid[(1, 2)] < grid[(1, 5)]
    assert grid[(5, 1)] < grid[(5, 2)]
    # Both axes can reach the ceiling, and nothing ever exceeds it.
    assert grid[(20, 5)] == 100
    assert all(v <= 100 for v in grid.values())


def test_risk_reason_zero_traffic_is_labelled_a_baseline():
    """The empty window is the model's 0 baseline, and says so — not a
    measured clean result."""
    from app.routes.hosts import _risk_from_shares

    risk = _risk_from_shares(total=0, risk_requests=0, blacklisted_risk=0)
    assert risk["riskScore"] == 0
    assert risk["riskReason"]["rule"] == "no_traffic"
    assert "baseline" in risk["riskReason"]["text"]


def test_risk_reason_floored_flag_is_always_false():
    """The flat floor is deleted: no input can set `floored` true again."""
    from app.routes.hosts import _risk_from_shares

    for kwargs in (
        {"total": 10, "risk_requests": 10, "blacklisted_risk": 10},
        {"total": 100, "risk_requests": 1, "blacklisted_distinct": 5},
        {"total": 100, "risk_requests": 0, "enforcements": 50},
        {"total": 0, "risk_requests": 0},
    ):
        reason = _risk_from_shares(**kwargs)["riskReason"]
        assert reason["floored"] is False
        assert reason["rule"] != "blacklisted_destination_floor"


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
    # Back-compat: the numeric fields still exist (unavailable must not raise);
    # the baseline is now 0 — "no evidence", never a plausible 12.
    assert risk["riskScore"] == 0
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
            "blacklistedDistinct": 2,
            "newestReachAgeMinutes": 10,
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
    # Graded model: 10 reaches + 2 distinct destinations + recent → HIGH.
    assert risk["riskScore"] == 74
    assert risk["riskLevel"] == "HIGH"
    assert risk["riskReason"]["rule"] == "graded_reach"
    assert risk["riskReason"]["floored"] is False
    # The additive breadth figure rides the payload.
    assert risk["blacklistedDistinct"] == 2
    assert risk["sources"]["risk"]["available"] is True
    assert "Elasticsearch" in risk["sources"]["risk"]["source"]
    assert risk["sources"]["risk"]["window"] == "1d"
