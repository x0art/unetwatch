"""Host Inspector backend — GET /api/hosts/{ip} shape + ADR 0001 risk framing."""

# ``_risk_from_shares``'s ATTEMPT weight, imported rather than restated so the
# fallback test states the model's own number (no second copy in the tests).
from app.routes.hosts import ATTEMPT_WEIGHT  # noqa: E402


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
    un-observed host cannot be confused with a clean one.

    Scope note (2026-09-21): the route now falls back to the persisted
    findings table before it declares unavailability. This test's host has
    nothing persisted either, so it exercises the BOTH-STORES-EMPTY state —
    which is still the explicit no-score state this test is about. The
    live-path-unavailable-but-persisted case is covered separately below."""
    res = client.get("/api/hosts/10.0.0.7?timeRange=24h")
    assert res.status_code == 200
    data = res.json()
    risk = data["risk"]

    assert data["es_online"] is False
    assert risk["riskScoreAvailable"] is False
    reason = risk["riskReason"]
    assert reason["state"] == "unavailable"
    # The reason is the BOTH-STORES-EMPTY state, and it says so.
    assert reason["reason"] == "no_live_window_and_no_persisted_findings"
    assert "Elasticsearch" in reason["text"]
    # Provenance says the score is unavailable and still labels the detail
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


# ── Persisted-findings fallback (2026-09-21) ────────────────────────────────
# The route used to answer from live ES ONLY: with ES unreachable it returned
# the explicit unavailable state, and the CLIENT then graded the findings table
# itself using a second copy of this model's 14 constants — with the breadth
# and enforcement inputs hardcoded to 0. The route now grades the persisted
# table from the one owner of the model, and these tests pin that: the
# fallback must reproduce the SAME graded inputs (reach count, DISTINCT
# blacklisted destinations, enforcements, newest-reach recency) and must name
# the store that answered.


def _insert_finding(
    db_path: str,
    client_ip: str,
    base_url: str,
    action: str,
    *,
    log_timestamp: str = "",
    matched_patterns: str = '["blocked"]',
    path: str = "/x",
) -> None:
    """Persist one findings row the way the poll does (action + intent set)."""
    import sqlite3

    ts = log_timestamp or "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
    intent = "REACH" if action == "ALLOW" else "ATTEMPT" if action == "DENY" else ""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, "
            "log_timestamp, matched_patterns, action, intent) VALUES "
            f"(?, '10.0.0.1', ?, ?, {ts}, ?, ?, ?)",
            (
                client_ip,
                f"https://{base_url}{path}",
                base_url,
                matched_patterns,
                action,
                intent,
            ),
        )
        conn.commit()
    finally:
        conn.close()


async def test_host_profile_falls_back_to_persisted_findings_when_es_offline(
    client, db_path
):
    """ES unreachable + persisted rows → the BACKEND grades them, single-sourced.

    The unavailable state with which this file opens must therefore not be
    reachable while persisted evidence exists.
    """
    # ES is unreachable in the test environment: _aggregate_host returns None.
    _insert_finding(db_path, "10.5.5.5", "blocked.example", "ALLOW")

    res = client.get("/api/hosts/10.5.5.5?timeRange=24h")
    assert res.status_code == 200
    data = res.json()
    risk = data["risk"]

    # A score WAS computed, by the backend, and the reason explains it.
    assert risk["riskScoreAvailable"] is True
    assert risk["riskReason"].get("state") != "unavailable"
    assert risk["riskReason"]["rule"] == "graded_reach"
    # 1 reach, no blacklist membership, no recency penalty for a just-now row.
    assert risk["riskScore"] == 33  # REACH_BASE 20 + 3*1 + RECENCY_BONUS 10
    assert risk["riskRequests"] == 1
    assert risk["totalRequests"] == 1
    # Provenance names the PERSISTED store and its window, not the live one.
    assert risk["sources"]["risk"]["available"] is True
    assert "persisted findings" in risk["sources"]["risk"]["source"]
    assert "Elasticsearch" not in risk["sources"]["risk"]["source"]
    assert risk["sources"]["risk"]["window"] == "1d"
    # es_online reports ES liveness (still false) — independent of the score.
    assert data["es_online"] is False


async def test_host_profile_fallback_counts_real_distinct_blacklisted_dests(
    client, db_path
):
    """Breadth comes from real blacklist_entries membership, never a hardcoded 0.

    The deleted client mirror passed ``blacklistedDistinct: 0`` and forfeited
    the whole breadth term (up to 35 points). Three DISTINCT blacklisted
    destinations must score strictly above one.
    """
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO blacklist_entries (kind, value) VALUES ('url', 'bad-a.example')"
        )
        conn.execute(
            "INSERT INTO blacklist_entries (kind, value) VALUES ('url', 'bad-b.example')"
        )
        conn.commit()
    finally:
        conn.close()

    for dest in ("bad-a.example", "bad-b.example"):
        _insert_finding(db_path, "10.6.6.6", dest, "ALLOW")

    res = client.get("/api/hosts/10.6.6.6?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]
    assert risk["blacklistedRequests"] == 2
    assert risk["blacklistedDistinct"] == 2
    assert risk["riskReason"]["inputs"]["blacklistedDistinct"] == 2
    # 2 reaches: 20 + 3*2 + breadth 7*2 + recency 10 = 50.
    assert risk["riskScore"] == 50


async def test_host_profile_fallback_counts_real_enforcements_not_zero(client, db_path):
    """DENY rows are ATTEMPT evidence, counted — the mirror hardcoded 0."""

    # DISTINCT urls: the findings table is deduped by
    # (client_ip, url, log_timestamp), so identical repeats would collapse
    # into one row and the count would be a fiction of the INSERT.
    _insert_finding(db_path, "10.7.7.7", "blocked.example", "DENY", path="/a")
    _insert_finding(db_path, "10.7.7.7", "blocked.example", "DENY", path="/b")
    _insert_finding(db_path, "10.7.7.7", "blocked.example", "ALLOW", path="/c")

    res = client.get("/api/hosts/10.7.7.7?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]
    assert risk["enforcements"] == 2
    assert risk["riskRequests"] == 1
    assert risk["totalRequests"] == 3
    assert risk["riskReason"]["rule"] == "graded_reach"
    assert risk["riskReason"]["inputs"]["attemptCount"] == 2
    # 1 reach: 20 + 3 + recency 10 + min(20, 2*2) = 37.
    assert risk["riskScore"] == 37


async def test_host_profile_fallback_attempt_only_is_capped_low(client, db_path):
    """A DENY-only host is graded by the ATTEMPT branch — still below any reach."""
    _insert_finding(db_path, "10.8.8.8", "blocked.example", "DENY")

    res = client.get("/api/hosts/10.8.8.8?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]
    assert risk["riskReason"]["rule"] == "graded_attempt_only"
    assert risk["riskScore"] == ATTEMPT_WEIGHT
    assert risk["riskLevel"] == "LOW"


async def test_host_profile_fallback_respects_the_window(client, db_path):
    """A row outside the window is not graded — the window clause is real."""
    _insert_finding(
        db_path,
        "10.9.9.8",
        "blocked.example",
        "ALLOW",
        log_timestamp="strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')",
    )

    inside = client.get("/api/hosts/10.9.9.8?timeRange=30d").json()["risk"]
    assert inside["riskScoreAvailable"] is True
    assert inside["riskRequests"] == 1

    outside = client.get("/api/hosts/10.9.9.8?timeRange=1h").json()["risk"]
    assert outside["riskScoreAvailable"] is False
    assert outside["riskReason"]["state"] == "unavailable"


async def test_host_profile_fallback_grades_real_persisted_evidence(client, db_path):
    """End-to-end trace of the ES-unreachable branch, in one host.

    ES is unreachable (the test env has no Elasticsearch), and the findings
    table holds six rows: 3 ALLOW reaches (2 of them to DISTINCT blacklisted
    destinations) and 3 DENYs to a blacklisted destination.

    The route must answer from the PERSISTED store, with every graded input
    real:
        3 reaches   -> REACH_BASE 20 + REACH_PER_HIT_WEIGHT 3*3   = 29
        2 distinct  -> DISTINCT_DEST_WEIGHT 7*2                   = 14
        fresh reach -> RECENCY_BONUS                              = 10
        3 attempts  -> ATTEMPT_WEIGHT 2*3                         =  6
                                                  total = 59, MEDIUM
    """
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        for value in ("bad-a.example", "bad-b.example"):
            conn.execute(
                "INSERT INTO blacklist_entries (kind, value) VALUES ('url', ?)",
                (value,),
            )
        conn.commit()
    finally:
        conn.close()

    _insert_finding(db_path, "10.4.4.4", "bad-a.example", "ALLOW", path="/p1")
    _insert_finding(db_path, "10.4.4.4", "bad-b.example", "ALLOW", path="/p2")
    _insert_finding(db_path, "10.4.4.4", "ok.example", "ALLOW", path="/p3")
    _insert_finding(db_path, "10.4.4.4", "bad-a.example", "DENY", path="/d1")
    _insert_finding(db_path, "10.4.4.4", "bad-a.example", "DENY", path="/d2")
    _insert_finding(db_path, "10.4.4.4", "bad-a.example", "DENY", path="/d3")

    res = client.get("/api/hosts/10.4.4.4?timeRange=24h")
    assert res.status_code == 200
    data = res.json()
    risk = data["risk"]

    assert risk["riskScore"] == 59
    assert risk["riskLevel"] == "MEDIUM"
    assert risk["totalRequests"] == 6
    assert risk["riskRequests"] == 3
    assert risk["enforcements"] == 3
    assert risk["blacklistedRequests"] == 2
    assert risk["blacklistedDistinct"] == 2
    assert risk["riskReason"]["rule"] == "graded_reach"
    assert risk["riskReason"]["inputs"]["newestReachAgeMinutes"] == 0
    # Provenance: the persisted store answered over the requested window, and
    # ES itself is still reported offline.
    assert risk["sources"]["risk"]["source"] == "persisted findings (SQLite)"
    assert risk["sources"]["risk"]["window"] == "1d"
    assert risk["sources"]["risk"]["available"] is True
    assert data["es_online"] is False


async def test_host_profile_fallback_grades_a_dedup_collapsed_population(
    client, db_path
):
    """The persisted row count is a DIFFERENT population from a live hit count.

    ``totalRequests`` on the fallback is the count of RECORDED FINDINGS —
    deduplicated by (client_ip, url, log_timestamp) and filtered — not the
    live path's block-pattern hit count over the ES window. The two are not
    the same quantity, so this test pins both halves of the consequence:

      (a) a composition that a live count would have reported differently
          still GRADES — it is not collapsed into the ``no_traffic``
          empty-window baseline, whose gate is ``total <= 0``; and
      (b) the score is traceable to the fallback's own inputs, which the
          riskReason echoes.

    ``_insert_finding`` writes three rows that INTENTIONALLY share nothing but
    their client IP, so the dedup key cannot collapse them: one ALLOW reach to
    a blacklisted destination, one ALLOW reach to a non-blacklisted one, and
    one DENY. Duplicated identical rows would collapse under the UNIQUE
    constraint, so the counts asserted below are the counts actually stored.
    """
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO blacklist_entries (kind, value) VALUES ('url', 'listed.example')"
        )
        conn.commit()
    finally:
        conn.close()

    _insert_finding(db_path, "10.10.10.10", "listed.example", "ALLOW", path="/r1")
    _insert_finding(db_path, "10.10.10.10", "unlisted.example", "ALLOW", path="/r2")
    _insert_finding(db_path, "10.10.10.10", "listed.example", "DENY", path="/a1")

    res = client.get("/api/hosts/10.10.10.10?timeRange=24h")
    assert res.status_code == 200
    risk = res.json()["risk"]

    # (a) GRADED, not the empty-window baseline: the fallback population is
    # non-empty, so the model's `total <= 0` gate cannot fire.
    assert risk["riskReason"]["rule"] == "graded_reach"
    assert risk["riskReason"].get("state") != "unavailable"
    assert risk["riskScoreAvailable"] is True

    # (b) the graded inputs are the fallback's own counting, and the reason
    # echoes the exact population they were taken over.
    assert risk["totalRequests"] == 3
    assert risk["riskRequests"] == 2
    assert risk["enforcements"] == 1
    assert risk["blacklistedRequests"] == 1
    assert risk["blacklistedDistinct"] == 1
    assert risk["riskReason"]["inputs"]["riskRequests"] == 2
    assert risk["riskReason"]["inputs"]["totalRequests"] == 3

    # 2 reaches -> REACH_BASE 20 + REACH_PER_HIT_WEIGHT 3*2            = 26
    # 1 distinct -> DISTINCT_DEST_WEIGHT 7*1                          =  7
    # fresh reach -> RECENCY_BONUS                                    = 10
    # 1 attempt -> ATTEMPT_WEIGHT 2*1                                 =  2
    #                                                       total = 45, MEDIUM
    assert risk["riskScore"] == 45
    assert risk["riskLevel"] == "MEDIUM"
    # The reason sentence states the population it graded over, so a reader can
    # tell which count this is — "over 3 request(s)", the persisted rows.
    assert "over 3 request(s)" in risk["riskReason"]["text"]
