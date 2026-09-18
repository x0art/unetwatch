"""ATT&CK mapping — field-availability gating, confidence downgrade, periodicity.

These tests pin the *field-driven* contract from docs/attck-mapping-spec.md:
a technique may only be emitted when every field its predicate reads resolved
PRESENT. The interesting assertions are therefore mostly negative — what the
engine REFUSES to emit when a deployment's documents carry fewer fields.

The fixtures below are pure unit-level (no ES, no DB) except where the full
``map_host`` path is exercised against a stubbed ``es_client``.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.services import attck_mapping as am
from app.services.attck_mapping import (
    ABSENT,
    PRESENT,
    UNKNOWN,
    FieldAvailability,
    Signal,
    _gate,
    _interval_cv,
    _slot_concentration,
    resolve_availability,
)

# Field sets representative of the three resolvable modes. UC-A/UC-B differ only
# by user_agent; COLLAPSED is exactly the six baseline fields.
_UC_A_FIELDS = {
    "@timestamp", "url", "client_ip", "server_ip", "duration_seconds", "action",
    "domain", "category", "http_method", "http_status_code", "country_code",
    "bytes_downloaded", "bytes_uploaded", "rule_info", "rule_name", "user_id",
    "matched_patterns", "user_agent", "username", "session",
}
_UC_B_FIELDS = _UC_A_FIELDS - {"user_agent"}
_COLLAPSED_FIELDS = {
    "@timestamp", "url", "client_ip", "server_ip", "duration_seconds", "action",
}


def _avail(mode: str, names: set[str]) -> FieldAvailability:
    """Resolve availability from a mode + observed field names."""
    return resolve_availability(
        mode=mode, inventory_names=set(names), es_online=True
    )


def _sig(names: set[str], mode: str = "UC-A", **kwargs) -> Signal:
    """A Signal whose available_fields mirror the given set."""
    avail = _avail(mode, names)
    return Signal(available_fields=dict(avail.fields), mode=mode, **kwargs)


# ── §b.1 availability resolution ────────────────────────────────────────────


def test_unknown_mode_resolves_every_field_unknown():
    """No inventory => every field UNKNOWN, which the gate treats as closed."""
    avail = resolve_availability(
        mode="UNKNOWN", inventory_names=set(), es_online=False
    )
    assert avail.mode == "UNKNOWN"
    assert set(avail.fields.values()) == {UNKNOWN}
    # UNKNOWN is deliberately NOT "present".
    assert not avail.has("url")
    assert not avail.has("action")


def test_baseline_fields_present_in_every_resolvable_mode():
    for mode, names in (
        ("UC-A", _UC_A_FIELDS),
        ("UC-B", _UC_B_FIELDS),
        ("COLLAPSED", _COLLAPSED_FIELDS),
    ):
        avail = _avail(mode, names)
        for field in am.BASELINE_FIELDS:
            assert avail.has(field), f"{field} missing in {mode}"


def test_collapsed_mode_marks_non_baseline_fields_absent():
    """COLLAPSED's inventory IS the baseline set — not merely unsampled."""
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    for field in ("domain", "bytes_downloaded", "category", "rule_name"):
        assert avail.fields[field] == ABSENT
    # user_agent is a lens field: neither the sample nor the mode proves it.
    assert avail.fields["user_agent"] == UNKNOWN


def test_user_agent_present_only_when_observed():
    """A lens field must not be assumed present just because the mode is UC-*."""
    assert _avail("UC-A", _UC_A_FIELDS).has("user_agent")
    assert not _avail("UC-B", _UC_B_FIELDS).has("user_agent")


def test_drift_guard_baseline_matches_es_fields_resolver():
    """app.services.es_fields._resolve_mode's baseline must match ours."""
    import inspect

    from app.services.es_fields import _resolve_mode

    src = inspect.getsource(_resolve_mode)
    for field in am.BASELINE_FIELDS:
        assert f'"{field}"' in src, f"{field} not in es_fields baseline"


def test_drift_guard_every_catalogued_technique_is_registered():
    """A technique in the catalogue with no runnable heuristic could never be
    suppressed either — it would silently vanish from the response."""
    registered = {tid for tid, _ in am._HOST_HEURISTICS_LIST}
    assert registered == set(am._HOST_HEURISTICS), (
        "host catalogue and heuristic list disagree: "
        f"{set(am._HOST_HEURISTICS) ^ registered}"
    )
    url_registered = {tid for tid, _ in am._URL_HEURISTICS_LIST}
    assert url_registered == set(am._URL_HEURISTICS)


def test_drift_guard_every_technique_has_complete_metadata():
    """Every catalogue entry needs the keys the heuristics read off it.

    A missing ``description`` is not cosmetic: the heuristic does
    ``_HOST_HEURISTICS[tid]["description"]`` and the KeyError would be swallowed
    into a bogus "predicate failed" suppression.
    """
    for catalogue in (am._HOST_HEURISTICS, am._URL_HEURISTICS):
        for tid, meta in catalogue.items():
            for key in ("name", "severity", "description"):
                assert key in meta, f"{tid} missing {key}"
                assert meta[key], f"{tid} has empty {key}"


def test_no_heuristic_raises_for_any_availability_mode():
    """The full gated catalogue must never raise — the endpoint never 500s.

    Regression guard for a malformed catalogue entry (e.g. one missing
    ``description``): ``_evaluate`` must convert the KeyError into a
    suppression rather than letting it reach the request handler.
    """
    for mode, names in (
        ("UC-A", _UC_A_FIELDS),
        ("UC-B", _UC_B_FIELDS),
        ("COLLAPSED", _COLLAPSED_FIELDS),
    ):
        avail = _avail(mode, names)
        sig = _sig(names, mode=mode, total_requests=500, risk_requests=400,
                   enforcements=2, risk_share=0.8, distinct_domains=12,
                   distinct_dest_ips=15, total_bytes=2 * 10**8,
                   upload_bytes=1.5 * 10**8, download_bytes=5 * 10**7,
                   time_span_hours=20, interval_cv=0.2, slot_concentration=0.6)
        for catalogue, entries in (
            (am._HOST_HEURISTICS, am._HOST_HEURISTICS_LIST),
            (am._URL_HEURISTICS, am._URL_HEURISTICS_LIST),
        ):
            for tid, fn in entries:
                technique, reason = am._evaluate(avail, tid, catalogue, fn, sig)
                # Either a technique or a suppression — never an exception.
                assert technique is not None or not reason or reason["id"] == tid
                if technique is not None:
                    assert technique.severity in ("LOW", "MEDIUM", "HIGH")


def test_drift_guard_every_required_field_is_resolvable():
    """A required name with no resolver would read as permanently absent."""
    for catalogue in (am._HOST_HEURISTICS, am._URL_HEURISTICS):
        for tid, meta in catalogue.items():
            names = tuple(meta.get("required", ())) + tuple(meta.get("required_any", ()))
            for name in names:
                assert name in am._FIELD_RESOLVERS, f"{tid} requires unknown field {name}"


# ── §a/§b.2 technique availability gating ───────────────────────────────────


def test_gate_blocks_technique_when_required_field_absent():
    """T1583.001 requires server_ip; COLLAPSED has it, a stripped doc does not."""
    avail_collapsed = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    assert _gate(avail_collapsed, "T1583.001", am._HOST_HEURISTICS) is None

    stripped = FieldAvailability(
        mode="UC-A",
        es_online=True,
        fields={name: (PRESENT if name == "url" else ABSENT) for name in am._FIELD_RESOLVERS},
    )
    reason = _gate(stripped, "T1583.001", am._HOST_HEURISTICS)
    assert reason is not None
    assert "server_ip" in reason


def test_gate_blocks_byte_technique_when_no_byte_field_present():
    """T1041/T1105 bottom out in bytes; with none readable they are withheld."""
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    # COLLAPSED does carry duration_seconds (a byte proxy), so T1041 is allowed.
    assert _gate(avail, "T1041", am._HOST_HEURISTICS) is None

    no_bytes = FieldAvailability(
        mode="COLLAPSED",
        es_online=True,
        fields={
            name: (PRESENT if name in {"url", "@timestamp"} else ABSENT)
            for name in am._FIELD_RESOLVERS
        },
    )
    reason = _gate(no_bytes, "T1041", am._HOST_HEURISTICS)
    assert reason is not None
    assert "bytes_uploaded" in reason or "bytes_downloaded" in reason


def test_gate_blocks_rule_name_technique_without_policy_fields():
    """T1567.002 needs a policy class (rule_name/category) to name the service."""
    avail = _avail("UC-B", _UC_B_FIELDS - {"rule_name", "category"})
    reason = _gate(avail, "T1567.002", am._HOST_HEURISTICS)
    assert reason is not None
    assert "rule_name" in reason and "category" in reason


def test_absent_field_technique_never_emitted_end_to_end():
    """A host whose docs carry only baseline fields yields no domain-gated technique.

    T1567.002 needs a policy class (``rule_name``/``category``) and is withheld
    by the gate, so it appears in ``suppressed`` with a reason. T1583.001 is
    *not* emitted either, but for a different reason: its hard requirement
    (``server_ip``) IS present, so the gate passes and the predicate itself
    declines because it cannot read ``domain``. Both outcomes are correct — the
    contract is "never emitted on unavailable evidence", not "always
    suppressed" — and this test pins both paths.
    """
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    sig = _sig(_COLLAPSED_FIELDS, mode="COLLAPSED", total_requests=5000,
               distinct_dest_ips=40, distinct_domains=0, risk_share=0.9,
               total_bytes=5 * 10**8, risk_requests=4500, enforcements=0)
    techniques, suppressed = am._run_host_heuristics(sig, avail)
    emitted = {t.technique_id for t in techniques}
    suppressed_ids = {s["id"] for s in suppressed}

    # Gate-suppressed: a policy class does not exist in COLLAPSED at all.
    assert "T1567.002" not in emitted
    assert "T1567.002" in suppressed_ids
    # Predicate-declined: gate passes (server_ip is baseline) but the predicate
    # refuses to call an unreadable domain field a domain set.
    assert "T1583.001" not in emitted
    assert am._heuristic_t1583_001_host(sig) is None


def test_every_suppression_carries_a_reason():
    """Suppressions are actionable — id plus a human-readable reason."""
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    sig = _sig(_COLLAPSED_FIELDS, mode="COLLAPSED", total_requests=10)
    _, suppressed = am._run_host_heuristics(sig, avail)
    assert suppressed, "collapsed mode must withhold some techniques"
    for entry in suppressed:
        assert entry["id"].startswith("T")
        assert entry["reason"]


# ── §d confidence downgrade ─────────────────────────────────────────────────


def test_downgrade_is_clamped_at_low():
    assert am._downgrade("HIGH", 1) == "MEDIUM"
    assert am._downgrade("HIGH", 2) == "LOW"
    assert am._downgrade("LOW", 3) == "LOW"
    assert am._downgrade("MEDIUM", 1) == "LOW"


def test_confidence_drops_when_optional_field_missing():
    """The same predicate yields one step less without its optional evidence.

    Uses T1071.001, whose optional ``domain`` is one evidence leg: with it the
    host scores MEDIUM, without it the domain floor is substituted by volume
    and the optional-field downgrade drops the result to LOW.
    """
    full = _avail("UC-A", _UC_A_FIELDS)
    partial = _avail("UC-A", _UC_A_FIELDS - {"domain"})

    sig_full = _sig(_UC_A_FIELDS, mode="UC-A", total_requests=300,
                    risk_requests=200, risk_share=0.5, distinct_domains=9)
    sig_partial = Signal(available_fields=dict(partial.fields), mode="UC-A",
                         total_requests=300, risk_requests=200, risk_share=0.5,
                         distinct_domains=9)

    tech_full, _ = am._evaluate(full, "T1071.001", am._HOST_HEURISTICS,
                                am._heuristic_t1071_001_host, sig_full)
    tech_partial, _ = am._evaluate(partial, "T1071.001", am._HOST_HEURISTICS,
                                   am._heuristic_t1071_001_host, sig_partial)

    assert tech_full is not None and tech_partial is not None
    order = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    assert order[tech_partial.severity] < order[tech_full.severity]
    assert "confidence_downgrade" in tech_partial.evidence


def test_mode_proven_field_does_not_cost_a_downgrade():
    """user_agent's availability is proven by UC-A; it must not be charged."""
    avail = _avail("UC-A", _UC_A_FIELDS - {"user_agent"})
    missing = am._optional_missing(avail, ("user_agent",))
    assert missing == []


def test_emitted_technique_carries_field_provenance():
    avail = _avail("UC-A", _UC_A_FIELDS)
    sig = _sig(_UC_A_FIELDS, mode="UC-A", total_bytes=10**9, risk_share=0.9,
               distinct_domains=5, total_requests=100, risk_requests=90)
    tech, _ = am._evaluate(avail, "T1041", am._HOST_HEURISTICS,
                           am._heuristic_t1041_host, sig)
    assert tech is not None
    assert tech.evidence["es_mode"] == "UC-A"
    assert tech.evidence["bytes_source"] == "none"
    assert "field_availability" in tech.evidence


# ── §e UNKNOWN mode emits zero techniques ───────────────────────────────────


async def test_map_host_unknown_mode_emits_zero_techniques(monkeypatch):
    """mode=UNKNOWN => zero techniques and an explicit reason, never a guess."""
    from app.database import get_db, init_db

    await init_db()
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*evil*','block')"
        )
        await db.commit()
    finally:
        await db.close()

    def fake_resolve(**kwargs):
        return FieldAvailability(
            mode="UNKNOWN",
            es_online=False,
            fields={name: UNKNOWN for name in am._FIELD_RESOLVERS},
        )

    monkeypatch.setattr(am, "resolve_availability", fake_resolve)
    result = await am.map_host("10.0.0.1", 1440)

    assert result.techniques == []
    assert "UNKNOWN" in result.summary
    assert result.es_online is False


async def test_map_host_collapsed_withholds_domain_gated_techniques(monkeypatch):
    """Full path in COLLAPSED: only baseline-field techniques may be emitted.

    Stubs ``es_client`` so the real aggregation runs. The documents carry only
    the six baseline fields (as a COLLAPSED deployment's would), so byte- and
    domain-gated techniques must be suppressed, and the byte total must be the
    duration proxy rather than a fabricated count.
    """
    from datetime import UTC, datetime, timedelta

    from app.database import get_db, init_db

    await init_db()
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*evil*','block')"
        )
        await db.commit()
    finally:
        await db.close()

    now = datetime.now(UTC)
    hits = [
        {
            "_source": {
                "@timestamp": (now - timedelta(minutes=i)).isoformat(),
                "url": f"http://evil.example/{i}",
                "client_ip": "10.0.0.1",
                "server_ip": f"10.9.9.{i % 5}",
                "duration_seconds": 2,
                "action": "ALLOW",
            }
        }
        for i in range(300)
    ]

    class _FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": hits}}

        async def close(self):
            return None

    class _Ctx:
        async def __aenter__(self):
            return _FakeES()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(am, "es_client", lambda *a, **k: _Ctx())
    monkeypatch.setattr(
        am,
        "resolve_availability",
        lambda **kw: resolve_availability(
            mode="COLLAPSED",
            inventory_names=_COLLAPSED_FIELDS,
            es_online=True,
        ),
    )

    result = await am.map_host("10.0.0.1", 1440)
    emitted = {t.technique_id for t in result.techniques}

    # Nothing that needs domain/bytes-* fields.
    for gated in ("T1567", "T1567.002", "T1114.002", "T1583.001"):
        assert gated not in emitted, f"{gated} must be withheld in COLLAPSED"
    # Byte accounting says where its number came from.
    assert result.signals.bytes_source == "duration-proxy"
    assert result.signals.total_bytes and result.signals.total_bytes > 0
    # The suppression reasons are surfaced in the summary for the operator.
    assert "suppressed" in result.summary


# ── §c.3 periodicity ────────────────────────────────────────────────────────


def test_slot_concentration_detects_lockstep_schedule():
    """A request every 30 minutes for 24h concentrates into one 5-min phase."""
    start = datetime(2026, 1, 1, tzinfo=UTC)
    timeline = []
    for i in range(48):
        bucket = (start + timedelta(minutes=30 * i)).isoformat()
        timeline.append({"bucket": bucket, "count": 16})
    score = _slot_concentration(timeline)
    assert score is not None
    # Every 30 min = phase 0 or 6 => one of two phases holds ~everything.
    assert score >= 0.5


def test_slot_concentration_is_low_for_evenly_spread_load():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    timeline = [
        {"bucket": (start + timedelta(minutes=5 * i)).isoformat(), "count": 16}
        for i in range(288)
    ]
    score = _slot_concentration(timeline)
    assert score is not None
    assert score < 0.3


def test_slot_concentration_returns_none_when_unstable():
    """One bucket is not evidence of a schedule — None, not a false negative."""
    assert _slot_concentration([{"bucket": "2026-01-01T00:00:00+00:00", "count": 9}]) is None
    assert _slot_concentration([]) is None


def test_interval_cv_requires_enough_samples():
    """Fewer than 10 intervals => None (UNKNOWN), never a fabricated 0.0."""
    start = datetime(2026, 1, 1, tzinfo=UTC)
    few = [start + timedelta(minutes=5 * i) for i in range(5)]
    assert _interval_cv(__import__("pandas").Series(few)) is None


def test_interval_cv_low_for_regular_and_high_for_jitter():
    import pandas as pd

    start = datetime(2026, 1, 1, tzinfo=UTC)
    regular = [start + timedelta(hours=i) for i in range(20)]
    cv_regular = _interval_cv(pd.Series(regular))
    assert cv_regular is not None and cv_regular < 0.01

    jitter = [
        start + timedelta(hours=i, minutes=(i * 37) % 120) for i in range(20)
    ]
    cv_jitter = _interval_cv(pd.Series(jitter))
    assert cv_jitter is not None and cv_jitter > cv_regular


def test_legacy_dispersion_formula_is_gone():
    """The unsound `1 - std/mean` score is deleted, not merely bypassed.

    A formula kept "for the coarse cases" gets reused for the coarse cases it
    is wrong about, so the module no longer defines it at all. The value
    assertions that used to live here were toothless (they only checked
    ``is not None``); the statistics' real behaviour is pinned by the tests
    below.
    """
    assert not hasattr(am, "_periodicity_score")


def _timeline_from_stamps(stamps, width_min=5):
    """Bucket *stamps* into a build_timeline-shaped list (zero-filled)."""
    import pandas as pd

    s = pd.to_datetime(pd.Series(stamps), utc=True).sort_values()
    floored = s.dt.floor(f"{width_min}min")
    counts = floored.value_counts().sort_index()
    full = pd.date_range(
        counts.index.min(), counts.index.max(), freq=f"{width_min}min"
    )
    counts = counts.reindex(full, fill_value=0)
    return [
        {"bucket": idx.isoformat(), "count": int(c)} for idx, c in counts.items()
    ]


def test_slot_concentration_sees_a_coarse_lockstep_not_a_fast_beat():
    """The shipped slot statistic discriminates only coarse lockstep.

    This is the aliasing case, pinned so it cannot silently drift: on a 24 h
    window the data is bucketed every 30 min, so a 1-minute heartbeat and a
    30-minute lockstep present identically (and identically to uniform load).
    Only the 1-hour lockstep separates.
    """
    start = datetime(2026, 1, 1, tzinfo=UTC)

    heartbeat = _timeline_from_stamps(
        [start + timedelta(minutes=i) for i in range(1440)], width_min=30
    )
    lockstep_30 = _timeline_from_stamps(
        [start + timedelta(minutes=30 * i) for i in range(48)], width_min=30
    )
    lockstep_60 = _timeline_from_stamps(
        [start + timedelta(minutes=60 * i) for i in range(24)], width_min=30
    )

    fast = _slot_concentration(heartbeat)
    coarse = _slot_concentration(lockstep_30)
    hourly = _slot_concentration(lockstep_60)

    # The documented limitation: fast beat == 30-min lockstep == uniform 0.5.
    assert fast == 0.5
    assert coarse == 0.5
    # Only the 1-hour cadence actually separates.
    assert hourly == 1.0


def test_interval_cv_finds_a_one_minute_heartbeat():
    """The load-bearing detector: a 1-min beat scores far below the 0.35 gate."""
    import pandas as pd

    start = datetime(2026, 1, 1, tzinfo=UTC)
    beat = [start + timedelta(minutes=i) for i in range(1440)]
    cv = _interval_cv(pd.Series(beat))
    assert cv is not None
    assert cv <= 0.35, f"a perfect 1-min heartbeat scored {cv}"


def test_interval_cv_rejects_a_one_minute_poisson_load():
    """A uniform (Poisson) load at the SAME ~1/min rate must not pass the gate."""
    import random

    from datetime import timedelta as _td

    rng = random.Random(7)
    t = datetime(2026, 1, 1, tzinfo=UTC)
    arrivals = [t]
    for _ in range(1439):
        arrivals.append(
            arrivals[-1] + _td(seconds=rng.expovariate(1 / 60.0))
        )
    import pandas as pd

    cv = _interval_cv(pd.Series(arrivals))
    assert cv is not None
    assert cv > 0.35, f"Poisson load scored {cv}, which the gate would accept"


def test_interval_cv_aliasing_regression():
    """Regression guard: a jittered beat must stay below a uniform load.

    The deleted burst-merge inverted exactly this comparison (a jittered beat
    scored ~0.005 while Poisson noise scored ~0.014). Assert the ordering
    explicitly so a reinstated merge fails loudly.
    """
    import random

    from datetime import timedelta as _td

    import pandas as pd

    start = datetime(2026, 1, 1, tzinfo=UTC)
    rng = random.Random(3)
    jittered = pd.Series(
        [
            start + _td(minutes=i) + _td(seconds=rng.gauss(0, 12))
            for i in range(1440)
        ]
    )
    load_t = datetime(2026, 1, 1, tzinfo=UTC)
    arrivals = [load_t]
    for _ in range(1439):
        arrivals.append(arrivals[-1] + _td(seconds=rng.expovariate(1 / 60.0)))

    beat_cv = _interval_cv(jittered)
    load_cv = _interval_cv(pd.Series(arrivals))
    assert beat_cv is not None and load_cv is not None
    assert beat_cv < load_cv
    assert beat_cv <= 0.35 < load_cv


# ── §e gate mechanics (the paths that have silently swallowed bugs) ──────────


def test_evaluate_converts_crash_to_named_reason():
    """A heuristic that raises must become a suppression, never a 500.

    This path once swallowed a real KeyError: a predicate read a field the
    catalogue never declared, the exception was caught here, and the technique
    simply vanished with a generic reason. Pin the exact reason string so a
    regression is visible rather than silent.
    """
    def _boom(sig):
        raise KeyError("field not in catalogue")

    avail = _avail("UC-A", _UC_A_FIELDS)
    sig = _sig(_UC_A_FIELDS, mode="UC-A", total_requests=100)

    tech, reason = am._evaluate(avail, "T1071.001", am._HOST_HEURISTICS, _boom, sig)

    assert tech is None
    assert reason == {"id": "T1071.001", "reason": "predicate failed: KeyError"}


def test_gate_reason_shape():
    """The operator-facing reason must name what is missing and what is present.

    Both gate branches are pinned: the ``required`` branch names each missing
    field, the ``required_any`` branch says "none present". A generic
    ``"blocked"`` reason would satisfy a truthiness check — it must not pass.
    """
    collapsed = _avail("COLLAPSED", _COLLAPSED_FIELDS)

    # required_any branch
    any_reason = am._gate(collapsed, "T1567", am._HOST_HEURISTICS)
    assert any_reason is not None
    assert any_reason.startswith("requires any of ")
    assert "none present (present: " in any_reason
    assert "bytes_downloaded" in any_reason

    # required branch — use a synthetic catalogue entry so the test pins the
    # gate's message, not a specific technique's requirement list.
    req_reason = am._gate(
        collapsed,
        "T9999",
        {"T9999": {"required": ("domain",), "optional": ()}},
    )
    assert req_reason is not None
    assert req_reason.startswith("requires domain; missing domain")
    assert "(present: " in req_reason
    assert len(req_reason) > 30


def test_sum_column_all_empty_is_none():
    """apply_filters fabricates "" for absent fields; summing must say UNKNOWN.

    This is the anti-fabrication mechanism: an all-"" column is NOT a count of
    zero — it is "not measured", and returning 0 would let a byte-gated
    technique fire on a projection that carries no byte field at all.
    """
    import pandas as pd

    df = pd.DataFrame({"bytes_downloaded": ["", "", ""]})
    assert am._sum_column(df, "bytes_downloaded") is None
    # A missing column is likewise None, not 0.
    assert am._sum_column(pd.DataFrame({"x": [1]}), "bytes_downloaded") is None
    # A genuine zero column IS a real 0.
    assert am._sum_column(pd.DataFrame({"bytes_downloaded": [0, 0]}), "bytes_downloaded") == 0


def test_base_url_is_never_gated():
    """base_url is derived (recomputed from url), so it must not be a resolved field."""
    assert "base_url" not in am._FIELD_RESOLVERS


def test_unknown_mode_marks_field_inventory_unknown():
    """The data_sources badge must read field_inventory:unknown when unresolvable."""
    avail = _avail("UNKNOWN", set())
    assert avail.mode == "UNKNOWN"
    for state in avail.fields.values():
        assert state == UNKNOWN


def test_downgrade_only_field_is_not_charged():
    """An absent `category` is a per-document blank, not a missing evidence leg."""
    avail = _avail("UC-A", _UC_A_FIELDS - {"category"})
    assert am._optional_missing(avail, ("category",)) == []


@pytest.mark.parametrize(
    "mode,names,technique_id,eligible",
    [
        # §b.2 — UC-A/UC-B: everything eligible given its fields.
        ("UC-A", _UC_A_FIELDS, "T1071.001", True),
        ("UC-A", _UC_A_FIELDS, "T1583.001", True),
        ("UC-A", _UC_A_FIELDS, "T1567", True),
        ("UC-A", _UC_A_FIELDS, "T1567.002", True),
        ("UC-B", _UC_B_FIELDS, "T1071.001", True),
        ("UC-B", _UC_B_FIELDS, "T1567", True),
        # COLLAPSED: an optional-field technique whose *gate* requirement is
        # met still passes the door (its predicate may still decline).
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1071.001", True),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1090.003", True),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1078", True),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1583.003", True),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1204.002", True),
        # … and byte/rule-gated ones are withheld. T1041/T1029.001 have no
        # ``required`` leg, so they are gate-eligible via duration_seconds —
        # their byte leg is enforced inside the predicate, not the gate.
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1029.001", True),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1041", True),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1567", False),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1567.002", False),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1114.002", False),
    ],
)
def test_technique_eligibility_per_mode(mode, names, technique_id, eligible):
    """§b.2's table, as executable cells — an inverted gate fails here.

    Today's positive cells are asserted nowhere else, so a gate that flipped
    would silently delete techniques and every other test would still pass.
    """
    avail = _avail(mode, names)
    reason = am._gate(avail, technique_id, am._HOST_HEURISTICS)
    assert (reason is None) is eligible, (
        f"{technique_id} in {mode}: expected eligible={eligible}, gate said {reason!r}"
    )


def test_url_catalogue_byte_gate():
    """T1105 (URL) needs a byte field; without one the gate withholds it."""
    # A URL view with no byte-capable field present.
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    reason = am._gate(avail, "T1105", am._URL_HEURISTICS)
    assert reason is not None
    assert "download_bytes" in reason or "bytes" in reason

    # With bytes present (UC-A inventory) it is eligible.
    avail_full = _avail("UC-A", _UC_A_FIELDS)
    assert am._gate(avail_full, "T1105", am._URL_HEURISTICS) is None
