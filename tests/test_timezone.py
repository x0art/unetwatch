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
