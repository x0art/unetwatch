"""Tests for concrete-entry blacklist endpoints at /api/blacklist/."""

import asyncio

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app


def test_blacklist_add_url(client):
    resp = client.post("/api/blacklist/", json={"value": "http://example.com/foo"})
    assert resp.status_code == 201
    assert "http://example.com/foo" in resp.json()["added"]


def test_blacklist_add_ip(client):
    resp = client.post("/api/blacklist/", json={"value": "1.2.3.4"})
    assert resp.status_code == 201
    assert "1.2.3.4" in resp.json()["added"]


def test_blacklist_add_url_with_ip_host(client):
    resp = client.post("/api/blacklist/", json={"value": "http://1.2.3.4/foo"})
    assert resp.status_code == 201
    added = resp.json()["added"]
    assert "http://1.2.3.4/foo" in added
    assert "1.2.3.4" in added


def test_blacklist_add_duplicate_is_idempotent(client):
    first = client.post("/api/blacklist/", json={"value": "http://dup.example/x"})
    assert first.status_code == 201
    assert first.json()["added"] == ["http://dup.example/x"]

    second = client.post("/api/blacklist/", json={"value": "http://dup.example/x"})
    assert second.status_code == 201
    assert second.json()["added"] == []


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
            " VALUES ('url', 'http://only.example/a')"
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/blacklist/urls")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\n")
    assert "http://only.example/a" in lines
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
            " VALUES ('url', 'http://only.example/a')"
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/blacklist/ips")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\n")
    assert "9.9.9.9" in lines
    assert "http://only.example/a" not in lines


async def test_blacklist_entries_returns_split(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value) VALUES ('ip', '1.1.1.1')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
            " VALUES ('url', 'http://a.example/x')"
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/blacklist/entries")
    assert resp.status_code == 200
    data = resp.json()
    assert data["urls"] == ["http://a.example/x"]
    assert data["ips"] == ["1.1.1.1"]


def test_blacklist_requires_auth(db_path):
    """Endpoints are mounted with verify_admin; requests without auth -> 401."""
    asyncio.run(init_db())

    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        r = c.get("/api/blacklist/urls")
        assert r.status_code == 401
        r2 = c.get("/api/blacklist/ips")
        assert r2.status_code == 401
