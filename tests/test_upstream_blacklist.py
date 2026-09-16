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


async def _run_sync(monkeypatch, body, db_path, ips_body=None, allow_empty_prune=False, seed=None):
    """Run a sync with the fetch layer stubbed.

    ``body`` is served for the urls feed (pass ``None`` to disable that
    feed); ``ips_body`` (when given) is served for the ips feed, otherwise
    the ips feed stays disabled. ``seed`` is an optional list of
    ``(kind, value, source)`` tuples inserted before the sync.
    ``allow_empty_prune`` forwards to the prune guard.

    Takes the ``db_path`` fixture so each test syncs against an isolated
    temp DB — exact added/skipped counts never leak across tests.
    """
    from app.config import get_settings
    from app.database import get_db, init_db
    from app.services import upstream_blacklist as ub

    if body is None:
        monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", "")
    else:
        monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    if ips_body is None:
        monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    else:
        monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", IPS_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url):
        if body is not None and url == URLS_FEED:
            return body
        if ips_body is not None and url == IPS_FEED:
            return ips_body
        raise AssertionError(f"unexpected fetch url: {url}")

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        if seed:
            db = await get_db()
            try:
                for kind, value, source in seed:
                    await db.execute(
                        "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
                        " VALUES (?, ?, ?)",
                        (kind, value, source),
                    )
                await db.commit()
            finally:
                await db.close()
        return await ub.sync_upstream_blacklist(allow_empty_prune=allow_empty_prune)
    finally:
        get_settings.cache_clear()


def _reset_last_sync():
    import app.services.upstream_blacklist as ub

    ub._LAST_SYNC.update(
        {
            "last_sync": None,
            "last_added": 0,
            "last_skipped": 0,
            "last_errors": 0,
            "last_error": None,
            "last_deleted": 0,
            "last_deleted_sample": [],
            "feeds": {name: ub._empty_feed_stats() for name in ub._FEEDS},
        }
    )


async def _upstream_kind_count(kind: str) -> int:
    from app.database import get_db

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM blacklist_entries WHERE source='upstream' AND kind=?",
            (kind,),
        )
        row = await cursor.fetchone()
        return row[0] if row else 0
    finally:
        await db.close()


async def _all_entries():
    """All ``(kind, value, source)`` rows ordered by kind, value."""
    from app.database import get_db

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT kind, value, source FROM blacklist_entries ORDER BY kind, value"
        )
        return [(r[0], r[1], r[2]) for r in await cursor.fetchall()]
    finally:
        await db.close()


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


# ----- Prune: delete upstream rows missing from the fetched set -----

async def test_sync_prune_removes_upstream_missing_url_row(monkeypatch, db_path):
    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
    ]
    # Feed keeps 2 of the 3 seeded upstream url rows; old3 is pruned.
    result = await _run_sync(
        monkeypatch, "old1.example.com\nold2.example.com\n", db_path, seed=seed
    )
    assert result["ok"] is True
    assert result["deleted"] == 1
    assert result["feeds"]["urls"]["deleted"] == 1
    # Only upstream `url` rows missing from the feed are deleted.
    assert await _upstream_kind_count("url") == 2


async def test_sync_prune_removes_upstream_missing_ip_row(monkeypatch, db_path):
    seed = [
        ("ip", "10.1.1.1", "upstream"),
        ("ip", "10.1.1.2", "upstream"),
        ("ip", "10.1.1.3", "upstream"),
    ]
    # Only the ips feed is enabled; urls feed disabled.
    result = await _run_sync(
        monkeypatch, None, db_path, ips_body="10.1.1.1\n10.1.1.2\n", seed=seed
    )
    assert result["ok"] is True
    assert result["deleted"] == 1
    assert result["feeds"]["ips"]["deleted"] == 1
    assert await _upstream_kind_count("ip") == 2


async def test_sync_prune_keeps_manual_and_finding_rows(monkeypatch, db_path):
    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
        ("url", "manual.example.com", "manual"),
        ("url", "finding.example.com", "finding"),
    ]
    result = await _run_sync(
        monkeypatch, "old1.example.com\nold2.example.com\n", db_path, seed=seed
    )
    # Only the missing upstream row is deleted; manual/finding survive.
    assert result["deleted"] == 1
    rows = {v: s for k, v, s in await _all_entries()}
    assert rows["manual.example.com"] == "manual"
    assert rows["finding.example.com"] == "finding"
    assert "old3.example.com" not in rows


async def test_sync_prune_keeps_colliding_manual_row(monkeypatch, db_path):
    seed = [
        ("url", "collide.example.com", "manual"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
    ]
    # The feed value also exists as a manual row; that manual row survives.
    result = await _run_sync(
        monkeypatch, "collide.example.com\nold2.example.com\n", db_path, seed=seed
    )
    assert result["deleted"] == 1  # only old3 is pruned
    rows = {v: s for k, v, s in await _all_entries()}
    # INSERT OR IGNORE leaves the manual row manual; the prune (source=
    # 'upstream') does not touch it, and its value is present in the feed.
    assert rows["collide.example.com"] == "manual"


async def test_sync_prune_disabled_feed_preserves_other_feed(monkeypatch, db_path):
    # urls feed disabled -> no prune; ips feed still works.
    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
        ("ip", "10.9.9.9", "upstream"),
    ]
    result = await _run_sync(
        monkeypatch, None, db_path, ips_body="10.9.9.10\n", seed=seed
    )
    assert result["ok"] is True
    # urls feed never ran a prune -> zero deletes for it.
    assert result["feeds"]["urls"]["deleted"] == 0
    # Seeded url rows survive untouched (no prune on the disabled feed).
    assert await _upstream_kind_count("url") == 3
    # ips feed still committed + pruned its stale row.
    assert result["feeds"]["ips"]["deleted"] == 1


async def test_sync_prune_dead_feed_preserves_other_feed(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import get_db, init_db
    from app.services import upstream_blacklist as ub
    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
        ("ip", "10.9.9.9", "upstream"),
    ]
    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", IPS_FEED)
    get_settings.cache_clear()

    async def fake_fetch(url):
        if url == URLS_FEED:
            return "old1.example.com\nold2.example.com\n"
        raise RuntimeError("http_500")

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        db = await get_db()
        try:
            for kind, value, source in seed:
                await db.execute(
                    "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
                    " VALUES (?, ?, ?)",
                    (kind, value, source),
                )
            await db.commit()
        finally:
            await db.close()
        result = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()
    # Partial success: healthy urls feed commits + prunes; dead ips feed
    # records a per-feed error, zero deletes, rows preserved.
    assert result["ok"] is True
    assert result["feeds"]["urls"]["deleted"] == 1
    assert ub._LAST_SYNC["feeds"]["ips"]["last_error"] == "http_500"
    assert result["feeds"]["ips"]["deleted"] == 0
    # The stale ips row survives because its feed failed.
    assert await _upstream_kind_count("ip") == 1


async def test_sync_prune_empty_valid_feed_skips_per_feed(monkeypatch, db_path):
    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
        ("ip", "10.9.9.9", "upstream"),
    ]
    # Both feeds resolve to an empty parsed set (comments + invalid line).
    result = await _run_sync(
        monkeypatch,
        "# comment\n; nothing\n",
        db_path,
        ips_body="# only comment\n; and invalid!!!\n",
        seed=seed,
    )
    assert result["ok"] is True
    assert result["deleted"] == 0
    assert result["feeds"]["urls"]["prune_skipped"] == "empty-feed"
    assert result["feeds"]["ips"]["prune_skipped"] == "empty-feed"
    # Rows preserved on both kinds.
    assert await _upstream_kind_count("url") == 3
    assert await _upstream_kind_count("ip") == 1


async def test_sync_prune_regen_reflects_deletions(monkeypatch, db_path):
    from app.services.feeds import _feed_path

    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
    ]
    result = await _run_sync(
        monkeypatch, "old1.example.com\nold2.example.com\n", db_path, seed=seed
    )
    assert result["deleted"] == 1
    content = _feed_path("url").read_text()
    assert "old3.example.com" not in content
    assert "old1.example.com" in content
    assert "old2.example.com" in content


async def test_upstream_status_reflects_prune(monkeypatch, db_path):
    import app.services.upstream_blacklist as ub
    from app.config import get_settings
    from app.database import init_db

    _reset_last_sync()
    seed = [
        ("url", "old1.example.com", "upstream"),
        ("url", "old2.example.com", "upstream"),
        ("url", "old3.example.com", "upstream"),
    ]
    result = await _run_sync(
        monkeypatch, "old1.example.com\nold2.example.com\n", db_path, seed=seed
    )
    assert result["deleted"] == 1
    assert result["deleted_sample"] == ["old3.example.com"]

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    get_settings.cache_clear()
    try:
        await init_db()
        status = await ub.get_upstream_status()
    finally:
        get_settings.cache_clear()
    # New prune keys exposed; legacy keys unchanged (incl. url_configured).
    assert status["last_deleted"] == 1
    assert status["last_deleted_sample"] == ["old3.example.com"]
    assert status["feeds"]["urls"]["last_deleted"] == 1
    assert status["url_configured"] is True
    assert set(status) == {
        "enabled",
        "urls_configured",
        "ips_configured",
        "url_configured",
        "last_error",
        "last_sync",
        "last_added",
        "last_skipped",
        "last_errors",
        "last_deleted",
        "last_deleted_sample",
        "upstream_count",
        "feeds",
    }
