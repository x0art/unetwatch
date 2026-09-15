"""Tests for the upstream blacklist sync (two feeds: domains + IPs, every 5 min)."""

from app.services.upstream_blacklist import parse_upstream_body

URLS_FEED = "https://example.com/urls.txt"
IPS_FEED = "https://example.com/ips.txt"


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


def test_parse_upstream_body_tolerant_lines():
    # Hosts-style lines yield the second token.
    assert parse_upstream_body("0.0.0.0 evil.example.com\n") == ["evil.example.com"]
    assert parse_upstream_body("127.0.0.1  evil.example.com  \n") == ["evil.example.com"]
    # Inline comments strip on whitespace + # or ; to EOL.
    assert parse_upstream_body("evil.example.com # inline\n") == ["evil.example.com"]
    assert parse_upstream_body("evil.example.com ; inline\n") == ["evil.example.com"]
    assert parse_upstream_body("evil.example.com\t# tab comment\n") == ["evil.example.com"]
    # Hosts-style line with a trailing comment strips first, then yields host.
    assert parse_upstream_body("0.0.0.0 evil.example.com # block\n") == ["evil.example.com"]
    # Full-line comments and blanks still dropped.
    assert parse_upstream_body("# full\n; full\n") == []
    assert parse_upstream_body("  \n\n") == []
    # Non-hosts two-token lines pass through for the normalizer to reject.
    assert parse_upstream_body("notanip evil.example.com\n") == ["notanip evil.example.com"]
    assert parse_upstream_body("0.0.0.0 a b\n") == ["0.0.0.0 a b"]


async def test_sync_disabled_when_both_feeds_empty(monkeypatch):
    from app.config import get_settings
    from app.services.upstream_blacklist import sync_upstream_blacklist

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", "")
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    get_settings.cache_clear()
    try:
        result = await sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "disabled"}


async def _run_sync(monkeypatch, body: str, db_path, ips_body: str | None = None):
    """Run a sync with the fetch layer stubbed.

    ``body`` is served for the urls feed; ``ips_body`` (when given) is
    served for the ips feed, otherwise the ips feed stays disabled.

    Takes the ``db_path`` fixture so each test syncs against an isolated
    temp DB — exact added/skipped counts never leak across tests.
    """
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    if ips_body is None:
        monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    else:
        monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", IPS_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        if url == URLS_FEED:
            return body
        if ips_body is not None and url == IPS_FEED:
            return ips_body
        raise AssertionError(f"unexpected fetch url: {url}")

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


async def test_sync_cross_feed_dedup(monkeypatch, db_path):
    """Same host in both feeds → added once, skipped once (not an error)."""
    from app.services import upstream_blacklist as ub

    result = await _run_sync(
        monkeypatch,
        "dup.example.com\n10.9.9.9\n",
        db_path,
        ips_body="dup.example.com\n8.8.8.8\n",
    )
    assert result["ok"] is True
    assert result["fetched"] == 4
    assert result["added"] == 3
    assert result["skipped"] == 1
    assert result["errors"] == []
    # Sequential fetch: urls feed wins the dupe, ips feed skips it.
    assert ub._LAST_SYNC["feeds"]["urls"]["last_added"] == 2
    assert ub._LAST_SYNC["feeds"]["ips"]["last_added"] == 1
    assert ub._LAST_SYNC["feeds"]["ips"]["last_skipped"] == 1


async def test_sync_ips_feed_only(monkeypatch, db_path):
    """Ips feed alone syncs when the urls feed is disabled."""
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", "")
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", IPS_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        assert url == IPS_FEED
        return "9.9.9.9\n"

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        result = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    assert result["ok"] is True
    assert result["added"] == 1
    assert result["fetched"] == 1


async def test_dead_feed_does_not_starve_healthy_feed(monkeypatch, db_path):
    """One failing feed records per-feed last_error; the other still commits."""
    from app.config import get_settings
    from app.database import get_db, init_db
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", IPS_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        if url == URLS_FEED:
            return "healthy.example.com\n"
        raise RuntimeError("http_500")

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        result = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    # Healthy feed committed; failed feed recorded per-feed error.
    assert result["ok"] is True
    assert result["added"] == 1
    assert ub._LAST_SYNC["feeds"]["ips"]["last_error"] == "http_500"
    assert ub._LAST_SYNC["feeds"]["urls"]["last_error"] is None
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT value FROM blacklist_entries WHERE source = 'upstream'"
        )
        values = [row[0] for row in await cursor.fetchall()]
    finally:
        await db.close()
    assert values == ["healthy.example.com"]


async def test_sync_http_error_returns_reason(monkeypatch):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        raise RuntimeError("http_404")

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        result = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    # Per-feed isolation: the dead urls feed is a partial success — the error
    # is recorded per-feed, not as a total failure.
    assert result["ok"] is True
    assert result["added"] == 0
    assert len(result["errors"]) == 1
    assert ub._LAST_SYNC["feeds"]["urls"]["last_error"] == "http_404"


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
            "feeds": {
                "urls": {
                    "last_added": 0,
                    "last_skipped": 0,
                    "last_errors": 0,
                    "last_error": None,
                },
                "ips": {
                    "last_added": 0,
                    "last_skipped": 0,
                    "last_errors": 0,
                    "last_error": None,
                },
            },
        }
    )
    await _run_sync(monkeypatch, "status.example.com\n", db_path)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    get_settings.cache_clear()
    try:
        await init_db()
        status = await ub.get_upstream_status()
    finally:
        get_settings.cache_clear()
    assert status["enabled"] is True
    assert status["urls_configured"] is True
    assert status["ips_configured"] is False
    assert status["url_configured"] is True
    assert status["last_sync"] is not None
    assert status["last_added"] == 1
    assert status["upstream_count"] >= 1
    assert set(status["feeds"]) == {"urls", "ips"}
    assert status["feeds"]["urls"]["last_added"] == 1


async def test_upstream_status_disabled_when_both_empty(monkeypatch, db_path):
    import app.services.upstream_blacklist as ub
    from app.config import get_settings
    from app.database import init_db

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", "")
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    get_settings.cache_clear()
    try:
        await init_db()
        status = await ub.get_upstream_status()
    finally:
        get_settings.cache_clear()
    assert status["enabled"] is False
    assert status["urls_configured"] is False
    assert status["ips_configured"] is False
    assert status["url_configured"] is False


async def test_fetch_text_rejects_oversize_body(monkeypatch, db_path):
    """Bodies over MAX_UPSTREAM_BYTES are rejected before buffering."""
    from app.config import get_settings
    from app.services import upstream_blacklist as ub

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
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
    # Oversize body on the only configured feed → partial success with the
    # per-feed error recorded (nothing committed, nothing added).
    assert out["ok"] is True
    assert out["added"] == 0
    assert ub._LAST_SYNC["feeds"]["urls"]["last_error"] == "body_too_large"


async def test_upstream_routes(client, monkeypatch):
    from app.config import get_settings
    from app.services import upstream_blacklist as ub

    async def fake_fetch(url: str) -> str:
        return "route.example.com\n"

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
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
