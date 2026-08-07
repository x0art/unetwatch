"""Tests for the monitor audit trail: /api/logs + /api/query/run."""

import asyncio

from fastapi.testclient import TestClient

from app.database import init_db
from app.main import app


def test_logs_requires_auth(db_path):
    asyncio.run(init_db())
    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        assert c.get("/api/logs/").status_code == 401
        assert c.get("/api/query/run").status_code == 401


def test_logs_list_empty(client):
    resp = client.get("/api/logs/")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0}


async def test_write_log_and_list(client):
    from app.services.logs import write_log

    await write_log(
        {
            "kind": "poll",
            "minutes": 10,
            "matches": 7,
            "filtered": 5,
            "stored": 3,
            "es_query": {"size": 10, "query": {"match_all": {}}},
            "webhook_url": "https://hooks.example/x",
            "webhook_status": 200,
            "duration_ms": 1234,
        }
    )
    data = client.get("/api/logs/").json()
    assert data["total"] == 1
    row = data["items"][0]
    assert row["kind"] == "poll"
    assert row["matches"] == 7
    assert row["filtered"] == 5
    assert row["stored"] == 3
    assert row["webhook_status"] == 200
    assert "match_all" in row["es_query"]

    # Kind filter
    assert client.get("/api/logs/?kind=poll").json()["total"] == 1
    assert client.get("/api/logs/?kind=query").json()["total"] == 0

    # Sorting + pagination
    listed = client.get("/api/logs/?sort_by=matches&sort_order=asc").json()
    assert listed["total"] == 1


async def test_logs_bulk_delete_and_clear(client):
    from app.services.logs import write_log

    for i in range(3):
        await write_log({"kind": "query", "minutes": 60, "matches": i})

    assert client.get("/api/logs/").json()["total"] == 3
    ids = [row["id"] for row in client.get("/api/logs/").json()["items"]]

    res = client.post("/api/logs/bulk-delete", json={"ids": ids[:2]})
    assert res.status_code == 200
    assert res.json()["deleted"] == 2
    assert client.get("/api/logs/").json()["total"] == 1

    res = client.delete("/api/logs")
    assert res.status_code == 200
    assert res.json()["deleted"] == 1
    assert client.get("/api/logs/").json()["total"] == 0


def test_logs_delete_one_404(client):
    assert client.delete("/api/logs/9999").status_code == 404


async def test_prune_logs_by_max_rows(client):
    from app.services.logs import prune_logs, write_log

    for i in range(5):
        await write_log({"kind": "query", "minutes": 60, "matches": i})
    assert client.get("/api/logs/").json()["total"] == 5

    res = await prune_logs(max_rows=2)
    assert res["by_count"] == 3

    data = client.get("/api/logs/").json()
    assert data["total"] == 2
    # Newest two survive (inserted last).
    assert sorted(r["matches"] for r in data["items"]) == [3, 4]


async def test_prune_logs_by_retention(client):
    # Insert directly (bypassing write_log's auto-prune) so the old row
    # survives until we prune explicitly.
    from datetime import UTC, datetime

    from app.database import get_db
    from app.services.logs import prune_logs

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO monitor_logs (kind, started_at, matches)"
            " VALUES ('query', ?, 1)",
            ("2020-01-01T00:00:00+00:00",),
        )
        await db.execute(
            "INSERT INTO monitor_logs (kind, started_at, matches)"
            " VALUES ('query', ?, 2)",
            (datetime.now(UTC).isoformat(),),
        )
        await db.commit()
    finally:
        await db.close()

    res = await prune_logs(retention_days=1)
    assert res["by_age"] == 1

    data = client.get("/api/logs/").json()
    assert data["total"] == 1
    assert data["items"][0]["matches"] == 2


async def test_write_log_auto_prunes_old_rows(client):
    """The default prune runs after every write, so stale rows never linger."""

    from app.database import get_db
    from app.services.logs import write_log

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO monitor_logs (kind, started_at, matches)"
            " VALUES ('query', ?, 99)",
            ("2020-01-01T00:00:00+00:00",),
        )
        await db.commit()
    finally:
        await db.close()

    await write_log({"kind": "query", "minutes": 60, "matches": 1})

    data = client.get("/api/logs/").json()
    assert data["total"] == 1
    assert data["items"][0]["matches"] == 1


async def test_prune_logs_defaults_noop(client):
    """Default settings keep recent rows; nothing is pruned unexpectedly."""
    from app.services.logs import prune_logs, write_log

    for i in range(3):
        await write_log({"kind": "query", "minutes": 60, "matches": i})
    res = await prune_logs()
    assert res == {"by_age": 0, "by_count": 0}
    assert client.get("/api/logs/").json()["total"] == 3


async def test_query_run_records_log_and_degrades_gracefully(client, monkeypatch):
    """ES unreachable → 200 with es_online=False, and a query log is written."""
    from app.services import monitor as svc

    class FakeES:
        async def search(self, **kwargs):
            raise ConnectionError("boom")

        async def close(self):
            pass

    def fake_build(*args, **kwargs):
        return FakeES()

    monkeypatch.setattr(svc, "build_es_client", fake_build)

    resp = client.get("/api/query/run?minutes=60")
    assert resp.status_code == 200
    body = resp.json()
    assert body["es_online"] is False
    assert body["items"] == []
    assert body["flow"] == {"nodes": [], "links": []}

    logs = client.get("/api/logs/?kind=query").json()
    assert logs["total"] == 1
    assert logs["items"][0]["es_online"] == 0
    # A failed run records the error but must NOT be labelled as a skipped
    # delivery — nothing was skipped, the run itself failed.
    assert logs["items"][0]["error"] is not None
    assert logs["items"][0]["webhook_reason"] is None


async def test_query_run_annotates_lists(client, monkeypatch):
    """Query items carry blocked_by / whitelisted / blacklisted badges."""
    from app.services import monitor as svc

    assert (
        client.post(
            "/api/patterns/",
            json={"pattern": "*flagged.example*", "pattern_type": "block"},
        ).status_code
        in (200, 201)
    )
    assert (
        client.post(
            "/api/patterns/",
            json={"pattern": "*allowed.example*", "pattern_type": "whitelist"},
        ).status_code
        in (200, 201)
    )
    resp = client.post("/api/blacklist/", json={"value": "blocked.example"})
    assert resp.status_code in (200, 201)
    resp = client.post("/api/blacklist/", json={"value": "9.9.9.9"})
    assert resp.status_code in (200, 201)

    docs = [
        {
            "@timestamp": "2026-08-07T10:00:00Z",
            "client_ip": "10.0.0.1",
            "server_ip": "10.9.9.9",
            "url": "http://flagged.example/a",
            "action": "ALLOW",
        },
        {
            "@timestamp": "2026-08-07T10:00:01Z",
            "client_ip": "10.0.0.2",
            "server_ip": "10.9.9.9",
            "url": "http://allowed.example/b",
            "action": "ALLOW",
        },
        {
            "@timestamp": "2026-08-07T10:00:02Z",
            "client_ip": "10.0.0.3",
            "server_ip": "10.9.9.9",
            "url": "http://blocked.example/c",
            "action": "ALLOW",
        },
        {
            "@timestamp": "2026-08-07T10:00:03Z",
            "client_ip": "9.9.9.9",
            "server_ip": "10.9.9.9",
            "url": "http://flagged.example/d",
            "action": "ALLOW",
        },
    ]

    class FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": [{"_source": d} for d in docs]}}

        async def close(self):
            pass

    def fake_build(*args, **kwargs):
        return FakeES()

    monkeypatch.setattr(svc, "build_es_client", fake_build)

    resp = client.get("/api/query/run?minutes=60")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_requests"] == 4  # raw matches, whitelisted docs included

    by_url = {i["url"]: i for i in body["items"]}

    # Blocked by a block pattern.
    assert by_url["http://flagged.example/a"]["blocked_by"] == ["*flagged.example*"]
    assert by_url["http://flagged.example/a"]["whitelisted"] is False
    assert by_url["http://flagged.example/a"]["blacklisted"] is False

    # Whitelist pattern match is surfaced (not filtered out) and badged.
    assert by_url["http://allowed.example/b"]["whitelisted"] is True

    # Host on the URL blacklist.
    assert by_url["http://blocked.example/c"]["blacklisted"] is True
    assert by_url["http://blocked.example/c"]["blacklist_source"] == "url"

    # Client IP on the IP blacklist.
    assert by_url["http://flagged.example/d"]["blacklisted"] is True
    assert by_url["http://flagged.example/d"]["blacklist_source"] == "ip"


async def test_fetch_logs_records_query_and_webhook(client, monkeypatch):
    """A poll run records the ES query DSL, matches and webhook status."""
    from app.database import get_db
    from app.services import monitor as svc

    await get_db()  # ensure tables exist via init_db (already done by fixture)

    class FakeES:
        async def search(self, **kwargs):
            return {
                "hits": {
                    "hits": [
                        {
                            "_source": {
                                "@timestamp": "2026-08-07T10:00:00Z",
                                "client_ip": "10.1.2.3",
                                "server_ip": "10.9.9.9",
                                "url": "http://bad.example/x",
                                "base_url": "bad.example",
                                "duration_seconds": 1.5,
                                "action": "ALLOW",
                            }
                        }
                    ]
                }
            }

        async def close(self):
            pass

    def fake_build(*args, **kwargs):
        return FakeES()

    async def fake_send(webhook_url, n_item, payload):
        return 200

    monkeypatch.setattr(svc, "build_es_client", fake_build)
    monkeypatch.setattr(svc, "send_logs", fake_send)

    await svc.fetch_logs(minutes=5)

    logs = client.get("/api/logs/?kind=poll").json()
    assert logs["total"] == 1
    row = logs["items"][0]
    assert row["matches"] == 1
    assert row["filtered"] == 1
    assert row["stored"] == 1
    assert row["webhook_status"] == 200
    assert row["es_query"] is not None
    assert "now-5m" in row["es_query"]

    # The finding was persisted as well.
    findings = client.get("/api/findings/?limit=50").json()
    assert findings["total"] == 1
    assert findings["items"][0]["url"] == "http://bad.example/x"
