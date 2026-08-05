"""Tests for plain-text blacklist endpoints at /api/blacklist/."""

import asyncio

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app


def test_blacklist_urls_returns_text_plain(client):
    client.post("/api/patterns/", json={"pattern": "*porn*", "pattern_type": "block"})
    client.post("/api/patterns/", json={"pattern": "*gambling*", "pattern_type": "block"})
    resp = client.get("/api/blacklist/urls")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    body = resp.text
    lines = body.split("\n")
    assert "*porn*" in lines
    assert "*gambling*" in lines


async def test_blacklist_urls_empty_when_no_block_patterns(client):
    from app.database import get_db

    # The startup seed populates default block patterns; clear them so this
    # test exercises the genuinely-empty path.
    db = await get_db()
    try:
        await db.execute("DELETE FROM url_patterns")
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/blacklist/urls")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.text == ""


async def test_blacklist_ips_returns_distinct_ips(client):
    from app.database import get_db

    client.post("/api/patterns/", json={"pattern": "evil", "pattern_type": "block"})

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                "1.2.3.4",
                "10.0.0.1",
                "http://evil.example/a",
                "evil.example",
                "2026-08-05T00:00:00Z",
            ),
        )
        await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                "1.2.3.4",
                "10.0.0.1",
                "http://evil.example/b",
                "evil.example",
                "2026-08-05T00:01:00Z",
            ),
        )
        await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                "5.6.7.8",
                "10.0.0.2",
                "http://evil.example/c",
                "evil.example",
                "2026-08-05T00:02:00Z",
            ),
        )
        await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                "9.9.9.9",
                "10.0.0.3",
                "http://safe.example/d",
                "safe.example",
                "2026-08-05T00:03:00Z",
            ),
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/blacklist/ips")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    lines = resp.text.split("\n")
    assert "1.2.3.4" in lines
    assert "5.6.7.8" in lines
    assert "9.9.9.9" not in lines
    # duplicates de-duped
    assert lines.count("1.2.3.4") == 1


def test_blacklist_requires_auth(db_path):
    """Endpoints are mounted with verify_admin; requests without auth → 401."""
    asyncio.run(init_db())

    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        r = c.get("/api/blacklist/urls")
        assert r.status_code == 401
        r2 = c.get("/api/blacklist/ips")
        assert r2.status_code == 401
