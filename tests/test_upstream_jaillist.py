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
            "last_deleted": 0,
            "last_deleted_sample": [],
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


async def _run_sync(monkeypatch, body: str, db_path, allow_empty_prune: bool = False):
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
        return await uj.sync_upstream_jaillist(
            allow_empty_prune=allow_empty_prune
        )
    finally:
        get_settings.cache_clear()


async def _all_entries():
    """All ``(value, source)`` rows ordered by value."""
    from app.database import get_db

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT value, source FROM jaillist_entries ORDER BY value"
        )
        return [(row[0], row[1]) for row in await cursor.fetchall()]
    finally:
        await db.close()


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
        "last_deleted",
        "last_deleted_sample",
        "upstream_count",
    }
    assert status["enabled"] is True
    assert status["urls_configured"] is True
    assert status["last_sync"] is not None
    assert status["last_added"] == 1
    assert status["last_skipped"] == 0
    assert status["last_errors"] == 0
    assert status["last_error"] is None
    assert status["last_deleted"] == 0
    assert status["last_deleted_sample"] == []
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


async def _seed(rows):
    """Insert ``(value, source)`` rows directly into jaillist_entries."""
    from app.database import get_db

    db = await get_db()
    try:
        for value, source in rows:
            await db.execute(
                "INSERT OR IGNORE INTO jaillist_entries (value, source)"
                " VALUES (?, ?)",
                (value, source),
            )
        await db.commit()
    finally:
        await db.close()


async def _upstream_count():
    from app.database import get_db

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM jaillist_entries WHERE source = 'upstream'"
        )
        row = await cursor.fetchone()
        return row[0] if row else 0
    finally:
        await db.close()


async def test_sync_prune_removes_upstream_missing_row(monkeypatch, db_path):
    from app.database import init_db

    await init_db()
    await _seed([
        ("10.1.1.1", "upstream"),
        ("10.1.1.2", "upstream"),
        ("10.1.1.3", "upstream"),
    ])
    # Feed lists only two of the three seeded upstream IPs.
    result = await _run_sync(monkeypatch, "10.1.1.1\n10.1.1.2\n", db_path)
    assert result["ok"] is True
    assert result["deleted"] == 1
    assert await _upstream_count() == 2


async def test_sync_prune_keeps_manual_and_finding_rows(monkeypatch, db_path):
    from app.database import init_db

    await init_db()
    await _seed([
        ("10.2.1.1", "upstream"),
        ("10.2.1.2", "upstream"),
        ("10.2.1.3", "upstream"),
        ("10.2.9.9", "manual"),
        ("10.2.9.8", "finding"),
    ])
    result = await _run_sync(monkeypatch, "10.2.1.1\n10.2.1.2\n", db_path)
    # Only the missing upstream row is deleted; manual/finding survive and
    # are never counted.
    assert result["deleted"] == 1
    rows = {v: s for v, s in await _all_entries()}
    assert rows["10.2.9.9"] == "manual"
    assert rows["10.2.9.8"] == "finding"
    assert "10.2.1.3" not in rows


async def test_sync_prune_keeps_colliding_manual_row(monkeypatch, db_path):
    from app.database import init_db

    await init_db()
    # A pre-existing manual entry whose value ALSO appears in the feed.
    await _seed([
        ("10.3.1.1", "manual"),
        ("10.3.1.2", "upstream"),
        ("10.3.1.3", "upstream"),
    ])
    result = await _run_sync(monkeypatch, "10.3.1.1\n10.3.1.2\n", db_path)
    assert result["deleted"] == 1  # only 10.3.1.3 pruned
    rows = {v: s for v, s in await _all_entries()}
    # The manual row stays manual (INSERT OR IGNORE leaves it untouched)
    # and survives the prune because its value is present in the feed.
    assert rows["10.3.1.1"] == "manual"


async def test_sync_prune_disabled_preserves_rows(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    await init_db()
    await _seed([
        ("10.4.1.1", "upstream"),
        ("10.4.1.2", "upstream"),
        ("10.4.1.3", "upstream"),
    ])
    _reset_last_sync()
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", "")
    get_settings.cache_clear()
    try:
        result = await uj.sync_upstream_jaillist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "disabled"}
    # No DB open / no prune — all seeded rows survive.
    assert await _upstream_count() == 3


async def test_sync_prune_fetch_failure_preserves_rows(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    await init_db()
    await _seed([
        ("10.5.1.1", "upstream"),
        ("10.5.1.2", "upstream"),
        ("10.5.1.3", "upstream"),
    ])
    _reset_last_sync()
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", JAIL_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        raise RuntimeError("http_404")

    monkeypatch.setattr(uj, "_fetch_text", fake_fetch)
    try:
        result = await uj.sync_upstream_jaillist()
    finally:
        get_settings.cache_clear()
    assert result == {"ok": False, "reason": "http_404"}
    # Zero deletes: _LAST_SYNC preserved, rows intact.
    assert uj._LAST_SYNC["last_deleted"] == 0
    assert uj._LAST_SYNC["last_error"] == "http_404"
    assert await _upstream_count() == 3


async def test_sync_prune_empty_valid_feed_skips(monkeypatch, db_path):
    from app.database import init_db

    await init_db()
    await _seed([
        ("10.6.1.1", "upstream"),
        ("10.6.1.2", "upstream"),
        ("10.6.1.3", "upstream"),
    ])
    # Comments + an invalid line only -> empty parsed set.
    body = "# just a comment\n; another\nnot-an-ip-at-all!!!\n"
    result = await _run_sync(monkeypatch, body, db_path)
    assert result["ok"] is True
    assert result["deleted"] == 0
    assert result["prune_skipped"] == "empty-feed"
    # Rows preserved.
    assert await _upstream_count() == 3


async def test_sync_prune_allow_empty_wipes(monkeypatch, db_path):
    from app.database import init_db

    await init_db()
    await _seed([
        ("10.7.1.1", "upstream"),
        ("10.7.1.2", "upstream"),
        ("10.7.1.3", "upstream"),
    ])
    # Comment-only feed + explicit wipe.
    result = await _run_sync(
        monkeypatch, "# comment only\n", db_path, allow_empty_prune=True
    )
    assert result["ok"] is True
    assert result["deleted"] == 3
    assert await _upstream_count() == 0


async def test_sync_prune_regen_reflects_deletions(monkeypatch, db_path):
    from app.database import init_db
    from app.services.feeds import jail_feed_path

    await init_db()
    await _seed([
        ("10.8.1.1", "upstream"),
        ("10.8.1.2", "upstream"),
        ("10.8.1.3", "upstream"),
    ])
    result = await _run_sync(monkeypatch, "10.8.1.1\n10.8.1.2\n", db_path)
    assert result["deleted"] == 1
    content = jail_feed_path().read_text()
    assert "10.8.1.3" not in content
    assert "10.8.1.1" in content
    assert "10.8.1.2" in content


async def test_sync_prune_status_reflects_deleted(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import init_db
    from app.services import upstream_jaillist as uj

    await init_db()
    await _seed([
        ("10.9.1.1", "upstream"),
        ("10.9.1.2", "upstream"),
        ("10.9.1.3", "upstream"),
    ])
    result = await _run_sync(monkeypatch, "10.9.1.1\n10.9.1.2\n", db_path)
    assert result["deleted"] == 1
    assert result["deleted_sample"] == ["10.9.1.3"]

    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", JAIL_FEED)
    get_settings.cache_clear()
    try:
        status = await uj.get_upstream_status()
    finally:
        get_settings.cache_clear()
    # New keys exposed; legacy keys unchanged in shape.
    assert status["last_deleted"] == 1
    assert status["last_deleted_sample"] == ["10.9.1.3"]
    assert status["upstream_count"] == 2
    assert set(status) == {
        "enabled",
        "urls_configured",
        "last_sync",
        "last_added",
        "last_skipped",
        "last_errors",
        "last_error",
        "last_deleted",
        "last_deleted_sample",
        "upstream_count",
    }
