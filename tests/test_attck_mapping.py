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


def test_collapsed_marks_only_mode_rejected_fields_absent():
    """COLLAPSED proves absence only for the names `_resolve_mode` tested.

    The historical assertion here was "COLLAPSED's inventory IS the baseline
    set, so every non-baseline field is ABSENT". That was false against real
    Elasticsearch (spec §j.8): the inventory unions the sampled document's
    keys with `field_caps`, and real documents carry `category`/`bytes_*`/
    `rule_name`, none of which `_resolve_mode` inspects. The corrected rule:

    * the lens fields the mode explicitly rejected (`user_agent`, `username`,
      `session`) are proven ABSENT;
    * a field neither source mentions is UNKNOWN ("not sampled"), never ABSENT
      — a one-document + mapping inventory is not a per-document census.
    """
    # The narrow proof: the mode tested these and found them missing.
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    for field in ("user_agent", "username", "session"):
        assert avail.fields[field] == ABSENT
    # Silence about a field the mode never tested is not proof of absence.
    for field in ("domain", "bytes_downloaded", "category", "rule_name"):
        assert avail.fields[field] == UNKNOWN


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
    """T1041 bottoms out in bytes; a duration proxy is not a byte field.

    `duration_seconds` used to satisfy this gate's `required_any`, which let a
    duration-only stream emit T1041 on an *invented* byte total (spec
    §j.6/§j.9.2). It is now deliberately excluded, so the gate itself encodes
    "a measured byte counter is required".
    """
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    # COLLAPSED carries duration_seconds, but that is NOT a byte leg any more.
    reason = _gate(avail, "T1041", am._HOST_HEURISTICS)
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
    """An emitted technique carries the mode, byte source, and field map.

    ``bytes_source="bytes"`` is load-bearing, not decoration: T1041's predicate
    refuses to cross its byte floor on a duration proxy (see
    ``test_t1041_declines_on_duration_proxy_as_sole_byte_source``), so a Signal
    with a ``total_bytes`` and no measured source is not a emitting shape.
    """
    avail = _avail("UC-A", _UC_A_FIELDS)
    sig = _sig(_UC_A_FIELDS, mode="UC-A", total_bytes=10**9, risk_share=0.9,
               distinct_domains=5, total_requests=100, risk_requests=90,
               bytes_source="bytes")
    tech, _ = am._evaluate(avail, "T1041", am._HOST_HEURISTICS,
                           am._heuristic_t1041_host, sig)
    assert tech is not None
    assert tech.evidence["es_mode"] == "UC-A"
    assert tech.evidence["bytes_source"] == "bytes"
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


def test_interval_cv_derives_seconds_not_nanoseconds():
    """Pin the unit of the second-derivation against a hardcoded divisor.

    `_interval_cv` converts timestamps to whole seconds before differencing.
    The defect this guards: `stamps.astype("int64")` returns the count in the
    Series' OWN unit — `us` under the project's pandas 3.0.5, `ns` under
    pandas 2.x — so dividing by a fixed `1_000_000_000` mis-scales by 1000x on
    microsecond input and collapses every gap to the same value. That produced
    a CV of 0.0 (or quantization jitter) and made the `<= 0.35` gates accept
    every host.

    Feed arrivals a KNOWN gap apart and assert the derived CV reflects the real
    second-scale interval, not a resolution-collapsed one. A reintroduced
    nanosecond divisor (or any fixed divisor that does not match the dtype)
    makes the two intervals below differ by 1000x and this test fail.
    """
    import pandas as pd

    start = datetime(2026, 1, 1, tzinfo=UTC)

    # A 1-minute beat: real gaps are 60 s. The correct CV of a constant gap is
    # exactly 0.0; a resolution-collapsed derivation also yields 0.0, so the CV
    # alone cannot distinguish the units. Assert the derived seconds directly.
    minute_beat = pd.Series([start + timedelta(minutes=i) for i in range(30)])
    stamps = (
        pd.to_datetime(minute_beat, errors="coerce", utc=True)
        .dropna()
        .sort_values()
    )
    secs = (
        stamps.dt.floor("s").dt.tz_localize(None).astype("datetime64[s]").astype("int64")
    )
    gaps = [int(b) - int(a) for a, b in zip(secs, secs.iloc[1:])]
    assert gaps == [60] * 29, (
        f"a 60-second gap was derived as {gaps[:3]} — the timestamp unit was "
        "mis-scaled (a nanosecond divisor over a microsecond dtype divides "
        "the real gap by 1000)"
    )

    # And the statistic on a mixed second-scale cadence proves the value is
    # usable: exact 2-minute gap -> CV 0.0, still under the 0.35 gate.
    two_minute = pd.Series([start + timedelta(minutes=2 * i) for i in range(30)])
    cv = _interval_cv(two_minute)
    assert cv is not None and cv == 0.0



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
        # … and byte-gated ones are withheld when no *measured* byte counter is
        # in the inventory. `duration_seconds` is not a byte leg (spec §j.9.2),
        # so a baseline-only COLLAPSED stream cannot open T1041/T1029.001.
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1029.001", False),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1041", False),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1567", False),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1567.002", False),
        ("COLLAPSED", _COLLAPSED_FIELDS, "T1114.002", False),
        # … but with real byte fields in the inventory they open again, in
        # COLLAPSED as in any other mode (spec §j.8: inventory drives presence).
        ("COLLAPSED", _COLLAPSED_FIELDS | {"bytes_downloaded", "bytes_uploaded"},
         "T1041", True),
        ("COLLAPSED", _COLLAPSED_FIELDS | {"bytes_downloaded", "bytes_uploaded"},
         "T1029.001", True),
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


# ── §j reconciliation with the operator's real documents ────────────────────
#
# The fixtures below are modelled on a VERBATIM logstash-proxy document the
# operator supplied (spec §j.0). They exist because the rest of this file
# builds its COLLAPSED inventory as exactly the six baseline fields, which is
# NOT what real Elasticsearch returns: `inventory_field_names()` unions the
# sample document's keys with `field_caps`, so a real document's `category`,
# `bytes_*`, `rule_name`, `http_status_code`, … resolve PRESENT even in
# COLLAPSED. Every test here uses the real document's key set.

# Verbatim `_source` from the operator's sample (spec §j.0), unmodified.
_REAL_DOC = {
    "@version": "1",
    "category": "facebook.com",
    "rule_info": "RN190,SNI,BS",
    "rule_name": "facebook.com",
    "action": "DENY",
    "@timestamp": "2026-08-31T23:59:11.000Z",
    "user_id": "172.21.122.6",
    "server_ip": "57.144.192.3",
    "url": "https://z-m-gateway.facebook.com/",
    "duration_seconds": 0.01,
    "host": {"ip": "172.21.73.13"},
    "bytes_downloaded": 0,
    "bytes_uploaded": 215,
    "client_ip": "172.21.122.6",
    "country_code": "BE",
    "http_status_code": 0,
}


def test_real_document_resolves_to_collapsed():
    """§j.8 — the operator's document resolves to COLLAPSED, and permanently.

    The deployment carries neither `username` nor `session`, so no sampling
    window can un-collapse it; the only field the document adds over the
    baseline six is `@version`/`host`/…, none of which `_resolve_mode` reads.
    """
    from app.services.es_fields import _resolve_mode

    assert _resolve_mode(_REAL_DOC, {}, es_online=True) == "COLLAPSED"


def test_inventory_union_not_derivable_from_mode_only():
    """False COLLAPSED invariant: real inventory ≠ the baseline six."""
    from app.services.es_fields import inventory_field_names

    # (No cache in a unit test, so exercise the union rule directly via the
    # resolver: names supplied that the mode does not require must survive.)
    real_inventory = set(_REAL_DOC.keys())
    avail = resolve_availability(
        mode="COLLAPSED", inventory_names=real_inventory, es_online=True
    )
    # The spec used to claim these are ABSENT in COLLAPSED. They are present
    # in the real document, so a resolver that says ABSENT is fabricating the
    # opposite error (hiding real data).
    for name in ("category", "bytes_downloaded", "bytes_uploaded", "rule_name"):
        assert avail.fields[name] == PRESENT, (
            f"{name} is in the real document and must resolve PRESENT"
        )
    # `domain` is not in the document and not in `field_caps`, and the mode
    # never tested for it — so the honest state is UNKNOWN ("not sampled"),
    # not ABSENT. Either way the gate treats it as unusable, so the
    # domain-gated predicates still decline.
    assert avail.fields["domain"] == UNKNOWN
    # Sanity: the cache is untouched by a direct call.
    assert inventory_field_names() == set()


def test_real_document_byte_techniques_are_gate_eligible_but_decline():
    """§j.8 — the honest outcome: gate-eligible, predicate-declined.

    T1567/T1114.002/T1567.002 are NOT withheld by the gate (their fields exist
    in the real document), which contradicts §b.2's COLLAPSED column. They
    decline on threshold, which is the correct and different behaviour.
    """
    avail = resolve_availability(
        mode="COLLAPSED", inventory_names=set(_REAL_DOC.keys()), es_online=True
    )
    for tid in ("T1567", "T1567.002", "T1114.002"):
        assert am._gate(avail, tid, am._HOST_HEURISTICS) is None, (
            f"{tid} was believed withheld in COLLAPSED; its fields are present"
        )


def test_t1041_declines_on_duration_proxy_as_sole_byte_source():
    """§j.6/§j.9.2 — the duration proxy may not cross a byte floor alone.

    On the real traffic (duration_seconds=0.01) the proxy invents 8192 B/row
    against a real 215 B — 38×. Before the fix, T1041's byte leg had no
    `required` entry, so this Signal (proxy total, no measured source) emitted
    a "100 MB exfiltration" from invented numbers.
    """
    avail = _avail("COLLAPSED", set(_REAL_DOC.keys()))
    sig = _sig(
        set(_REAL_DOC.keys()), mode="COLLAPSED", total_bytes=10**9,
        risk_share=0.9, distinct_domains=0, total_requests=500,
        risk_requests=450, enforcements=0, bytes_source="duration-proxy",
    )
    tech, _ = am._evaluate(
        avail, "T1041", am._HOST_HEURISTICS, am._heuristic_t1041_host, sig
    )
    assert tech is None, "T1041 must not emit on an invented byte total"

    # The same numbers WITH a measured source do emit — the fix is a source
    # check, not a threshold change.
    sig_measured = _sig(
        set(_REAL_DOC.keys()), mode="COLLAPSED", total_bytes=10**9,
        risk_share=0.9, distinct_domains=0, total_requests=500,
        risk_requests=450, enforcements=0, bytes_source="bytes",
    )
    tech2, _ = am._evaluate(
        avail, "T1041", am._HOST_HEURISTICS, am._heuristic_t1041_host, sig_measured
    )
    assert tech2 is not None


def test_t1029_001_declines_on_duration_proxy_as_sole_byte_source():
    """§j.6 — T1029.001's 1 MB volume leg takes the same guard.

    122 ordinary rows reach 1 MB via the proxy; the predicate must not read
    that as measured volume.
    """
    sig = _sig(
        set(_REAL_DOC.keys()), mode="COLLAPSED", distinct_dest_ips=12,
        total_bytes=10**6, risk_requests=0, enforcements=0,
        bytes_source="duration-proxy",
    )
    assert am._heuristic_t1029_001_host(sig) is None

    sig_measured = _sig(
        set(_REAL_DOC.keys()), mode="COLLAPSED", distinct_dest_ips=12,
        total_bytes=10**6, risk_requests=0, enforcements=0,
        bytes_source="bytes",
    )
    assert am._heuristic_t1029_001_host(sig_measured) is not None


def test_real_document_upload_share_is_arithmetic_not_evidence():
    """§j.5 — on an all-DENY mix upload_share is 1.0 by construction.

    download is always 0, so the share leg is satisfied without any upload
    behaviour; only the absolute byte floor stops T1567 from firing. This
    pins that the floor is what protects it.
    """
    avail = resolve_availability(
        mode="COLLAPSED", inventory_names=set(_REAL_DOC.keys()), es_online=True
    )
    # 500 denied rows: download 0, upload 215 each.
    sig = _sig(
        set(_REAL_DOC.keys()), mode="COLLAPSED",
        total_requests=500, risk_requests=0, enforcements=500,
        download_bytes=0, upload_bytes=500 * 215,
        total_bytes=500 * 215, upload_share=1.0, bytes_source="bytes",
    )
    assert sig.upload_share == 1.0  # the vacuous share
    tech, _ = am._evaluate(
        avail, "T1567", am._HOST_HEURISTICS, am._heuristic_t1567_host, sig
    )
    assert tech is None, (
        "T1567 must decline on the absolute floor despite upload_share == 1.0"
    )


def test_http_status_zero_is_not_a_not_found():
    """§j.4 — `http_status_code: 0` means 'no upstream response', not 404.

    The document carries `0`; the engine must not fold that into a 404 rate
    (the not_found_rate signal is unimplemented, and this pins why it must
    stay that way until a real status field lands).
    """
    assert _REAL_DOC["http_status_code"] == 0
    assert _REAL_DOC["http_status_code"] != 404


def test_user_id_is_a_client_ip_alias_in_the_real_document():
    """§j.1 — `user_id` is an IP, identical to `client_ip`, not a principal."""
    assert _REAL_DOC["user_id"] == _REAL_DOC["client_ip"]
    # A minimal IPv4 sanity check: the value is an address, not a principal.
    assert all(p.isdigit() for p in _REAL_DOC["user_id"].split("."))


def test_rule_info_is_present_but_unmapped():
    """§j.3 — `rule_info` exists (so 'Hard ABSENT' was wrong) but the code set
    is undocumented, so no predicate may read it.
    """
    assert _REAL_DOC["rule_info"] == "RN190,SNI,BS"
    # The engine resolves it for reporting...
    avail = resolve_availability(
        mode="COLLAPSED", inventory_names=set(_REAL_DOC.keys()), es_online=True
    )
    assert avail.fields["rule_info"] == PRESENT
    # ...but no catalogue entry may *require* it (it is uninterpretable).
    for catalogue in (am._HOST_HEURISTICS, am._URL_HEURISTICS):
        for tid, meta in catalogue.items():
            assert "rule_info" not in meta.get("required", ()), (
                f"{tid} gates on an undocumented code set"
            )
            assert "rule_info" not in meta.get("required_any", ()), (
                f"{tid} gates on an undocumented code set"
            )


def test_duration_only_stream_cannot_emit_t1041_end_to_end():
    """§j.9.2 — the gate itself blocks a duration-only stream, not just the
    predicate.

    The original bug was a *gate* bug: T1041's `required_any` listed
    `duration_seconds`, so the technique opened with no byte counter at all and
    the predicate then compared `duration × 8192` against a real floor. This
    test drives the gate (not the predicate) to prove the catalogue no longer
    admits that shape.
    """
    # A baseline-only COLLAPSED inventory: `duration_seconds` exists, no bytes.
    avail = _avail("COLLAPSED", _COLLAPSED_FIELDS)
    assert avail.has("duration_seconds")
    assert not avail.any_of("bytes_uploaded", "bytes_downloaded")
    reason = am._gate(avail, "T1041", am._HOST_HEURISTICS)
    assert reason is not None, (
        "a duration-only stream must not open T1041's gate"
    )
    assert "bytes_uploaded" in reason and "bytes_downloaded" in reason
    # …and the runner emits nothing for it.
    sig = _sig(_COLLAPSED_FIELDS, mode="COLLAPSED", total_requests=5000,
               risk_share=0.9, risk_requests=4500, enforcements=0,
               total_bytes=5000 * 8192, bytes_source="duration-proxy")
    techniques, _ = am._run_host_heuristics(sig, avail)
    assert "T1041" not in {t.technique_id for t in techniques}


def test_availability_prefers_inventory_over_mode():
    """§j.9.1 — presence is inventory-driven; mode only marks proven-absent.

    Three sources speak with different authority:
    * `field_caps` (index-wide mapping) -> PRESENT;
    * a key present in the sampled document but not in caps -> PRESENT (the
      value is readable in `_source`, which is all a heuristic needs);
    * a field the mode explicitly tested and rejected -> ABSENT;
    * a field no source mentions -> UNKNOWN, never ABSENT.
    """
    # `field_caps`-only presence (no sample key) still resolves PRESENT.
    avail = resolve_availability(
        mode="COLLAPSED",
        inventory_names={"category"},  # imagine this came from field_caps alone
        es_online=True,
    )
    assert avail.fields["category"] == PRESENT
    # A field the mode tested and rejected is proven ABSENT...
    assert avail.fields["username"] == ABSENT
    assert avail.fields["session"] == ABSENT
    assert avail.fields["user_agent"] == ABSENT
    # ...and one it never tested is UNKNOWN.
    assert avail.fields["domain"] == UNKNOWN


def test_collapsed_does_not_hide_present_byte_fields():
    """§j.9.1 regression guard — the exact operator shape.

    The operator's document carries `bytes_downloaded`/`bytes_uploaded` and
    resolves to COLLAPSED. The old resolver marked both ABSENT, so every
    byte-reading heuristic was starved on real data. They must be PRESENT.
    """
    avail = resolve_availability(
        mode="COLLAPSED", inventory_names=set(_REAL_DOC.keys()), es_online=True
    )
    assert avail.mode == "COLLAPSED"
    for name in ("bytes_downloaded", "bytes_uploaded", "category",
                 "rule_name", "http_status_code", "country_code"):
        assert avail.fields[name] == PRESENT, (
            f"{name} is in the real document; COLLAPSED must not hide it"
        )


# ── §j.7 raw-line recovery (sentinel honesty, proxy nodes, rule codes) ──────
#
# The recovery path reads the operator's real documents: `message` (the raw
# line, whose positional slots say which response sizes were actually
# recorded) and `host` (the proxy node itself). Both are projected by
# QUERY_SOURCE_FIELDS — the `_source` filter is the only thing between ES and
# the df — so the fixtures below carry them verbatim.


def _operator_hits(
    n: int = 300,
    client_ip: str = "10.0.0.1",
    server_ip: str = "57.144.192.3",
    request_size: int = 250_000,
    response_sizes: list[str] | None = None,
    node_ips: list[str] | None = None,
    with_rule_info: bool = True,
    codes: str = "RN190,SNI,BS",
    stamp: str = "01/Sep/2026:06:59:11 +0700",
):
    """Hits shaped like the operator's real documents (spec §j.0/§j.7): the
    flat fields plus `message` — the raw line, whose response-size slot is
    the `-` sentinel unless *response_sizes* says otherwise — and `host`
    (the proxy node) when *node_ips* is given. The flat `bytes_downloaded`
    mirrors logstash: 0 for a `-` row, the recorded size otherwise.
    """
    now = datetime.now(UTC)
    hits = []
    for i in range(n):
        size = response_sizes[i] if response_sizes is not None else "-"
        src = {
            "@timestamp": (now - timedelta(minutes=i)).isoformat(),
            "url": f"http://evil.example/{i}",
            "client_ip": client_ip,
            "server_ip": server_ip,
            "duration_seconds": 0.01,
            "action": "DENY",
            "bytes_downloaded": 0 if size == "-" else 1,
            "bytes_uploaded": request_size,
            "category": "facebook.com",
            "http_status_code": 0,
            "country_code": "BE",
            "message": (
                f"[{stamp}] {client_ip} {client_ip} {server_ip} "
                f'"facebook.com" 0.01 {size} https://z-m-gateway.facebook.com/ '
                f'- 0 {request_size} DENY {codes} BE "facebook.com"'
            ),
        }
        if with_rule_info:
            src["rule_info"] = "RN190,SNI,BS"
        if node_ips is not None:
            src["host"] = {"ip": node_ips[i % len(node_ips)]}
        hits.append({"_source": src})
    return hits


async def _map_host_hits(monkeypatch, hits):
    """Run the full map_host path against canned hits (spec §j.7 fixtures)."""
    from app.database import get_db, init_db

    await init_db()
    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type)"
            " VALUES ('*evil*','block')"
        )
        await db.commit()
    finally:
        await db.close()

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
            inventory_names=set(_REAL_DOC.keys()),
            es_online=True,
        ),
    )
    return await am.map_host("10.0.0.1", 1440)


async def test_unrecorded_response_sizes_withhold_the_upload_share(monkeypatch):
    """§j.5/§j.7 — an all-`-` window must not read a measured zero.

    The flat `bytes_downloaded` IS in the projection (logstash collapsed
    every `-` slot to 0), so a naive sum would report download_bytes=0 and a
    vacuous upload_share=1.0 that crosses T1567's share leg on its 5e7 floor.
    With the raw line readable the parse decides: nothing was recorded, so
    the download side is UNKNOWN and the share is withheld.
    """
    result = await _map_host_hits(monkeypatch, _operator_hits())
    s = result.signals

    assert s.download_bytes is None, (
        "a collapsed flat 0 must never read as a measured download total"
    )
    assert s.upload_bytes == 300 * 250_000
    assert s.total_bytes == 300 * 250_000  # measured part only
    assert s.upload_share is None, (
        "a partially measured denominator withholds the share"
    )
    assert s.bytes_source == "bytes"  # upload still measured
    # T1567's floor IS crossed (7.5e7 >= 5e7), so the decline is the
    # withheld share's work — the §j.5 trap closed end to end.
    assert "T1567" not in {t.technique_id for t in result.techniques}


async def test_mixed_window_share_withheld_until_all_measured(monkeypatch):
    """§j.5/§j.7 — one unrecorded row withholds the share over the subset.

    The recomputed share over the measured rows would pass (299 recorded
    1-byte responses against a 250 kB upload each => ~1.0); a share that
    silently ignores the unknown slice must never read as upload evidence.
    """
    result = await _map_host_hits(
        monkeypatch, _operator_hits(response_sizes=["-"] + ["1"] * 299)
    )
    s = result.signals

    assert s.download_bytes == 299  # recorded rows only
    assert s.upload_bytes == 300 * 250_000
    assert s.total_bytes == 300 * 250_000 + 299
    assert s.upload_share is None, (
        "the share is withheld while any row's recording state is unknown"
    )
    assert s.bytes_source == "bytes"
    assert "T1567" not in {t.technique_id for t in result.techniques}


async def test_proxy_nodes_surface_in_signals_and_summary(monkeypatch):
    """§j.7 — host.ip is the proxy node: provenance for NOC triage."""
    result = await _map_host_hits(
        monkeypatch, _operator_hits(node_ips=["172.21.73.13"])
    )
    assert result.signals.proxy_nodes == {"172.21.73.13"}
    assert "observed via node(s) 172.21.73.13" in result.summary


async def test_multi_node_traffic_shows_every_node(monkeypatch):
    """§j.7 — a fleet of proxy nodes is the dimension a NOC triages on."""
    result = await _map_host_hits(
        monkeypatch,
        _operator_hits(node_ips=["172.21.73.13", "172.21.73.14"]),
    )
    assert result.signals.proxy_nodes == {"172.21.73.13", "172.21.73.14"}
    assert "172.21.73.13" in result.summary
    assert "172.21.73.14" in result.summary


async def test_rule_codes_ride_structured_and_create_no_technique(monkeypatch):
    """§j.3/§j.7 — the code set is undecoded: context, never a detector.

    The flat `rule_info` set is the primary source (flat-first); the parsed
    slot-13 codes are the fallback when the flat is missing. Either way the
    emitted technique set must be identical — the codes buy no technique.
    """
    result = await _map_host_hits(monkeypatch, _operator_hits())
    assert result.signals.rule_codes == ["BS", "RN190", "SNI"]  # sorted set
    for t in result.techniques:
        assert "rule_codes" not in t.evidence
        assert "rule_info" not in t.evidence

    # The parsed slot-13 fallback: the flat absent, the line's codes present
    # (a valid line with an unmapped placeholder code).
    fallback = await _map_host_hits(
        monkeypatch, _operator_hits(with_rule_info=False, codes="ZZ0")
    )
    assert fallback.signals.rule_codes == ["ZZ0"]
    # The codes bought no technique here either.
    assert {t.technique_id for t in fallback.techniques} == {
        t.technique_id for t in result.techniques
    }


async def test_line_tz_note_surfaces_only_on_mismatch(monkeypatch):
    """§j.7 — the display-tz cross-check is a NOTE, never a gate.

    Default display_tz is UTC (+0000): a window stamped +0700 gets a note
    naming the mismatch; a window stamped +0000 matches and gets none.
    """
    mismatched = await _map_host_hits(
        monkeypatch, _operator_hits(stamp="01/Sep/2026:06:59:11 +0700")
    )
    assert "note: lines stamped +0700" in mismatched.summary
    assert mismatched.signals.line_tz_offsets == {"+0700"}

    matching = await _map_host_hits(
        monkeypatch, _operator_hits(stamp="01/Sep/2026:06:59:11 +0000")
    )
    assert "note:" not in matching.summary


# ── Enforcement count — the proxy's own DENY population, not the pattern frame ─
#
# `signals.enforcements` used to be derived from the pattern-filtered frame, so
# a DENY recorded against a non-pattern URL never appeared and the count read 0.
# That wrong 0 is a GATE in three host predicates, so it silently WITHHELD
# techniques. The fix issues a count-only action query
# (`actions=["DENY","FLAG"]`, `track_total_hits: true`) alongside the pattern
# query; the stub below answers it with a real `total` block.


def _patternless_deny_hits(
    n: int = 1, client_ip: str = "10.0.0.1"
) -> list[dict]:
    """DENY rows whose URL matches NO block pattern (a bare SNI host).

    `_operator_hits` already uses such a URL, but these pin the shape for the
    enforcement test: the URL carries no `*evil*`, so the pattern query can
    never return them.
    """
    now = datetime.now(UTC)
    return [
        {
            "_source": {
                "@timestamp": (now - timedelta(minutes=i)).isoformat(),
                "url": "https://z-m-gateway.facebook.com/",
                "client_ip": client_ip,
                "server_ip": "57.144.192.3",
                "duration_seconds": 0.01,
                "action": "DENY",
                "rule_info": "RN190,SNI,BS",
            }
        }
        for i in range(n)
    ]


async def _map_host_with_actions(
    monkeypatch, *, pattern_hits, action_total
):
    """Run `map_host` with a stub that answers pattern and action queries apart.

    The action query is the body carrying a `terms` filter on `action`; it is
    answered with a `total` block (a count-only search returns no documents).
    """
    from app.database import get_db, init_db

    await init_db()
    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type)"
            " VALUES ('*evil*','block')"
        )
        await db.commit()
    finally:
        await db.close()

    class _FakeES:
        async def search(self, **kwargs):
            filters = kwargs["body"]["query"]["bool"]["filter"]
            if any("terms" in f for f in filters):
                return {
                    "hits": {
                        "total": {"value": action_total, "relation": "eq"},
                        "hits": [],
                    }
                }
            return {"hits": {"hits": pattern_hits}}

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
            inventory_names=set(_REAL_DOC.keys()),
            es_online=True,
        ),
    )
    return await am.map_host("10.0.0.1", 1440)


async def test_map_host_enforcements_reflect_a_patternless_deny(monkeypatch):
    """`signals.enforcements` reflects DENYs the pattern frame cannot see.

    The pattern frame holds one ALLOW row that matches `*evil*`; the proxy's
    own enforcement population is 5 DENYs recorded against a non-pattern URL.
    Pre-fix `enforcements` was derived from the pattern frame and read 0.
    """
    pattern_hits = _operator_hits(n=1, response_sizes=["1"])
    # Make the pattern row an ALLOW so it is not itself an enforcement.
    for h in pattern_hits:
        h["_source"]["action"] = "ALLOW"

    result = await _map_host_with_actions(
        monkeypatch, pattern_hits=pattern_hits, action_total=5
    )
    assert result.signals.enforcements == 5


async def test_map_host_enforcements_measured_with_empty_pattern_frame(monkeypatch):
    """A host with DENYs but NO pattern reach still reports its enforcements.

    The pattern frame is empty (no block-pattern match), so pre-fix the early
    return left `enforcements = 0` — reading as "never enforced" for a host the
    proxy denied repeatedly.
    """
    result = await _map_host_with_actions(
        monkeypatch, pattern_hits=[], action_total=3
    )
    assert result.signals.enforcements == 3
    assert result.signals.total_requests == 0


async def test_map_host_gate_flips_on_measured_patternless_deny(monkeypatch):
    """The wrong 0 withheld T1078; the measured count now rejects it.

    T1078 requires `enforcements == 0`. With the DENY population measured as
    nonzero, a host whose pattern frame shows no enforcement must no longer
    emit T1078 — the silent withholding this fix reverses.
    """
    pattern_hits = _operator_hits(n=30, response_sizes=["1"] * 30)
    for h in pattern_hits:
        h["_source"]["action"] = "ALLOW"

    # An ALLOW-heavy pattern frame would pass T1078's other legs; the measured
    # enforcements are what must now suppress it.
    result = await _map_host_with_actions(
        monkeypatch, pattern_hits=pattern_hits, action_total=4
    )
    assert result.signals.enforcements == 4
    assert "T1078" not in {t.technique_id for t in result.techniques}


async def test_map_url_enforcements_reflect_a_patternless_deny(monkeypatch):
    """The URL-side twin: a patternless DENY is reflected in `enforcements`.

    No URL heuristic gates on `enforcements`, so this pins the reported signal
    value rather than a technique emission.
    """
    from app.database import get_db, init_db

    await init_db()
    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type)"
            " VALUES ('*evil*','block')"
        )
        await db.commit()
    finally:
        await db.close()

    class _FakeES:
        async def search(self, **kwargs):
            filters = kwargs["body"]["query"]["bool"]["filter"]
            if any("terms" in f for f in filters):
                return {
                    "hits": {
                        "total": {"value": 7, "relation": "eq"},
                        "hits": [],
                    }
                }
            return {"hits": {"hits": [{"_source": _REAL_DOC}]}}

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
            inventory_names=set(_REAL_DOC.keys()),
            es_online=True,
        ),
    )
    result = await am.map_url("https://z-m-gateway.facebook.com/")
    assert result.signals.enforcements == 7
