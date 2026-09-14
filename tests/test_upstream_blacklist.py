"""Tests for the upstream blacklist sync (GitHub raw gist, every 5 min)."""

from app.services.upstream_blacklist import parse_upstream_body


def test_parse_upstream_body_drops_comments_and_empties():
    body = (
        "# a comment\n"
        "; another comment\n"
        "\n"
        "   \n"
        "evil.example.com\n"
        "  1.2.3.4  \n"
        "https://bad.example/path\n"
    )
    assert parse_upstream_body(body) == [
        "evil.example.com",
        "1.2.3.4",
        "https://bad.example/path",
    ]


def test_parse_upstream_body_empty():
    assert parse_upstream_body("") == []
    assert parse_upstream_body("# only comments\n; nothing else\n  \n") == []


async def test_sync_disabled_when_url_empty(monkeypatch):
    from app.config import get_settings
    from app.services.upstream_blacklist import sync_upstream_blacklist

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URL", "")
    get_settings.cache_clear()
    try:
        result = await sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "disabled"}


async def _run_sync(monkeypatch, body: str, db_path):
    """Run a sync with the fetch layer stubbed to return ``body``.

    Takes the ``db_path`` fixture so each test syncs against an isolated
    temp DB — exact added/skipped counts never leak across tests.
    """
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URL", "https://example.com/list.txt")
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        assert url == "https://example.com/list.txt"
        return body

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        return await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()


async def test_sync_inserts_and_dedups(monkeypatch, db_path):
    body = (
        "# comment\n"
        "dedup-one.example.com\n"
        "10.9.9.9\n"
        "\n"
        "not a url or ip\n"
    )
    first = await _run_sync(monkeypatch, body, db_path)
    assert first["ok"] is True
    assert first["added"] == 2
    assert first["fetched"] == 3
    # "not a url or ip" fails normalize (contains spaces) -> per-line error.
    assert len(first["errors"]) == 1

    # Second run of the same body adds nothing (dedup via INSERT OR IGNORE).
    second = await _run_sync(monkeypatch, body, db_path)
    assert second["ok"] is True
    assert second["added"] == 0
    assert second["skipped"] == 2
    assert len(second["errors"]) == 1


async def test_sync_http_error_returns_reason(monkeypatch):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URL", "https://example.com/list.txt")
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        raise RuntimeError("http_404")

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        result = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "http_404"}


async def test_upstream_status_reports_counts(monkeypatch, db_path):
    import app.services.upstream_blacklist as ub
    from app.config import get_settings
    from app.database import init_db

    ub._LAST_SYNC.update(
        {
            "last_sync": None,
            "last_added": 0,
            "last_skipped": 0,
            "last_errors": 0,
            "last_error": None,
        }
    )
    await _run_sync(monkeypatch, "status.example.com\n", db_path)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_URL", "https://example.com/list.txt")
    get_settings.cache_clear()
    try:
        await init_db()
        status = await ub.get_upstream_status()
    finally:
        get_settings.cache_clear()
    assert status["enabled"] is True
    assert status["url_configured"] is True
    assert status["last_sync"] is not None
    assert status["last_added"] == 1
    assert status["upstream_count"] >= 1


async def test_fetch_text_rejects_oversize_body(monkeypatch, db_path):
    """Bodies over MAX_UPSTREAM_BYTES are rejected before buffering."""
    from app.config import get_settings
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URL", "https://example.com/list.txt")
    get_settings.cache_clear()
    try:
        # Stub _fetch_text to simulate an oversize body at the fetch layer.
        async def fake_big(url: str) -> str:
            raise RuntimeError("body_too_large")

        monkeypatch.setattr(ub, "_fetch_text", fake_big)
        from app.database import init_db

        await init_db()
        out = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    assert out == {"ok": False, "reason": "body_too_large"}
    assert ub._LAST_SYNC["last_error"] == "body_too_large"


async def test_upstream_routes(client, monkeypatch):
    from app.config import get_settings
    from app.services import upstream_blacklist as ub

    async def fake_fetch(url: str) -> str:
        return "route.example.com\n"

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_URL", "https://example.com/list.txt")
    get_settings.cache_clear()
    try:
        resp = client.post("/api/blacklist/upstream-sync")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert resp.json()["added"] == 1

        status_resp = client.get("/api/blacklist/upstream-status")
        assert status_resp.status_code == 200
        body = status_resp.json()
        assert body["enabled"] is True
        assert body["upstream_count"] >= 1
    finally:
        get_settings.cache_clear()


def test_source_column_has_no_check_constraint():
    """`blacklist_entries.source` has NO CHECK constraint in database.py —
    only the `kind` column does. The inline comment lists 'manual'|'finding'
    as documentation, so 'upstream' inserts need no migration."""
    import inspect

    import app.database as dbmod

    src = inspect.getsource(dbmod.init_db)
    assert "CHECK (kind IN ('url', 'ip'))" in src
    assert "CHECK (source" not in src
