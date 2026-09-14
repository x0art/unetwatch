"""Tests for the upstream jaillist sync (single feed, every 5 min)."""

JAIL_FEED = "https://example.com/jail.txt"


def _reset_last_sync():
    import app.services.upstream_jaillist as uj

    uj._LAST_SYNC.update(
        {
            "last_sync": None,
            "last_added": 0,
            "last_skipped": 0,
            "last_errors": 0,
            "last_error": None,
        }
    )


async def test_sync_disabled_when_env_empty(monkeypatch):
    from app.config import get_settings
    from app.services.upstream_jaillist import sync_upstream_jaillist

    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", "")
    get_settings.cache_clear()
    try:
        result = await sync_upstream_jaillist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "disabled"}


async def _run_sync(monkeypatch, body: str, db_path):
    """Run a jaillist sync with the fetch layer stubbed.

    Takes the ``db_path`` fixture so each test syncs against an isolated
    temp DB — exact added/skipped counts never leak across tests.
    """
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    _reset_last_sync()
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", JAIL_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        assert url == JAIL_FEED
        return body

    monkeypatch.setattr(uj, "_fetch_text", fake_fetch)
    try:
        await init_db()
        return await uj.sync_upstream_jaillist()
    finally:
        get_settings.cache_clear()


async def test_sync_inserts_and_dedups(monkeypatch, db_path):
    body = (
        "# comment\n"
        "; another comment\n"
        "10.9.9.9\n"
        "10.9.9.10:8080\n"
        "\n"
    )
    first = await _run_sync(monkeypatch, body, db_path)
    assert first["ok"] is True
    assert first["added"] == 2
    assert first["skipped"] == 0
    assert first["errors"] == []
    assert first["fetched"] == 2

    # Second run of the same body adds nothing (dedup via INSERT OR IGNORE).
    second = await _run_sync(monkeypatch, body, db_path)
    assert second["ok"] is True
    assert second["added"] == 0
    assert second["skipped"] == 2
    assert second["errors"] == []


async def test_sync_invalid_lines_are_errors_not_crashes(monkeypatch, db_path):
    from app.database import get_db

    body = (
        "10.8.8.8\n"
        "evil.example.com\n"  # hostname -> error
        "not an ip at all\n"  # spaces -> error
        "10.0.0.0/24\n"  # CIDR -> error
        "garbage!!!\n"  # not an IP -> error
        "10.8.8.9\n"
    )
    result = await _run_sync(monkeypatch, body, db_path)
    assert result["ok"] is True
    assert result["added"] == 2
    assert len(result["errors"]) == 4

    # The valid IPs were committed despite the bad lines.
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT value FROM jaillist_entries WHERE source = 'upstream'"
            " ORDER BY value"
        )
        values = [row[0] for row in await cursor.fetchall()]
    finally:
        await db.close()
    assert values == ["10.8.8.8", "10.8.8.9"]


async def test_sync_http_error_returns_reason(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    _reset_last_sync()
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", JAIL_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        raise RuntimeError("http_404")

    monkeypatch.setattr(uj, "_fetch_text", fake_fetch)
    try:
        await init_db()
        result = await uj.sync_upstream_jaillist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "http_404"}
    assert uj._LAST_SYNC["last_error"] == "http_404"


async def test_upstream_status_shape(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    await _run_sync(monkeypatch, "10.7.7.7\n", db_path)
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", JAIL_FEED)
    get_settings.cache_clear()
    try:
        await init_db()
        status = await uj.get_upstream_status()
    finally:
        get_settings.cache_clear()
    assert set(status) == {
        "enabled",
        "urls_configured",
        "last_sync",
        "last_added",
        "last_skipped",
        "last_errors",
        "last_error",
        "upstream_count",
    }
    assert status["enabled"] is True
    assert status["urls_configured"] is True
    assert status["last_sync"] is not None
    assert status["last_added"] == 1
    assert status["last_skipped"] == 0
    assert status["last_errors"] == 0
    assert status["last_error"] is None
    assert status["upstream_count"] >= 1


async def test_upstream_status_disabled_when_env_empty(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    _reset_last_sync()
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", "")
    get_settings.cache_clear()
    try:
        await init_db()
        status = await uj.get_upstream_status()
    finally:
        get_settings.cache_clear()
    assert status["enabled"] is False
    assert status["urls_configured"] is False
    assert status["last_sync"] is None
