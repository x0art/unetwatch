"""GET /api/timezone — exposes the operator zone to the frontend.

The backend buckets and labels every time in the operator's zone
(``DISPLAY_TZ``), but the frontend cannot label anything correctly without
knowing which zone that is. These tests pin the contract: the endpoint reports
``timeutil.zone_label()`` verbatim, the zone's current UTC offset in minutes,
and it follows the env — changing ``DISPLAY_TZ`` changes the reported offset,
so a hardcoded constant would fail here.
"""


async def test_reports_configured_zone_and_offset(client, monkeypatch):
    """The endpoint reports the configured zone and a correct offset."""
    from datetime import timedelta

    from app.config import get_settings

    monkeypatch.setenv("DISPLAY_TZ", "+07:00")
    get_settings.cache_clear()
    try:
        res = client.get("/api/timezone")
        assert res.status_code == 200
        data = res.json()
        assert data["label"] == "+07:00"
        expected = int(timedelta(hours=7).total_seconds() // 60)
        assert data["offsetMinutes"] == expected
    finally:
        get_settings.cache_clear()


async def test_reports_iana_label_for_iana_zone(client, monkeypatch):
    """An IANA zone passes ``zone_label()`` through verbatim (not "UTC")."""
    from app.config import get_settings

    monkeypatch.setenv("DISPLAY_TZ", "Asia/Bangkok")
    get_settings.cache_clear()
    try:
        res = client.get("/api/timezone")
        assert res.status_code == 200
        data = res.json()
        assert data["label"] == "Asia/Bangkok"
        assert data["offsetMinutes"] == 420  # ICT is +07:00 year-round
    finally:
        get_settings.cache_clear()


async def test_changing_display_tz_changes_reported_offset(client, monkeypatch):
    """The setting is read per-request, not a constant: UTC → +05:30 flips both
    the label and the offset."""
    from app.config import get_settings

    monkeypatch.setenv("DISPLAY_TZ", "UTC")
    get_settings.cache_clear()
    try:
        utc = client.get("/api/timezone").json()
        assert utc == {"label": "UTC", "offsetMinutes": 0}

        monkeypatch.setenv("DISPLAY_TZ", "+05:30")
        get_settings.cache_clear()
        ist = client.get("/api/timezone").json()
        assert ist["label"] == "+05:30"
        assert ist["offsetMinutes"] == 330
        assert ist["offsetMinutes"] != utc["offsetMinutes"]
    finally:
        get_settings.cache_clear()


async def test_invalid_zone_degrades_to_utc_without_raising(client, monkeypatch):
    """A typo'd zone must not 500 — the endpoint inherits timeutil's UTC fallback."""
    from app.config import get_settings
    from app.services import timeutil

    monkeypatch.setenv("DISPLAY_TZ", "Not/AZone")
    get_settings.cache_clear()
    timeutil.reset_warning_cache()
    try:
        res = client.get("/api/timezone")
        assert res.status_code == 200
        assert res.json() == {"label": "UTC", "offsetMinutes": 0}
    finally:
        get_settings.cache_clear()
        timeutil.reset_warning_cache()


async def test_requires_admin_credentials(client):
    """Consistency: like every other admin-UI read, the endpoint is auth-gated."""
    res = client.get("/api/timezone", headers={"Authorization": ""})
    assert res.status_code == 401


# ── System-zone fallback (the Findings "Detected" defect) ─────────────────────
#
# The Findings "Detected" column renders `log_timestamp` through
# `TimestampCell -> useZone() -> formatInstant`, and `useZone` is fed by this
# endpoint. So the zone reported here IS the zone the operator reads on
# Findings. Before this fallback existed, an unset DISPLAY_TZ resolved to UTC
# even when the host clock was Asia/Jakarta — the operator saw UTC times.
# These tests pin that an unset DISPLAY_TZ follows the host zone instead.


async def test_unset_display_tz_follows_system_zone(client, monkeypatch):
    """Unset DISPLAY_TZ → the effective zone is the host's system zone.

    `DISPLAY_TZ` is set to the empty string rather than deleted: an empty env
    var overrides any ``DISPLAY_TZ`` in a local ``.env`` (which pydantic would
    otherwise read), so this genuinely exercises the system-detection path.
    `TZ` is pinned so the verdict does not depend on the test host's own
    zoneinfo.
    """
    from app.config import get_settings
    from app.services import timeutil

    monkeypatch.setenv("DISPLAY_TZ", "")
    monkeypatch.setenv("TZ", "Asia/Jakarta")
    timeutil.reset_system_zone_cache()
    get_settings.cache_clear()
    try:
        res = client.get("/api/timezone")
        assert res.status_code == 200
        assert res.json() == {"label": "Asia/Jakarta", "offsetMinutes": 420}
    finally:
        get_settings.cache_clear()
        timeutil.reset_system_zone_cache()


async def test_explicit_display_tz_overrides_system_zone(client, monkeypatch):
    """An explicit DISPLAY_TZ stays authoritative over system detection."""
    from app.config import get_settings
    from app.services import timeutil

    monkeypatch.setenv("DISPLAY_TZ", "UTC")
    monkeypatch.setenv("TZ", "Asia/Jakarta")
    timeutil.reset_system_zone_cache()
    get_settings.cache_clear()
    try:
        assert client.get("/api/timezone").json() == {
            "label": "UTC",
            "offsetMinutes": 0,
        }
    finally:
        get_settings.cache_clear()
        timeutil.reset_system_zone_cache()


async def test_unset_display_tz_buckets_boundary_into_local_day(monkeypatch):
    """The concrete symptom at the bucketing seam: with DISPLAY_TZ unset the
    boundary instant (23:59:11Z) must land in the LOCAL day, not the UTC day.

    `TZ=Asia/Makassar` (+08:00) is deliberately *not* the zone a local `.env`
    would carry, so this cannot pass by accidentally reading `.env`. Same
    boundary instant the analytics fix pinned: 23:59:11Z is the next calendar
    day everywhere east of UTC.
    """
    from app.config import get_settings
    from app.services import timeutil

    monkeypatch.setenv("DISPLAY_TZ", "")
    monkeypatch.setenv("TZ", "Asia/Makassar")
    timeutil.reset_system_zone_cache()
    get_settings.cache_clear()
    try:
        assert timeutil.local_day("2026-08-31T23:59:11Z") == "2026-09-01"
    finally:
        get_settings.cache_clear()
        timeutil.reset_system_zone_cache()


def test_system_zone_name_validates_candidates(monkeypatch):
    """A valid TZ wins; a bogus one is never returned (falls through or UTC)."""
    from zoneinfo import ZoneInfo

    from app.services import timeutil

    monkeypatch.setenv("TZ", "Asia/Jakarta")
    timeutil.reset_system_zone_cache()
    assert timeutil.system_zone_name() == "Asia/Jakarta"

    monkeypatch.setenv("TZ", "Not/AZone")
    timeutil.reset_system_zone_cache()
    name = timeutil.system_zone_name()
    assert name != "Not/AZone"
    if name:  # whatever won must be a real zone
        ZoneInfo(name)
    timeutil.reset_system_zone_cache()


def test_default_display_tz_is_empty_not_utc(monkeypatch):
    """The FIELD DEFAULT (DISPLAY_TZ absent everywhere) must be empty — i.e.
    "follow the host" — not the old literal ``"UTC"``.

    This is the change that fixes Findings on a box already set to
    Asia/Jakarta: with no DISPLAY_TZ configured, the old default forced UTC.
    ``_env_file=None`` makes the assertion independent of a developer's local
    ``.env``.
    """
    from app.config import Settings

    monkeypatch.delenv("DISPLAY_TZ", raising=False)
    assert Settings(_env_file=None).display_tz == ""


async def test_absent_display_tz_resolves_to_system_zone(monkeypatch):
    """End-to-end: DISPLAY_TZ absent from both env and ``.env`` → the operator
    zone is the host's, not UTC.

    ``TZ=Asia/Makassar`` (+08:00) is used so the assertion cannot be satisfied
    by a local ``.env`` that happens to name Asia/Jakarta. The settings object
    is rebuilt with ``_env_file=None`` to simulate "no DISPLAY_TZ anywhere",
    which is the exact deployment this fallback exists for.
    """
    from app.config import Settings
    from app.services import timeutil

    monkeypatch.delenv("DISPLAY_TZ", raising=False)
    monkeypatch.setenv("TZ", "Asia/Makassar")
    timeutil.reset_system_zone_cache()
    monkeypatch.setattr("app.config.get_settings", lambda: Settings(_env_file=None))
    try:
        assert timeutil.zone_label() == "Asia/Makassar"
        assert timeutil.utc_offset_minutes() == 480
    finally:
        timeutil.reset_system_zone_cache()
