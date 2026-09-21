"""Analytics risk/enforcements reframe (ADR 0001) — regression tests.

Risk = a URL matched a block pattern, the proxy action was ALLOW, and it is
not whitelisted. Enforcements = DENY/FLAG (the proxy already handled the
request). The findings table only ever holds ALLOW rows in production, so
real enforcement counts come from live ES; the findings fallback reports
enforcements = 0.
"""

import json
from datetime import UTC, datetime, timedelta, timezone

import aiosqlite
import pytest


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _seed(client, db_path, rows, add_action_col: bool = False):
    """Insert findings rows; optionally add the extended ``action`` column first."""
    db = await aiosqlite.connect(db_path)
    if add_action_col:
        cols = {
            r[1] for r in await (await db.execute("PRAGMA table_info(findings)")).fetchall()
        }
        if "action" not in cols:
            await db.execute(
                "ALTER TABLE findings ADD COLUMN action TEXT NOT NULL DEFAULT ''"
            )
    if add_action_col:
        await db.executemany(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp,"
            " matched_patterns, action) VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    else:
        await db.executemany(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp,"
            " matched_patterns) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    await db.commit()
    await db.close()


async def test_summary_legacy_no_action_column_risks_only(client, db_path):
    """Without an action column, every block-pattern row is a risk (ADR 0001)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"])),
            ("1.1.1.1", "", "http://bad.example/b", "bad.example", _now(), json.dumps(["*bad*"])),
        ],
        add_action_col=False,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["source"] == "findings"
    assert data["totalRisk"] == 2
    assert data["totalEnforcements"] == 0
    # The legacy totalBlocked alias mirrors ENFORCEMENTS, never risk — so the
    # ADR-0001 semantic holds even for old consumers.
    assert data["totalBlocked"] == data["totalEnforcements"] == 0
    assert "enforcementsDeltaPct" in data


async def test_summary_extended_action_split(client, db_path):
    """With an action column: ALLOW = risk, DENY/FLAG = enforcement, empty action
    + matched_patterns = risk (stored as an ALLOW risk)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
            ("1.1.1.1", "", "http://bad.example/b", "bad.example", _now(), json.dumps(["*bad*"]), "DENY"),
            ("2.2.2.2", "", "http://flagged.example/c", "flagged.example", _now(), json.dumps(["*flag*"]), "FLAG"),
            ("2.2.2.2", "", "http://legacy.example/d", "legacy.example", _now(), json.dumps(["*legacy*"]), ""),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["totalRisk"] == 2  # ALLOW + empty-action legacy row
    assert data["totalEnforcements"] == 2  # DENY + FLAG
    # Legacy alias mirrors enforcements (2), NOT risk (2≠"blocked" conflate).
    assert data["totalBlocked"] == 2


async def test_enforcements_findings_fallback(client, db_path):
    """The enforcements chart still renders from the findings table (offline ES)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/enforcements?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["es_online"] is False
    assert data["source"] == "findings"
    assert data["points"]  # at least one bucket


async def test_top_enforced_endpoint(client, db_path):
    """/api/analytics/top-enforced returns enforcements + primaryRule; the
    legacy /top-denied alias maps blocks -> enforcements."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "DENY"),
            ("1.1.1.1", "", "http://bad.example/b", "bad.example", _now(), json.dumps(["*bad*"]), "ALLOW"),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/top-enforced?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["items"] == [
        {"domain": "evil.example", "count": 1, "enforcements": 1, "primaryRule": "*evil*"}
    ]

    legacy = client.get("/api/analytics/top-denied?range=7d")
    assert legacy.status_code == 200
    ldata = legacy.json()
    assert ldata["items"] == [
        {"domain": "evil.example", "count": 1, "blocks": 1, "primaryRule": "*evil*"}
    ]


async def test_top_enforced_primary_rule_empty_when_patterns_absent(client, db_path):
    """A doc with no ``matched_patterns`` must never serve the literal
    ``"matched"`` as ``primaryRule`` — that reads like a rule name.

    The operator's logstash-proxy docs carry no ``matched_patterns`` field
    (the backend default-fills it with ``""``), so the honest served value is
    empty and the UI renders an em-dash.
    """
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), "", "DENY"),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/top-enforced?range=7d")
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["primaryRule"] != "matched"
    assert items[0]["primaryRule"] == ""

    # The legacy alias serves the same honest value.
    ldata = client.get("/api/analytics/top-denied?range=7d").json()
    assert ldata["items"][0]["primaryRule"] == ""


async def test_summary_blacklisted_allow_is_additive_risk(client, db_path):
    """A blacklisted destination whose request was ALLOWed is the highest-risk
    signal: it counts in ``totalRisk`` AND as the distinct additive
    ``totalBlacklistedRisk`` (ADR 0001 semantics preserved)."""
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
        " VALUES ('url', 'evil.example')"
    )
    await db.commit()
    await db.close()

    await _seed(
        client,
        db_path,
        [
            (
                "1.1.1.1", "", "http://evil.example/a", "evil.example",
                _now(), json.dumps(["*evil*"]), "ALLOW",
            ),
            (
                "1.1.1.1", "", "http://bad.example/b", "bad.example",
                _now(), json.dumps(["*bad*"]), "ALLOW",
            ),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["source"] == "findings"
    assert data["totalRisk"] == 2  # both ALLOW rows remain risk
    assert data["totalBlacklistedRisk"] == 1  # only the blacklisted one


async def test_summary_blacklisted_risk_matches_ported_base_url(client, db_path):
    """A blacklisted destination whose ``base_url`` still carries a port counts.

    ``blacklist_domains`` is a bare-host set (``app/services/blacklist.py``
    strips the port), so ``_domain_of_base`` MUST strip it too or the two never
    meet. Pre-fix ``analytics.py``'s copy skipped the strip, so this row's
    ``base_url`` of ``evil.example:8443`` never matched ``evil.example`` and
    the card under-reported. Now it matches.
    """
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
        " VALUES ('url', 'evil.example')"
    )
    await db.commit()
    await db.close()

    await _seed(
        client,
        db_path,
        [
            (
                "1.1.1.1", "", "http://evil.example:8443/a", "evil.example:8443",
                _now(), json.dumps(["*evil*"]), "ALLOW",
            ),
        ],
        add_action_col=True,
    )

    data = client.get("/api/analytics/summary?range=7d").json()
    assert data["totalRisk"] == 1
    assert data["totalBlacklistedRisk"] == 1  # was 0 before the port strip


async def test_summary_blacklist_deny_not_risk(client, db_path):
    """A blacklisted destination that was DENYed is an enforcement, not risk —
    totalBlacklistedRisk stays 0 (the proxy already stopped it)."""
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
        " VALUES ('url', 'evil.example')"
    )
    await db.commit()
    await db.close()

    await _seed(
        client,
        db_path,
        [
            (
                "1.1.1.1", "", "http://evil.example/a", "evil.example",
                _now(), json.dumps(["*evil*"]), "DENY",
            ),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["totalRisk"] == 0
    assert data["totalBlacklistedRisk"] == 0
    assert data["totalEnforcements"] == 1


async def test_summary_accepts_1h_range(client, db_path):
    """1h range is now supported (aligned with FilterContext presets)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )
    res = client.get("/api/analytics/summary?range=1h")
    assert res.status_code == 200
    assert res.json()["range"] == "1h"


async def test_findings_list_minutes_window(client, db_path):
    """GET /findings/?minutes= narrows the raw-data window."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )
    res = client.get("/api/findings/?minutes=60")
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 1
    assert data["items"][0]["client_ip"] == "1.1.1.1"


async def test_summary_accepts_90d_and_1y_ranges(client, db_path):
    """90d/1y/3d ranges are supported (1-year Deep Dive window)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )
    for r in ("3d", "90d", "1y"):
        res = client.get(f"/api/analytics/summary?range={r}")
        assert res.status_code == 200
        assert res.json()["range"] == r


async def test_top_clients_groups_counts_and_window(client, db_path):
    """GET /api/analytics/top-clients groups findings by client_ip in-window."""
    from datetime import timedelta

    now = datetime.now(UTC)
    recent = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    old = (now - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    pats = json.dumps(["*evil*"])
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", recent, pats, "ALLOW"),
            ("1.1.1.1", "", "http://evil.example/b", "evil.example", recent, pats, "ALLOW"),
            ("2.2.2.2", "", "http://bad.example/c", "bad.example", recent, pats, "ALLOW"),
            # Outside the 7d window — must not count.
            ("9.9.9.9", "", "http://old.example/d", "old.example", old, pats, "ALLOW"),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/top-clients?range=7d&compare=previous&hostGroup=all")
    assert res.status_code == 200
    data = res.json()
    assert data["range"] == "7d"
    assert data["compare"] == "previous"
    assert data["hostGroup"] == "all"
    assert data["es_online"] is False
    assert [i["client_ip"] for i in data["items"]] == ["1.1.1.1", "2.2.2.2"]
    assert data["items"][0]["count"] == 2
    assert data["items"][1]["count"] == 1
    assert data["items"][0]["last_seen"]


async def test_top_clients_rejects_bad_range(client, db_path):
    """GET /api/analytics/top-clients 422s on an unknown range."""
    res = client.get("/api/analytics/top-clients?range=bogus")
    assert res.status_code == 422


# ── Operator timezone: day bucketing + honest time labels ─────────────────
#
# The proxy feed emits UTC. A request the operator made at local 06:59 on
# 1 September (+07:00) is ``2026-08-31T23:59:11Z`` in UTC (verified against a
# real document: the same instant carries ``[01/Sep/2026:06:59:11 +0700]`` in
# the local ``message`` field). Bucketing on the UTC date string therefore
# files it under 31 Aug — one calendar day off the operator's view.

_BOUNDARY_TS = "2026-08-31T23:59:11Z"


def _boundary_rows():
    """A single row one hour before UTC midnight (the defect's exact shape).

    Pinned to 23:59:11 **UTC** so that under +07:00 it is 06:59:11 the *next*
    local day. Only one row is seeded so the bucket set is unambiguous.
    """
    boundary = datetime.now(UTC).replace(hour=23, minute=59, second=11, microsecond=0)
    boundary_ts = boundary.strftime("%Y-%m-%dT%H:%M:%SZ")
    pats = json.dumps(["*evil*"])
    return [
        ("1.1.1.1", "", "http://evil.example/a", "evil.example", boundary_ts, pats, "ALLOW"),
    ], boundary_ts


async def test_bandwidth_buckets_by_local_day_under_configured_zone(
    client, db_path, monkeypatch
):
    """A UTC-evening request lands in the operator's *next* local day (+07:00).

    Pins that the setting actually changes behaviour, not just the code path:
    the same seeded instant buckets differently under UTC and under +07:00.
    """
    from app.config import get_settings

    rows, boundary_ts = _boundary_rows()
    await _seed(client, db_path, rows, add_action_col=True)

    # The seeded instant is deliberately one hour before UTC midnight, so its
    # local (+07:00) day is the *following* calendar date.
    assert datetime.fromisoformat(
        boundary_ts.replace("Z", "+00:00")
    ).hour == 23
    utc_day = boundary_ts[:10]
    local_day = (
        datetime.fromisoformat(boundary_ts.replace("Z", "+00:00"))
        .astimezone(timezone(timedelta(hours=7)))
        .strftime("%Y-%m-%d")
    )
    assert utc_day != local_day  # the defect only exists when these differ

    # 1) Operator zone = +07:00 → the boundary row buckets into the LOCAL day.
    monkeypatch.setenv("DISPLAY_TZ", "+07:00")
    get_settings.cache_clear()
    try:
        res = client.get("/api/analytics/bandwidth?range=7d")
        assert res.status_code == 200
        buckets = {p["bucket"] for p in res.json()["points"]}
        assert local_day in buckets
        assert utc_day not in buckets

        # 2) Operator zone = UTC → the very same row buckets into the UTC day.
        monkeypatch.setenv("DISPLAY_TZ", "UTC")
        get_settings.cache_clear()
        res = client.get("/api/analytics/bandwidth?range=7d")
        assert res.status_code == 200
        buckets = {p["bucket"] for p in res.json()["points"]}
        assert utc_day in buckets
        assert local_day not in buckets
    finally:
        get_settings.cache_clear()


async def test_enforcements_buckets_by_local_day_under_configured_zone(
    client, db_path, monkeypatch
):
    """The findings enforcements chart uses the same local-day bucketing."""
    from app.config import get_settings

    rows, boundary_ts = _boundary_rows()
    await _seed(client, db_path, rows, add_action_col=True)
    local_day = (
        datetime.fromisoformat(boundary_ts.replace("Z", "+00:00"))
        .astimezone(timezone(timedelta(hours=7)))
        .strftime("%Y-%m-%d")
    )

    monkeypatch.setenv("DISPLAY_TZ", "+07:00")
    get_settings.cache_clear()
    try:
        res = client.get("/api/analytics/enforcements?range=7d")
        assert res.status_code == 200
        assert local_day in {p["bucket"] for p in res.json()["points"]}
    finally:
        get_settings.cache_clear()


async def test_fmt_peak_uses_configured_zone_not_hardcoded_est(monkeypatch):
    """``_fmt_peak`` labels the zone it actually used — never a false ``EST``."""
    from app.config import get_settings
    from app.routes.analytics import _fmt_peak

    monkeypatch.setenv("DISPLAY_TZ", "+07:00")
    get_settings.cache_clear()
    try:
        label = _fmt_peak(_BOUNDARY_TS)
        assert "EST" not in label
        assert label.endswith("+07:00")
        # 23:59 UTC → 06:59 next day, local.
        assert "07:00" in label
        assert label.startswith("Tue")
    finally:
        get_settings.cache_clear()


async def test_fmt_peak_default_zone_is_utc_and_unparseable_passthrough(monkeypatch):
    """Default zone is UTC (honest label) and bad input is returned verbatim."""
    from app.config import get_settings
    from app.routes.analytics import _fmt_peak

    monkeypatch.delenv("DISPLAY_TZ", raising=False)
    get_settings.cache_clear()
    try:
        assert _fmt_peak(_BOUNDARY_TS) == "Mon 23:59 UTC"
        assert _fmt_peak("not-a-timestamp") == "not-a-timestamp"
        assert _fmt_peak("") == ""
    finally:
        get_settings.cache_clear()


async def test_invalid_timezone_degrades_to_utc_without_raising(
    client, db_path, monkeypatch
):
    """An unknown zone name must not 500 any endpoint — it falls back to UTC."""
    from app.config import get_settings
    from app.services import timeutil

    rows, boundary_ts = _boundary_rows()
    await _seed(client, db_path, rows, add_action_col=True)

    monkeypatch.setenv("DISPLAY_TZ", "Not/AZone")
    get_settings.cache_clear()
    timeutil.reset_warning_cache()
    try:
        res = client.get("/api/analytics/bandwidth?range=7d")
        assert res.status_code == 200
        buckets = {p["bucket"] for p in res.json()["points"]}
        assert boundary_ts[:10] in buckets  # UTC fallback, not a crash

        res = client.get("/api/analytics/summary?range=7d")
        assert res.status_code == 200
        assert "EST" not in res.json()["peakTrafficTime"]
    finally:
        get_settings.cache_clear()
        timeutil.reset_warning_cache()


async def test_client_report_buckets_by_local_day(client, db_path, monkeypatch):
    """The client report shares the operator-zone bucketing (sibling path)."""
    from app.config import get_settings

    rows, boundary_ts = _boundary_rows()
    await _seed(client, db_path, rows, add_action_col=True)
    local_day = (
        datetime.fromisoformat(boundary_ts.replace("Z", "+00:00"))
        .astimezone(timezone(timedelta(hours=7)))
        .strftime("%Y-%m-%d")
    )

    monkeypatch.setenv("DISPLAY_TZ", "+07:00")
    get_settings.cache_clear()
    try:
        res = client.get("/api/client-report/1.1.1.1")
        assert res.status_code == 200
        data = res.json()
        buckets = {p["bucket"] for p in data["bandwidth"]["points"]}
        assert "EST" not in data["peak_hour"]
    finally:
        get_settings.cache_clear()


# ── Volume honesty ────────────────────────────────────────────────────────
#
# Product rule (CONTEXT.md, *No synthesized measurements*): a shown number is
# a persisted field or explicitly unavailable. Volume used to fall back to
# ``duration_seconds x 8192`` (or a flat 8 KiB per request) when the feed
# carried no byte counter. That is deleted: volume is the SUM of the persisted
# ``bytes_downloaded``/``bytes_uploaded`` columns, and when none is persisted
# the API reports it unavailable (``totalVolume: null`` +
# ``bandwidthNeverMeasured: true``) rather than inventing a total.


async def test_volume_for_bytes_is_gone():
    """The per-request/duration byte proxy must not come back."""
    import app.routes.analytics as analytics_mod

    assert not hasattr(analytics_mod, "DEFAULT_BYTES_PER_REQUEST")


async def test_volume_unavailable_when_no_bytes_persisted(client, db_path):
    """Rows with NO byte fields → volume is unavailable, never a nonzero number.

    The seeded rows carry a ``duration_seconds`` value precisely so the old
    proxy would have produced a large fabricated total; the honest answer is
    null with an explicit "never measured" marker.
    """
    db = await aiosqlite.connect(db_path)
    try:
        await db.execute(
            "INSERT INTO findings (client_ip, server_ip, url, base_url,"
            " log_timestamp, matched_patterns, duration_seconds)"
            " VALUES ('1.1.1.1', '', 'http://evil.example/a', 'evil.example',"
            " strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), '[]', '30')"
        )
        await db.commit()
    finally:
        await db.close()

    data = client.get("/api/analytics/summary?range=7d").json()
    assert data["source"] == "findings"
    assert data["totalVolume"] is None          # not 0, and not 30*8192
    assert data["bandwidthNeverMeasured"] is True
    # This row matches no block pattern, so it is not risk and carries no real
    # byte counter: nothing on the card is measured, so ``has_data`` is False.
    # The point under test is that the served volume is ``None`` — never a
    # fabricated 30 * 8192.
    assert data["has_data"] is False


async def test_volume_sums_real_persisted_bytes(client, db_path):
    """Rows WITH real byte counters still sum them — ``totalVolume`` is real."""
    db = await aiosqlite.connect(db_path)
    try:
        await db.executemany(
            "INSERT INTO findings (client_ip, server_ip, url, base_url,"
            " log_timestamp, matched_patterns, bytes_downloaded, bytes_uploaded)"
            " VALUES (?, '', ?, 'evil.example',"
            " strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), '[]', ?, ?)",
            [
                ("1.1.1.1", "http://evil.example/a", "2048", "1024"),
                ("1.1.1.1", "http://evil.example/b", "4096", "0"),
            ],
        )
        await db.commit()
    finally:
        await db.close()

    data = client.get("/api/analytics/summary?range=7d").json()
    assert data["totalVolume"] == 2048 + 1024 + 4096 + 0
    assert data["bandwidthNeverMeasured"] is False


async def test_previous_period_volume_unavailable_when_not_persisted(client, db_path):
    """A byte-less current AND previous window yield ``volumeDeltaPct: null``.

    Both windows must be non-empty so ``previous`` is not ``None``; the delta
    may not divide by an absent volume (no ``NaN``/``Infinity``).
    """
    now = datetime.now(UTC)
    recent = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    # Inside the previous 7d slice ([now-14d, now-7d)).
    prev = (now - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    pats = json.dumps(["*evil*"])
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", recent, pats, "ALLOW"),
            ("1.1.1.1", "", "http://evil.example/b", "evil.example", prev, pats, "ALLOW"),
        ],
        add_action_col=True,
    )

    data = client.get("/api/analytics/summary?range=7d&compare=previous").json()
    assert data["totalVolume"] is None
    assert data["bandwidthNeverMeasured"] is True
    assert data["previous"] is not None
    assert data["previous"]["totalVolume"] is None
    assert data["volumeDeltaPct"] is None


async def test_client_report_volume_unavailable_when_no_bytes_persisted(client, db_path):
    """The client report (and its CSV export) report volume honestly too."""
    await _seed(
        client,
        db_path,
        [
            (
                "1.1.1.1", "", "http://evil.example/a", "evil.example",
                _now(), json.dumps(["*evil*"]), "ALLOW",
            ),
        ],
        add_action_col=True,
    )

    data = client.get("/api/client-report/1.1.1.1").json()
    assert data["total_volume"] is None
    assert data["bandwidthNeverMeasured"] is True
    assert all(p["inbound"] == 0 and p["outbound"] == 0 for p in data["bandwidth"]["points"])

    csv_res = client.get("/api/client-report/1.1.1.1/export.csv")
    assert csv_res.status_code == 200
    assert "not recorded" in csv_res.text


# ── Destination-host normalisation (the port-strip defect) ────────────────
#
# ``_domain_of_base`` is the single copy now shared by ``analytics.py`` and
# ``client_report.py``. ``analytics.py``'s copy used to skip the trailing-port
# strip, so a ``base_url`` that still carried a port (``a.example:8080``) did
# not match ``blacklist_domains`` — a bare-host set (``app/services/blacklist.py``)
# — which under-counted ``totalBlacklistedRisk`` and split one destination into
# two domain buckets. This pins the stripping, the IPv6 authority form, and that
# ``www.`` is deliberately KEPT (never stripped, despite the old comment).


def test_domain_of_base_strips_port_keeps_www():
    """Port stripped (IPv4, DNS and IPv6-authority forms); ``www.`` retained."""
    from app.services.result_processor import _domain_of_base

    # Port removed; scheme and path removed; ``www.`` kept verbatim.
    assert _domain_of_base("https://www.Example.com:443/path") == "www.Example.com"
    assert _domain_of_base("http://a.example:8080") == "a.example"
    # IPv6 authority: the ``[..]`` brackets survive; only the ``:port`` goes.
    assert _domain_of_base("https://[2001:db8::1]:8443/x") == "[2001:db8::1]"
    # No scheme / no port passes through untouched.
    assert _domain_of_base("a.example") == "a.example"
    # Absent or unparseable input collapses to the explicit sentinel.
    assert _domain_of_base("") == "unknown"
    assert _domain_of_base(None) == "unknown"



# ── Enforcement counts on the LIVE path (the patternless-DENY defect) ──────
#
# The live analytics helpers derived their enforcement numbers from ONE query
# built with `build_logs_query` DEFAULTS, which appends a `url : <pattern>`
# clause. The proxy records a DENY against the destination it refused, whose
# URL need not contain any block pattern (a bare host, an IP, the SNI), so that
# frame held NO DENY rows on ordinary traffic and the count read 0. The fix
# runs a SECOND, action-filtered query (`actions=["DENY","FLAG"]`) whose result
# is independent of the pattern clause — the same split `_aggregate_host` uses
# (`app/routes/hosts.py`). These tests pin both halves: the count, and the
# classification `allow` vs `deny`.

# The seeded block pattern. A DENY whose URL is the SNI host of the refused
# destination contains none of it — that is the whole point.
_BLOCK_PATTERN = "*indoxxi*"


# `_stub_es` below resolves the field mode through the REAL cache
# (`fetch_field_inventory`), so the cache must not survive a test: other suites
# assert it is empty in a unit context (e.g.
# `test_attck_mapping.py::test_inventory_union_not_derivable_from_mode_only`).
@pytest.fixture(autouse=True)
def _clear_es_fields_cache():
    from app.services import es_fields

    es_fields._invalidate_cache()
    yield
    es_fields._invalidate_cache()


async def _seed_block_pattern(pattern: str = _BLOCK_PATTERN) -> None:
    """Configure one block pattern (the pattern query has something to match)."""
    from app.database import get_db, init_db

    await init_db()
    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type)"
            " VALUES (?, 'block')",
            (pattern,),
        )
        await db.commit()
    finally:
        await db.close()


async def _stub_es(monkeypatch, *, pattern_hits, action_hits):
    """Stub ES for the analytics helpers and record the queries they send.

    Both helpers import ``es_client`` INSIDE the function (and bail out before
    searching when ``get_mode()`` is UNKNOWN), so this helper:

    (a) resolves the mode through the REAL public path
        (``fetch_field_inventory`` over a sample doc) so the gate admits the
        call, and
    (b) patches the DEFINING module's ``es_client`` — what the in-function
        import resolves through.

    Each search is answered by its QUERY SHAPE: a body carrying a ``terms``
    filter on ``action`` is the action query, anything else is a pattern query.
    This mirrors ``tests/test_hosts.py::_stub_es``.
    """
    from app.services import es_fields

    baseline = {
        "@timestamp": "2026-09-21T07:00:00Z",
        "url": "https://x/",
        "client_ip": "10.0.0.5",
        "server_ip": "57.144.192.3",
        "duration_seconds": 0.01,
        "action": "ALLOW",
    }
    es_fields._invalidate_cache()
    await es_fields.fetch_field_inventory(
        es=_SampleES(sample_doc=baseline, field_caps={k: {} for k in baseline})
    )
    assert es_fields.get_mode() != "UNKNOWN"

    sent: list[dict] = []

    class _FakeES:
        async def search(self, **kwargs):
            body = kwargs["body"]
            sent.append(body)
            filters = body["query"]["bool"]["filter"]
            if any("terms" in f for f in filters):
                # The count-only action query (`size: 0`, `track_total_hits:
                # true`) — real ES answers these with a `total` block, which
                # `_es_summary` reads as its enforcement count.
                return {
                    "hits": {
                        "total": {"value": len(action_hits), "relation": "eq"},
                        "hits": action_hits,
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

    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **k: _Ctx())
    monkeypatch.setattr(es_fields, "es_client", lambda *a, **k: _Ctx())
    return sent


class _SampleES:
    """Minimal ES double for the field-inventory probe (sample + field_caps)."""

    def __init__(self, *, sample_doc, field_caps):
        self._sample = sample_doc
        self._caps = field_caps

    async def search(self, **kwargs):
        return {"hits": {"hits": [{"_source": self._sample}]}}

    async def field_caps(self, **kwargs):
        return {"fields": self._caps}

    async def close(self):
        return None


# One ALLOW row that DOES match the block pattern (so the pattern query is not
# empty), and one DENY row whose URL matches NO pattern — a bare SNI host. The
# pre-fix frame therefore contained the ALLOW and none of the DENY.
_PATTERN_ALLOW_HIT = {
    "_source": {
        "@timestamp": "2026-09-21T07:00:00Z",
        "url": "https://indoxxi.foo/watch",
        "client_ip": "10.0.0.5",
        "server_ip": "57.144.192.3",
        "action": "ALLOW",
    }
}
_PATTERNLESS_DENY_HIT = {
    "_source": {
        "@timestamp": "2026-09-21T09:30:00Z",
        "url": "https://z-m-gateway.facebook.com/",
        "client_ip": "10.0.0.5",
        "server_ip": "57.144.192.3",
        "action": "DENY",
    }
}


async def test_patternless_deny_counted_in_deny_series(client, db_path, monkeypatch):
    """A DENY whose URL matches NO block pattern is counted in ``deny``.

    Pre-fix this read 0: the pattern query never returned the row.
    """
    await _seed_block_pattern()
    sent = await _stub_es(
        monkeypatch,
        pattern_hits=[_PATTERN_ALLOW_HIT],
        action_hits=[_PATTERNLESS_DENY_HIT],
    )

    data = client.get("/api/analytics/enforcements?range=7d").json()
    by_day = {p["bucket"]: p for p in data["points"]}
    assert by_day["2026-09-21"]["deny"] == 1

    # The root-cause pin: two searches were issued and the one that measured
    # the DENY carries a `terms` clause on `action` and NO `url : <pattern>`.
    assert len(sent) == 2
    action_queries = [
        b for b in sent if any("terms" in f for f in b["query"]["bool"]["filter"])
    ]
    assert len(action_queries) == 1, "exactly one action-filtered query"
    assert {"terms": {"action": ["DENY", "FLAG"]}} in action_queries[0]["query"]["bool"]["filter"]
    assert not any(
        "query_string" in f for f in action_queries[0]["query"]["bool"]["filter"]
    ), "the DENY query must carry NO block-pattern clause — that clause hid the row"


async def test_patternless_deny_not_counted_into_allow(client, db_path, monkeypatch):
    """The two-way miscount: the DENY row must NOT also land in ``allow``.

    Pre-fix the classifier was `deny if action in (DENY, FLAG) else allow`, so
    a DENY that never reached the frame was counted as an ALLOW. After the
    split, `allow` is exactly ``action == "ALLOW"``.
    """
    await _seed_block_pattern()
    await _stub_es(
        monkeypatch,
        pattern_hits=[_PATTERN_ALLOW_HIT],
        action_hits=[_PATTERNLESS_DENY_HIT],
    )

    data = client.get("/api/analytics/enforcements?range=7d").json()
    by_day = {p["bucket"]: p for p in data["points"]}
    # One ALLOW reached a block pattern; the DENY is separate and NOT an allow.
    assert by_day["2026-09-21"]["allow"] == 1
    assert by_day["2026-09-21"]["deny"] == 1


async def test_summary_total_enforcements_reflects_patternless_deny(
    client, db_path, monkeypatch
):
    """``totalEnforcements`` (the headline card) reflects patternless DENYs."""
    await _seed_block_pattern()
    await _stub_es(
        monkeypatch,
        pattern_hits=[_PATTERN_ALLOW_HIT],
        action_hits=[_PATTERNLESS_DENY_HIT],
    )

    data = client.get("/api/analytics/summary?range=7d").json()
    assert data["totalEnforcements"] == 1
    assert data["totalBlocked"] == 1
    # The risk card still comes from the pattern frame and is unaffected.
    assert data["totalRisk"] == 1
    assert data["enforcementsNeverMeasured"] is False


async def test_summary_empty_window_enforcements_are_measured_not_assumed(
    client, db_path, monkeypatch
):
    """An ES-reachable empty window reports a REAL enforcement count.

    Pins the honesty branch: when both queries return nothing the risk series is
    a genuine 0 AND ``enforcementsNeverMeasured`` accompanies it, so a future
    change cannot silently restore a confident 0 that was never measured. When
    the action query DOES answer (the second case), the empty pattern frame must
    still surface the proxy's real DENY count instead of 0.
    """
    await _seed_block_pattern()

    # (a) Genuinely empty window — both questions were asked and both are empty.
    await _stub_es(monkeypatch, pattern_hits=[], action_hits=[])
    data = client.get("/api/analytics/summary?range=7d").json()
    assert data["totalEnforcements"] == 0
    assert data["enforcementsNeverMeasured"] is False
    assert data["totalRisk"] == 0

    # (b) Empty PATTERN frame but real DENYs — the empty branch must not report 0.
    monkeypatch.undo()
    await _stub_es(
        monkeypatch, pattern_hits=[], action_hits=[_PATTERNLESS_DENY_HIT]
    )
    data = client.get("/api/analytics/summary?range=7d").json()
    assert data["totalEnforcements"] == 1
    assert data["totalRisk"] == 0


async def test_enforcements_empty_window_is_honestly_empty_es(
    client, db_path, monkeypatch
):
    """A reachable-but-empty window returns ``[]`` and is honestly ``source: es``.

    Pre-fix ``_es_enforcements`` returned ``[]`` on this path WITHOUT ever
    asking the DENY question, and the endpoint advertised ``es_online: true`` —
    a live enforcement measurement it had never made. Now the empty result is
    the product of BOTH searches, so ``source: "es"`` is true. The persisted
    ledger is still reachable on the paths that return ``None`` (ES offline).
    """
    await _seed_block_pattern()
    sent = await _stub_es(monkeypatch, pattern_hits=[], action_hits=[])

    data = client.get("/api/analytics/enforcements?range=7d").json()
    assert data["points"] == []
    assert data["source"] == "es"
    assert data["es_online"] is True
    # Both queries ran on the empty path — the DENY question was actually asked.
    assert len(sent) == 2
    assert any("terms" in f for f in sent[1]["query"]["bool"]["filter"])


# One DENY row whose URL matches NO block pattern, carrying the PROXY's own
# rule identity (`rule_name` / `rule_info`) — the fields a patternless DENY
# actually has, unlike app-derived `matched_patterns`.
_PATTERNLESS_DENY_HIT_WITH_RULE = {
    "_source": {
        "@timestamp": "2026-09-21T09:30:00Z",
        "url": "https://z-m-gateway.facebook.com/",
        "base_url": "z-m-gateway.facebook.com",
        "client_ip": "10.0.0.5",
        "server_ip": "57.144.192.3",
        "action": "DENY",
        "rule_name": "Block Social Media",
        "rule_info": "RN190,SNI,BS",
    }
}


async def test_top_enforced_counts_patternless_deny(client, db_path, monkeypatch):
    """A DENY whose URL matches NO block pattern appears in ``top-enforced``.

    Pre-fix the helper grouped the pattern-filtered frame, which never contains
    a patternless-URL DENY, so this row was absent and the result was ``[]`` —
    indistinguishable from "no enforcements occurred".
    """
    await _seed_block_pattern()
    sent = await _stub_es(
        monkeypatch,
        pattern_hits=[_PATTERN_ALLOW_HIT],
        action_hits=[_PATTERNLESS_DENY_HIT_WITH_RULE],
    )

    data = client.get("/api/analytics/top-enforced?range=7d").json()
    assert data["source"] == "es"
    by_domain = {it["domain"]: it for it in data["items"]}
    assert "z-m-gateway.facebook.com" in by_domain
    assert by_domain["z-m-gateway.facebook.com"]["enforcements"] == 1
    # The pattern query is not needed for this endpoint's population: the one
    # query that ran is the action query, and it carries NO block-pattern clause.
    assert len(sent) == 1
    assert {"terms": {"action": ["DENY", "FLAG"]}} in sent[0]["query"]["bool"]["filter"]
    assert not any(
        "query_string" in f for f in sent[0]["query"]["bool"]["filter"]
    ), "the enforcement frame must carry NO block-pattern clause"


async def test_top_enforced_primary_rule_reads_proxy_rule_fields(
    client, db_path, monkeypatch
):
    """``primaryRule`` reads the proxy's ``rule_name``, not ``matched_patterns``.

    A patternless DENY has no app-derived ``matched_patterns`` (it never matched
    a pattern), so a ``matched_patterns``-sourced field would read empty for the
    very rows this endpoint now returns. The proxy's own rule identity is the
    correct source; ``rule_name`` wins over ``rule_info``.
    """
    await _seed_block_pattern()
    await _stub_es(
        monkeypatch,
        pattern_hits=[],
        action_hits=[_PATTERNLESS_DENY_HIT_WITH_RULE],
    )

    data = client.get("/api/analytics/top-enforced?range=7d").json()
    by_domain = {it["domain"]: it for it in data["items"]}
    assert by_domain["z-m-gateway.facebook.com"]["primaryRule"] == "Block Social Media"


async def test_top_enforced_primary_rule_falls_back_to_rule_info(
    client, db_path, monkeypatch
):
    """With no ``rule_name``, ``primaryRule`` falls back to ``rule_info``'s first code."""
    await _seed_block_pattern()
    hit = json.loads(json.dumps(_PATTERNLESS_DENY_HIT_WITH_RULE))
    del hit["_source"]["rule_name"]
    await _stub_es(monkeypatch, pattern_hits=[], action_hits=[hit])

    data = client.get("/api/analytics/top-enforced?range=7d").json()
    by_domain = {it["domain"]: it for it in data["items"]}
    assert by_domain["z-m-gateway.facebook.com"]["primaryRule"] == "RN190"


async def test_top_enforced_primary_rule_empty_when_no_rule_attributable(
    client, db_path, monkeypatch
):
    """A patternless DENY with neither proxy rule field yields an empty marker.

    ``""`` is the explicit "no rule attributable" state — the same honest empty
    the findings fallback uses — never a literal that reads as a rule name.
    """
    await _seed_block_pattern()
    hit = json.loads(json.dumps(_PATTERNLESS_DENY_HIT_WITH_RULE))
    del hit["_source"]["rule_name"]
    del hit["_source"]["rule_info"]
    await _stub_es(monkeypatch, pattern_hits=[], action_hits=[hit])

    data = client.get("/api/analytics/top-enforced?range=7d").json()
    by_domain = {it["domain"]: it for it in data["items"]}
    assert by_domain["z-m-gateway.facebook.com"]["primaryRule"] == ""
    assert by_domain["z-m-gateway.facebook.com"]["enforcements"] == 1
