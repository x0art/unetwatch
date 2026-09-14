"""Tests for the jaillist endpoints at /api/jaillist/ (spec-jaillist §3)."""

import asyncio

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app


def test_jaillist_add_plain_ip(client):
    resp = client.post("/api/jaillist/", json={"value": "1.2.3.4"})
    assert resp.status_code == 201
    assert resp.json()["added"] == ["1.2.3.4"]


def test_jaillist_add_strips_port(client):
    resp = client.post("/api/jaillist/", json={"value": "10.0.0.9:5678"})
    assert resp.status_code == 201
    assert resp.json()["added"] == ["10.0.0.9"]


def test_jaillist_add_canonicalizes_ipv6(client):
    resp = client.post("/api/jaillist/", json={"value": "2001:0DB8:0000::0001"})
    assert resp.status_code == 201
    assert resp.json()["added"] == ["2001:db8::1"]


def test_jaillist_add_duplicate_is_idempotent(client):
    first = client.post("/api/jaillist/", json={"value": "9.9.9.9"})
    assert first.status_code == 201
    assert first.json()["added"] == ["9.9.9.9"]

    second = client.post("/api/jaillist/", json={"value": "9.9.9.9"})
    assert second.status_code == 201
    assert second.json()["added"] == []

    # Same IP via a port suffix is still the same entry.
    third = client.post("/api/jaillist/", json={"value": "9.9.9.9:8080"})
    assert third.status_code == 201
    assert third.json()["added"] == []


def test_jaillist_add_invalid_values(client):
    for bad in [
        "evil.example.com",  # hostname
        "http://evil.example/x",  # URL
        "10.0.0.0/24",  # CIDR
        "",  # empty
        "not a url or ip",  # spaces
        "999.999.999.999",  # not an IP
    ]:
        resp = client.post("/api/jaillist/", json={"value": bad})
        assert resp.status_code in (400, 422), bad


async def test_jaillist_entries_shape(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO jaillist_entries (value) VALUES ('2.2.2.2')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO jaillist_entries (value) VALUES ('1.1.1.1')"
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/jaillist/entries")
    assert resp.status_code == 200
    assert resp.json() == {"ips": ["1.1.1.1", "2.2.2.2"]}


async def test_jaillist_feed_file_contains_crlf_entries(client):
    from app.database import get_db
    from app.services.feeds import sync_regenerate_jail

    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO jaillist_entries (value) VALUES ('3.3.3.3')"
        )
        await db.execute(
            "INSERT OR IGNORE INTO jaillist_entries (value) VALUES ('4.4.4.4')"
        )
        await db.commit()
        # Direct DB inserts bypass the API, which is what normally
        # regenerates the feed file — do it here so the file matches.
        await sync_regenerate_jail(db)
    finally:
        await db.close()

    resp = client.get("/api/jaillist/ips.txt")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.headers.get("cache-control") == "no-store"
    lines = resp.text.split("\r\n")
    assert "3.3.3.3" in lines
    assert "4.4.4.4" in lines
    # CRLF line terminators, terminated trailing line.
    assert "\r\n" in resp.text
    assert "\n" not in resp.text.replace("\r\n", "")


def test_jaillist_bulk_add(client):
    resp = client.post(
        "/api/jaillist/bulk",
        json={
            "values": [
                "5.5.5.5",
                "6.6.6.6:1234",  # normalizes to bare IP
                "5.5.5.5:80",  # duplicate within batch -> skipped
                "bad hostname here",  # invalid -> error
            ]
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert sorted(data["added"]) == ["5.5.5.5", "6.6.6.6"]
    assert data["skipped"] == ["5.5.5.5"]
    assert len(data["errors"]) == 1
    assert data["errors"][0]["value"] == "bad hostname here"

    # Feed was regenerated from the DB.
    assert "5.5.5.5" in client.get("/api/jaillist/ips.txt").text


def test_jaillist_bulk_add_invalid_payload(client):
    resp = client.post("/api/jaillist/bulk", json={"values": []})
    assert resp.status_code == 422


def test_jaillist_bulk_delete(client):
    client.post("/api/jaillist/bulk", json={"values": ["7.7.7.7", "8.8.8.8"]})

    resp = client.post(
        "/api/jaillist/bulk-delete",
        json={"values": ["7.7.7.7", "8.8.8.8", "9.9.9.0"]},  # absent -> skipped
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 2

    body = client.get("/api/jaillist/ips.txt").text
    assert "7.7.7.7" not in body
    assert "8.8.8.8" not in body


def test_jaillist_delete_entry(client):
    client.post("/api/jaillist/", json={"value": "11.11.11.11"})
    assert "11.11.11.11" in client.get("/api/jaillist/ips.txt").text

    resp = client.delete("/api/jaillist/11.11.11.11")
    assert resp.status_code == 204
    assert "11.11.11.11" not in client.get("/api/jaillist/ips.txt").text


def test_jaillist_delete_missing_returns_404(client):
    resp = client.delete("/api/jaillist/10.10.10.10")
    assert resp.status_code == 404


def test_jaillist_upstream_sync_disabled_when_env_empty(client, monkeypatch):
    """With no UPSTREAM_JAILLIST_URLS configured the sync returns disabled."""
    from app.config import get_settings

    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", "")
    get_settings.cache_clear()
    try:
        resp = client.post("/api/jaillist/upstream-sync")
    finally:
        get_settings.cache_clear()
    assert resp.status_code == 200
    assert resp.json() == {"ok": False, "reason": "disabled"}


def test_jaillist_upstream_status_shape(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", "")
    get_settings.cache_clear()
    try:
        resp = client.get("/api/jaillist/upstream-status")
    finally:
        get_settings.cache_clear()
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {
        "enabled",
        "urls_configured",
        "last_sync",
        "last_added",
        "last_skipped",
        "last_errors",
        "last_error",
        "upstream_count",
    }
    assert body["enabled"] is False
    assert body["urls_configured"] is False


def test_jaillist_upstream_routes_via_stubbed_fetch(client, monkeypatch):
    from app.config import get_settings
    from app.services import upstream_jaillist as uj

    async def fake_fetch(url: str) -> str:
        return "12.12.12.12\n"

    monkeypatch.setattr(uj, "_fetch_text", fake_fetch)
    monkeypatch.setenv("UPSTREAM_JAILLIST_URLS", "https://example.com/jail.txt")
    get_settings.cache_clear()
    try:
        resp = client.post("/api/jaillist/upstream-sync")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert resp.json()["added"] == 1

        status_resp = client.get("/api/jaillist/upstream-status")
        assert status_resp.status_code == 200
        body = status_resp.json()
        assert body["enabled"] is True
        assert body["urls_configured"] is True
        assert body["upstream_count"] >= 1
    finally:
        get_settings.cache_clear()


def test_jaillist_feeds_are_public(db_path):
    """The .txt feed is public for external integrations; write/list routes
    still require auth."""
    asyncio.run(init_db())

    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        r = c.get("/api/jaillist/ips.txt")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/plain")
        assert c.post("/api/jaillist/", json={"value": "1.2.3.4"}).status_code == 401
        assert c.get("/api/jaillist/entries").status_code == 401
