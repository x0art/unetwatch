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
    finally:
        await db.close()

    resp = client.get("/api/blacklist/urls")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\n")
    assert "only.example" in lines
    assert "9.9.9.9" not in lines


async def test_blacklist_ips_endpoint_returns_ips_only(client):
    from app.database import get_db

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
    finally:
        await db.close()

    resp = client.get("/api/blacklist/ips")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\n")
    assert "9.9.9.9" in lines
    assert "only.example" not in lines


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


def test_blacklist_delete_entry(client):
    client.post("/api/blacklist/", json={"value": "http://del.example/x"})
    assert "del.example" in client.get("/api/blacklist/urls").text

    resp = client.delete("/api/blacklist/url/del.example")
    assert resp.status_code == 204
    assert "del.example" not in client.get("/api/blacklist/urls").text


def test_blacklist_delete_ip_entry(client):
    client.post("/api/blacklist/", json={"value": "5.6.7.8"})
    assert "5.6.7.8" in client.get("/api/blacklist/ips").text

    resp = client.delete("/api/blacklist/ip/5.6.7.8")
    assert resp.status_code == 204
    assert "5.6.7.8" not in client.get("/api/blacklist/ips").text


def test_blacklist_delete_missing_returns_404(client):
    resp = client.delete("/api/blacklist/url/nope.example")
    assert resp.status_code == 404


def test_blacklist_delete_invalid_kind(client):
    resp = client.delete("/api/blacklist/domain/example.com")
    assert resp.status_code == 422


def test_blacklist_requires_auth(db_path):
    """Endpoints are mounted with verify_admin; requests without auth -> 401."""
    asyncio.run(init_db())

    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        r = c.get("/api/blacklist/urls")
        assert r.status_code == 401
        r2 = c.get("/api/blacklist/ips")
        assert r2.status_code == 401
