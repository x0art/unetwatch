"""Tests for the redirect tracker: /api/redirects endpoints + checker service."""

import asyncio

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app


def test_is_valid_url():
    from app.services.redirects import is_valid_url

    assert is_valid_url("http://example.com/a")
    assert is_valid_url("https://example.com")
    assert not is_valid_url("example.com/a")
    assert not is_valid_url("http://exa mple.com/x")
    assert not is_valid_url("ftp://example.com/a")


async def test_check_url_follows_chain_and_detects_change(client, monkeypatch):
    from app.services import redirects as svc

    # Track one URL via the API
    r = client.post("/api/redirects/", json={"url": "http://a.example/1"})
    assert r.status_code == 201
    tracked_id = r.json()["id"]
    assert tracked_id > 0

    calls = {"n": 0}

    async def fake_check(session, url):
        calls["n"] += 1
        if calls["n"] == 1:
            return (
                [("http://a.example/1", "http://b.example/2", 301)],
                301,
                "http://b.example/2",
                None,
            )
        # Later check: a.example/1 now points at c.example/3
        return (
            [("http://a.example/1", "http://c.example/3", 301)],
            301,
            "http://c.example/3",
            None,
        )

    monkeypatch.setattr(svc, "check_url", fake_check)

    first = client.post("/api/redirects/check")
    assert first.status_code == 200
    assert first.json()["checked"] == 1

    # Target auto-added to the tracked list
    listed = client.get("/api/redirects/").json()["items"]
    urls = {i["url"] for i in listed}
    assert "http://b.example/2" in urls

    # Second check: new target recorded, old edge deactivated
    second = client.post("/api/redirects/check")
    assert second.status_code == 200
    assert second.json()["updated"][0]["status"] == "redirect"

    from app.database import get_db

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT target_url, active FROM redirect_edges WHERE source_url = ?"
            " ORDER BY target_url",
            ("http://a.example/1",),
        )
        edges = await cur.fetchall()
    finally:
        await db.close()

    assert {e["target_url"]: e["active"] for e in edges} == {
        "http://b.example/2": 0,
        "http://c.example/3": 1,
    }


async def test_check_all_ok_status(client, monkeypatch):
    from app.services import redirects as svc

    client.post("/api/redirects/", json={"url": "http://ok.example/x"})

    async def fake_check(session, url):
        return [], 200, url, None

    monkeypatch.setattr(svc, "check_url", fake_check)

    resp = client.post("/api/redirects/check")
    assert resp.status_code == 200
    assert resp.json()["updated"][0]["status"] == "ok"

    item = client.get("/api/redirects/").json()["items"][0]
    assert item["status"] == "ok"
    assert item["http_status"] == 200
    assert item["last_checked_at"] is not None


def test_redirects_add_invalid_url(client):
    resp = client.post("/api/redirects/", json={"url": "example.com/a"})
    assert resp.status_code in (400, 422)
    resp2 = client.post("/api/redirects/", json={"url": "http://exa mple.com/x"})
    assert resp2.status_code in (400, 422)


def test_redirects_add_duplicate(client):
    first = client.post("/api/redirects/", json={"url": "http://dup.example/x"})
    assert first.status_code == 201
    second = client.post("/api/redirects/", json={"url": "http://dup.example/x"})
    assert second.status_code == 409


def test_redirects_list_empty(client):
    resp = client.get("/api/redirects/")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0}


def test_redirects_list_search(client):
    client.post("/api/redirects/", json={"url": "http://alpha.example/a"})
    client.post("/api/redirects/", json={"url": "http://beta.example/b"})
    hit = client.get("/api/redirects/?search=alpha").json()
    assert hit["total"] == 1 and hit["items"][0]["url"] == "http://alpha.example/a"
    miss = client.get("/api/redirects/?search=nope").json()
    assert miss["total"] == 0


async def test_redirects_delete_keeps_edges(client):
    from app.database import get_db

    resp = client.post("/api/redirects/", json={"url": "http://gone.example/x"})
    tracked_id = resp.json()["id"]

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 301, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 1)",
            ("http://gone.example/x", "http://target.example/y"),
        )
        await db.commit()
    finally:
        await db.close()

    deleted = client.delete(f"/api/redirects/{tracked_id}")
    assert deleted.status_code == 204
    assert client.get("/api/redirects/").json()["total"] == 0

    db = await get_db()
    try:
        cur = await db.execute("SELECT COUNT(*) AS n FROM redirect_edges")
        assert (await cur.fetchone())["n"] == 1
    finally:
        await db.close()


async def test_redirects_graph_shape(client):
    from app.database import get_db

    client.post("/api/redirects/", json={"url": "http://g1.example/a"})
    client.post("/api/redirects/", json={"url": "http://g2.example/b"})

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 301, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 1)",
            ("http://g1.example/a", "http://g2.example/b"),
        )
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 302, '2026-08-05T00:00:00', '2026-08-05T00:00:00', 0)",
            ("http://g1.example/a", "http://old.example/x"),
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/redirects/graph")
    assert resp.status_code == 200
    data = resp.json()
    assert {n["id"] for n in data["nodes"]} == {"http://g1.example/a", "http://g2.example/b"}
    assert len(data["links"]) == 2
    active = [link for link in data["links"] if link["active"]]
    assert active == [
        {
            "source": "http://g1.example/a",
            "target": "http://g2.example/b",
            "http_status": 301,
            "active": True,
        }
    ]


async def test_redirects_history(client):
    from app.database import get_db

    resp = client.post("/api/redirects/", json={"url": "http://h1.example/a"})
    tracked_id = resp.json()["id"]

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 301, '2026-08-05T00:00:00', '2026-08-05T00:00:00', 0)",
            ("http://h1.example/a", "http://old.example/x"),
        )
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 302, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 1)",
            ("http://h1.example/a", "http://new.example/y"),
        )
        await db.commit()
    finally:
        await db.close()

    data = client.get(f"/api/redirects/{tracked_id}/history").json()
    assert data["url"] == "http://h1.example/a"
    active = [e for e in data["edges"] if e["active"]]
    assert len(active) == 1 and active[0]["target_url"] == "http://new.example/y"


def test_redirects_requires_auth(db_path):
    asyncio.run(init_db())
    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        assert c.get("/api/redirects/").status_code == 401
        assert (
            c.post("/api/redirects/", json={"url": "http://x.example/y"}).status_code
            == 401
        )


def test_redirects_history_404(client):
    assert client.get("/api/redirects/9999/history").status_code == 404


def test_redirects_delete_404(client):
    assert client.delete("/api/redirects/9999").status_code == 404


def test_redirects_check_one_untracked_404(client):
    resp = client.post("/api/redirects/check", json={"url": "http://nope.example/x"})
    assert resp.status_code == 404


async def test_redirects_check_one_url(client, monkeypatch):
    from app.services import redirects as svc

    client.post("/api/redirects/", json={"url": "http://one.example/a"})
    client.post("/api/redirects/", json={"url": "http://two.example/b"})

    async def fake_check(session, url):
        return [], 200, url, None

    monkeypatch.setattr(svc, "check_url", fake_check)

    resp = client.post("/api/redirects/check", json={"url": "http://one.example/a"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["checked"] == 1
    assert data["updated"][0]["url"] == "http://one.example/a"


def test_redirects_graph_empty(client):
    resp = client.get("/api/redirects/graph")
    assert resp.status_code == 200
    assert resp.json() == {"nodes": [], "links": []}


def test_classify_status_redirect_without_location():
    from app.services.redirects import _classify_status

    # A 3xx that resolved to no hop must not be classified as OK.
    assert _classify_status([], 301, None) == "redirect"
    assert _classify_status([], 200, None) == "ok"
    assert _classify_status([], 404, None) == "error"
    assert _classify_status([("a", "b", 301)], 200, None) == "redirect"
    assert _classify_status([], 0, "timeout") == "error"
