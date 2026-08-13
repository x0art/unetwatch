"""Tests for concrete-entry blacklist endpoints at /api/blacklist/."""

import asyncio

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app


def test_blacklist_add_url_normalized_to_fqdn(client):
    resp = client.post("/api/blacklist/", json={"value": "http://example.com/foo"})
    assert resp.status_code == 201
    assert resp.json()["added"] == ["example.com"]


def test_blacklist_add_bare_domain_with_path(client):
    resp = client.post("/api/blacklist/", json={"value": "example.com/foo/bar"})
    assert resp.status_code == 201
    assert resp.json()["added"] == ["example.com"]


def test_blacklist_add_lowercases_and_strips_port(client):
    resp = client.post(
        "/api/blacklist/", json={"value": "https://Evil.Example.COM:8443/deep/path?q=1"}
    )
    assert resp.status_code == 201
    assert resp.json()["added"] == ["evil.example.com"]


def test_blacklist_add_ip(client):
    resp = client.post("/api/blacklist/", json={"value": "1.2.3.4"})
    assert resp.status_code == 201
    assert "1.2.3.4" in resp.json()["added"]


def test_blacklist_add_url_with_ip_host_stores_ip_only(client):
    resp = client.post("/api/blacklist/", json={"value": "http://1.2.3.4/foo"})
    assert resp.status_code == 201
    assert resp.json()["added"] == ["1.2.3.4"]


def test_blacklist_add_duplicate_is_idempotent(client):
    first = client.post("/api/blacklist/", json={"value": "http://dup.example/x"})
    assert first.status_code == 201
    assert first.json()["added"] == ["dup.example"]

    second = client.post("/api/blacklist/", json={"value": "http://dup.example/x"})
    assert second.status_code == 201
    assert second.json()["added"] == []

    # Same host through a different scheme/port/path is still the same entry.
    third = client.post(
        "/api/blacklist/", json={"value": "https://dup.example:8443/other"}
    )
    assert third.status_code == 201
    assert third.json()["added"] == []


def test_blacklist_add_invalid_value(client):
    resp = client.post("/api/blacklist/", json={"value": "not a url or ip"})
    assert resp.status_code in (400, 422)


async def test_blacklist_urls_endpoint_returns_urls_only(client):
    from app.database import get_db
    from app.services.feeds import sync_regenerate

    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value) VALUES ('ip', '9.9.9.9')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'only.example')"
        )
        await db.commit()
        # Direct DB inserts bypass the API, which is what normally
        # regenerates the feed files — do it here so the files match.
        await sync_regenerate(db)
    finally:
        await db.close()

    resp = client.get("/api/blacklist/urls.txt")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\r\n")
    assert "only.example" in lines
    assert "9.9.9.9" not in lines
    # Feeds use CRLF line terminators (downstream integrations expect
    # Windows-style plain text: `file` reports "ASCII text, with CRLF
    # line terminators").
    assert "\r\n" in resp.text
    assert "\n" not in resp.text.replace("\r\n", "")


async def test_blacklist_ips_endpoint_returns_ips_only(client):
    from app.database import get_db
    from app.services.feeds import sync_regenerate

    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value) VALUES ('ip', '9.9.9.9')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'only.example')"
        )
        await db.commit()
        # Direct DB inserts bypass the API, which is what normally
        # regenerates the feed files — do it here so the files match.
        await sync_regenerate(db)
    finally:
        await db.close()

    resp = client.get("/api/blacklist/ips.txt")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\r\n")
    assert "9.9.9.9" in lines
    assert "only.example" not in lines
    # Feeds use CRLF line terminators (see test_blacklist_urls_endpoint_returns_urls_only).
    assert "\r\n" in resp.text
    assert "\n" not in resp.text.replace("\r\n", "")


async def test_blacklist_entries_returns_split(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value) VALUES ('ip', '1.1.1.1')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'a.example')"
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/blacklist/entries")
    assert resp.status_code == 200
    data = resp.json()
    assert data["urls"] == ["a.example"]
    assert data["ips"] == ["1.1.1.1"]


async def test_blacklist_migration_normalizes_legacy_entries(db_path):
    """Startup migration strips protocol/path and re-classifies IP hosts."""
    from app.database import get_db, init_db

    await init_db()

    db = await get_db()
    try:
        await db.execute("DELETE FROM blacklist_entries")
        await db.execute(
            "INSERT INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'http://Legacy.Example/foo')"
        )
        await db.execute(
            "INSERT INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'http://10.0.0.9/x')"
        )
        await db.execute(
            "INSERT INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'plain.example/path')"
        )
        await db.commit()
    finally:
        await db.close()

    await init_db()  # re-run the startup migration over the legacy rows

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT kind, value FROM blacklist_entries ORDER BY kind, value"
        )
        entries = [(r["kind"], r["value"]) for r in await cursor.fetchall()]
    finally:
        await db.close()

    assert ("url", "legacy.example") in entries
    assert ("url", "plain.example") in entries
    assert ("ip", "10.0.0.9") in entries
    assert not any(k == "url" and v.startswith("http") for k, v in entries)


def test_blacklist_bulk_add(client):
    resp = client.post(
        "/api/blacklist/bulk",
        json={
            "values": [
                "http://a.example/foo",
                "b.example",
                "1.2.3.4",
                "http://1.2.3.4/x",  # normalizes to the same IP -> skipped
                "not a url or ip",  # invalid -> error
            ]
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert sorted(data["added"]) == ["1.2.3.4", "a.example", "b.example"]
    # http://1.2.3.4/x normalizes to the same IP -> skipped (already added in this batch)
    assert data["skipped"] == ["1.2.3.4"]
    assert len(data["errors"]) == 1
    assert data["errors"][0]["value"] == "not a url or ip"

    # Feeds were regenerated from the DB.
    assert "a.example" in client.get("/api/blacklist/urls.txt").text
    assert "1.2.3.4" in client.get("/api/blacklist/ips.txt").text


def test_blacklist_bulk_add_duplicate_within_batch(client):
    resp = client.post(
        "/api/blacklist/bulk",
        json={"values": ["x.example", "http://x.example/", "x.example"]},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["added"] == ["x.example"]
    # Both later occurrences are within-batch duplicates.
    assert data["skipped"] == ["x.example", "x.example"]
    assert data["errors"] == []


def test_blacklist_bulk_add_invalid_payload(client):
    resp = client.post("/api/blacklist/bulk", json={"values": []})
    assert resp.status_code == 422


def test_blacklist_bulk_delete(client):
    client.post("/api/blacklist/bulk", json={"values": ["a.example", "b.example", "1.2.3.4"]})

    resp = client.post(
        "/api/blacklist/bulk-delete",
        json={
            "entries": [
                {"kind": "url", "value": "a.example"},
                {"kind": "ip", "value": "1.2.3.4"},
                {"kind": "url", "value": "missing.example"},  # not present -> skipped
            ]
        },
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 2

    # Feeds were regenerated.
    assert "a.example" not in client.get("/api/blacklist/urls.txt").text
    assert "1.2.3.4" not in client.get("/api/blacklist/ips.txt").text
    assert "b.example" in client.get("/api/blacklist/urls.txt").text


def test_blacklist_bulk_delete_invalid_payload(client):
    resp = client.post("/api/blacklist/bulk-delete", json={"entries": []})
    assert resp.status_code == 422


def test_blacklist_delete_entry(client):
    client.post("/api/blacklist/", json={"value": "http://del.example/x"})
    assert "del.example" in client.get("/api/blacklist/urls.txt").text

    resp = client.delete("/api/blacklist/url/del.example")
    assert resp.status_code == 204
    assert "del.example" not in client.get("/api/blacklist/urls.txt").text


def test_blacklist_feeds_are_never_heuristically_cached(client):
    """The admin UI reloads the plain-text feeds after every add/delete, and
    external integrations (nginx, fail2ban) depend on the current list. Without
    a Cache-Control header, FileResponse's ETag/Last-Modified make browsers
    apply *heuristic* caching (freshness ~ 10% of time since the file was last
    written), so a feed rewritten only at startup/mutation can be served stale
    from cache — the newly added entry never appears. The feeds must be
    explicitly marked non-cacheable."""
    for path in ("/api/blacklist/urls.txt", "/api/blacklist/ips.txt"):
        resp = client.get(path)
        assert resp.status_code == 200
        assert resp.headers.get("cache-control") == "no-store"

    # Sanity: a re-fetch after an add still returns the new entry.
    resp = client.post("/api/blacklist/", json={"value": "http://fresh.example/x"})
    assert resp.status_code == 201
    assert "fresh.example" in client.get("/api/blacklist/urls.txt").text


def test_blacklist_delete_ip_entry(client):
    client.post("/api/blacklist/", json={"value": "5.6.7.8"})
    assert "5.6.7.8" in client.get("/api/blacklist/ips.txt").text

    resp = client.delete("/api/blacklist/ip/5.6.7.8")
    assert resp.status_code == 204
    assert "5.6.7.8" not in client.get("/api/blacklist/ips.txt").text


def test_blacklist_delete_missing_returns_404(client):
    resp = client.delete("/api/blacklist/url/nope.example")
    assert resp.status_code == 404


def test_blacklist_delete_invalid_kind(client):
    resp = client.delete("/api/blacklist/domain/example.com")
    assert resp.status_code == 422


def test_blacklist_feeds_are_public(db_path):
    """The .txt feeds are served as real files without auth for external
    integrations; write/list routes still require auth."""
    asyncio.run(init_db())

    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        # Feed files exist (regenerated at startup) and are public.
        r = c.get("/api/blacklist/urls.txt")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/plain")
        r2 = c.get("/api/blacklist/ips.txt")
        assert r2.status_code == 200
        assert r2.headers["content-type"].startswith("text/plain")
        # Write/list routes still require auth.
        assert c.post("/api/blacklist/", json={"value": "http://x.example"}).status_code == 401
        assert c.get("/api/blacklist/entries").status_code == 401
