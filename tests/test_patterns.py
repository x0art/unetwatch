"""Tests for URL pattern CRUD endpoints."""


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("ok", "degraded")
    assert body["version"] == "1.0.0"
    assert "database" in body["dependencies"]


def test_create_pattern(client):
    resp = client.post(
        "/api/patterns/",
        json={"pattern": "*test1*", "pattern_type": "block"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["pattern"] == "*test1*"
    assert data["pattern_type"] == "block"
    assert "id" in data


def test_create_duplicate_pattern(client):
    client.post("/api/patterns/", json={"pattern": "*dup*", "pattern_type": "block"})
    resp = client.post("/api/patterns/", json={"pattern": "*dup*", "pattern_type": "block"})
    assert resp.status_code == 409


def test_list_patterns(client):
    client.post("/api/patterns/", json={"pattern": "*a*", "pattern_type": "block"})
    client.post("/api/patterns/", json={"pattern": "whitelist1", "pattern_type": "whitelist"})
    resp = client.get("/api/patterns/")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) >= 2


def test_list_patterns_filtered(client):
    client.post("/api/patterns/", json={"pattern": "*block1*", "pattern_type": "block"})
    client.post("/api/patterns/", json={"pattern": "allow1", "pattern_type": "whitelist"})
    resp = client.get("/api/patterns/?pattern_type=block")
    assert resp.status_code == 200
    data = resp.json()
    for p in data:
        assert p["pattern_type"] == "block"


def test_list_patterns_search(client):
    client.post("/api/patterns/", json={"pattern": "*unique_search*", "pattern_type": "block"})
    resp = client.get("/api/patterns/?search=unique_search")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
    assert any("unique_search" in p["pattern"] for p in data)


def test_get_pattern(client):
    created = client.post("/api/patterns/", json={"pattern": "*getme*", "pattern_type": "block"})
    pid = created.json()["id"]
    resp = client.get(f"/api/patterns/{pid}")
    assert resp.status_code == 200
    assert resp.json()["pattern"] == "*getme*"


def test_get_pattern_not_found(client):
    resp = client.get("/api/patterns/99999")
    assert resp.status_code == 404


def test_update_pattern(client):
    created = client.post("/api/patterns/", json={"pattern": "*old*", "pattern_type": "block"})
    pid = created.json()["id"]
    resp = client.put(f"/api/patterns/{pid}", json={"pattern": "*new*"})
    assert resp.status_code == 200
    assert resp.json()["pattern"] == "*new*"


def test_update_pattern_not_found(client):
    resp = client.put("/api/patterns/99999", json={"pattern": "x"})
    assert resp.status_code == 404


def test_delete_pattern(client):
    created = client.post("/api/patterns/", json={"pattern": "*delme*", "pattern_type": "block"})
    pid = created.json()["id"]
    resp = client.delete(f"/api/patterns/{pid}")
    assert resp.status_code == 204
    # verify gone
    resp2 = client.get(f"/api/patterns/{pid}")
    assert resp2.status_code == 404


def test_delete_pattern_not_found(client):
    resp = client.delete("/api/patterns/99999")
    assert resp.status_code == 404


def test_bulk_import(client):
    resp = client.post(
        "/api/patterns/bulk",
        json={"patterns": ["*bulk1*", "*bulk2*"], "pattern_type": "block"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert len(data) == 2


def test_pattern_counts(client):
    client.post("/api/patterns/", json={"pattern": "*count1*", "pattern_type": "block"})
    client.post("/api/patterns/", json={"pattern": "count2", "pattern_type": "whitelist"})
    resp = client.get("/api/patterns/stats/counts")
    assert resp.status_code == 200
    data = resp.json()
    assert "block" in data
    assert "whitelist" in data


def test_monitor_status(client):
    resp = client.get("/api/monitor/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "active"
    assert "block_patterns" in data
    assert "whitelist_patterns" in data
    assert "es_online" in data
    assert "findings_count" in data


def test_monitor_status_poll_interval_from_settings(client):
    resp = client.get("/api/monitor/status")
    data = resp.json()
    assert data["poll_interval_minutes"] == 10


def test_manual_run_minutes_validation(client):
    resp = client.post("/api/monitor/run?minutes=0")
    assert resp.status_code == 422
    resp = client.post("/api/monitor/run?minutes=11")
    assert resp.status_code == 422


def test_monitor_metrics_shape(client):
    resp = client.get("/api/monitor/metrics?minutes=60")
    assert resp.status_code == 200
    data = resp.json()
    assert data["window_minutes"] == 60
    assert "es_online" in data
    assert "total_requests" in data
    assert "unique_ips" in data
    assert "top_urls" in data
    assert "top_ips" in data


def test_list_patterns_sort(client):
    client.post("/api/patterns/", json={"pattern": "*zzz*", "pattern_type": "block"})
    client.post("/api/patterns/", json={"pattern": "*aaa*", "pattern_type": "block"})
    resp = client.get("/api/patterns/?sort_by=pattern&sort_order=asc")
    assert resp.status_code == 200
    names = [p["pattern"] for p in resp.json()]
    assert names == sorted(names)
    resp = client.get("/api/patterns/?sort_by=pattern&sort_order=desc")
    names = [p["pattern"] for p in resp.json()]
    assert names == sorted(names, reverse=True)


def test_list_patterns_invalid_sort(client):
    resp = client.get("/api/patterns/?sort_by=evil")
    assert resp.status_code == 422
    resp = client.get("/api/patterns/?sort_order=sideways")
    assert resp.status_code == 422


def test_findings_list_empty(client):
    """Before the app starts, findings table is empty (lifespan runs after client setup).

    This test asserts the schema-level behavior: GET /api/findings/ works and
    returns the documented shape. The seeded startup population is exercised
    in `test_findings_seeded_on_startup` below."""
    resp = client.get("/api/findings/")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) == {"items", "total"}
    assert isinstance(data["items"], list)
    assert isinstance(data["total"], int)


async def test_findings_list_and_search(client):
    from app.database import get_db

    db = await get_db()
    try:
        # Isolate this test from any findings the startup seed inserted.
        await db.execute("DELETE FROM findings")
        await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                "1.2.3.4",
                "10.0.0.1",
                "http://evil.example/x",
                "evil.example",
                "2026-08-05T00:00:00Z",
            ),
        )
        await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                "5.6.7.8",
                "10.0.0.2",
                "http://other.example/y",
                "other.example",
                "2026-08-05T01:00:00Z",
            ),
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/findings/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    # Newest first (id DESC)
    assert data["items"][0]["client_ip"] == "5.6.7.8"
    assert data["items"][0]["server_ip"] == "10.0.0.2"

    resp = client.get("/api/findings/?search=evil")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["client_ip"] == "1.2.3.4"
    assert resp.json()["items"][0]["server_ip"] == "10.0.0.1"

    # server_ip is searchable too.
    resp = client.get("/api/findings/?search=10.0.0.2")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["server_ip"] == "10.0.0.2"
    assert resp.json()["items"][0]["client_ip"] == "5.6.7.8"

    resp = client.get("/api/findings/?search=nomatch")
    assert resp.json()["total"] == 0

    resp = client.get("/api/findings/?limit=1&offset=1")
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 1


async def _insert_findings(db, rows):
    """Insert findings rows directly, returning their ids."""
    ids = []
    for r in rows:
        cursor = await db.execute(
            "INSERT OR IGNORE INTO findings"
            " (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            (r["client_ip"], r["server_ip"], r["url"], r["base_url"], r["ts"]),
        )
        ids.append(cursor.lastrowid)
    await db.commit()
    return ids


async def test_findings_delete(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        ids = await _insert_findings(
            db,
            [
                {
                    "client_ip": "9.9.9.9",
                    "server_ip": "10.0.0.9",
                    "url": "http://delete-me.example/x",
                    "base_url": "delete-me.example",
                    "ts": "2026-08-05T02:00:00Z",
                }
            ],
        )
    finally:
        await db.close()

    fid = ids[0]
    resp = client.delete(f"/api/findings/{fid}")
    assert resp.status_code == 204

    resp = client.get("/api/findings/")
    assert resp.json()["total"] == 0

    # Deleting again yields 404
    resp = client.delete(f"/api/findings/{fid}")
    assert resp.status_code == 404


def test_findings_delete_not_found(client):
    resp = client.delete("/api/findings/99999")
    assert resp.status_code == 404


async def test_findings_clear_all(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        await _insert_findings(
            db,
            [
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://a.example/x",
                    "base_url": "a.example",
                    "ts": "2026-08-05T03:00:00Z",
                },
                {
                    "client_ip": "2.2.2.2",
                    "server_ip": "10.0.0.2",
                    "url": "http://b.example/y",
                    "base_url": "b.example",
                    "ts": "2026-08-05T03:01:00Z",
                },
            ],
        )
    finally:
        await db.close()

    assert client.get("/api/findings/").json()["total"] == 2
    resp = client.delete("/api/findings/")
    assert resp.status_code == 204
    assert client.get("/api/findings/").json()["total"] == 0


async def test_findings_bulk_delete(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        ids = await _insert_findings(
            db,
            [
                {
                    "client_ip": "3.3.3.3",
                    "server_ip": "10.0.0.3",
                    "url": "http://c.example/x",
                    "base_url": "c.example",
                    "ts": "2026-08-05T05:00:00Z",
                },
                {
                    "client_ip": "4.4.4.4",
                    "server_ip": "10.0.0.4",
                    "url": "http://d.example/y",
                    "base_url": "d.example",
                    "ts": "2026-08-05T05:01:00Z",
                },
                {
                    "client_ip": "5.5.5.5",
                    "server_ip": "10.0.0.5",
                    "url": "http://e.example/z",
                    "base_url": "e.example",
                    "ts": "2026-08-05T05:02:00Z",
                },
            ],
        )
    finally:
        await db.close()

    assert client.get("/api/findings/").json()["total"] == 3

    # Delete a subset; count reflects only rows actually removed.
    resp = client.post("/api/findings/bulk-delete", json={"ids": [ids[0], ids[1], 99999]})
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 2}
    assert client.get("/api/findings/").json()["total"] == 1

    # Empty id list is rejected.
    resp = client.post("/api/findings/bulk-delete", json={"ids": []})
    assert resp.status_code == 422

    # Missing body is rejected.
    resp = client.post("/api/findings/bulk-delete", json={})
    assert resp.status_code == 422


def test_findings_graph_empty(client):
    resp = client.get("/api/findings/graph")
    assert resp.status_code == 200
    assert resp.json() == {"nodes": [], "links": [], "flows": []}


def test_findings_graph_invalid_limit(client):
    resp = client.get("/api/findings/graph?limit=0")
    assert resp.status_code == 422
    resp = client.get("/api/findings/graph?limit=9999")
    assert resp.status_code == 422


async def test_findings_graph_shape(client):
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        await _insert_findings(
            db,
            [
                {
                    "client_ip": "1.2.3.4",
                    "server_ip": "10.0.0.1",
                    "url": "http://evil.example/a",
                    "base_url": "evil.example",
                    "ts": "2026-08-05T04:00:00Z",
                },
                {
                    "client_ip": "1.2.3.4",
                    "server_ip": "10.0.0.1",
                    "url": "http://evil.example/b",
                    "base_url": "evil.example",
                    "ts": "2026-08-05T04:01:00Z",
                },
                {
                    "client_ip": "5.6.7.8",
                    "server_ip": "10.0.0.2",
                    "url": "http://bad.example/c",
                    "base_url": "bad.example",
                    "ts": "2026-08-05T04:02:00Z",
                },
                {
                    "client_ip": "9.9.9.9",
                    "server_ip": "",
                    "url": "http://nohost.example/d",
                    "base_url": "nohost.example",
                    "ts": "2026-08-05T04:03:00Z",
                },
            ],
        )
    finally:
        await db.close()

    data = client.get("/api/findings/graph").json()
    assert set(data.keys()) == {"nodes", "links", "flows"}

    kinds = {n["kind"] for n in data["nodes"]}
    assert kinds == {"ip", "server", "url"}

    # Per-triple flows mirror the same top-N cut as the graph. Each flow also
    # carries `last_seen`, so match on the subset of keys the UI relies on.
    def flow_subset(fields):
        return any(all(k in f and f[k] == v for k, v in fields.items()) for f in data["flows"])

    assert flow_subset(
        {
            "client_ip": "1.2.3.4",
            "server_ip": "10.0.0.1",
            "url": "http://evil.example/a",
            "base_url": "evil.example",
            "count": 1,
        }
    )
    assert flow_subset(
        {
            "client_ip": "9.9.9.9",
            "server_ip": "",
            "url": "http://nohost.example/d",
            "base_url": "nohost.example",
            "count": 1,
        }
    )

    # Client IP node carries its total access count (2 accesses).
    ip_node = next(n for n in data["nodes"] if n["kind"] == "ip" and n["label"] == "1.2.3.4")
    assert ip_node["count"] == 2
    assert ip_node["id"] == "ip:1.2.3.4"

    # Layered flow links: ip -> server -> url, aggregated with counts.
    assert {
        "source": "ip:1.2.3.4", "target": "server:10.0.0.1", "count": 2
    } in data["links"]
    assert {
        "source": "server:10.0.0.1", "target": "url:http://evil.example/a", "count": 1
    } in data["links"]
    assert {
        "source": "server:10.0.0.1", "target": "url:http://evil.example/b", "count": 1
    } in data["links"]

    # Rows without a server_ip link straight to the URL.
    assert {
        "source": "ip:9.9.9.9", "target": "url:http://nohost.example/d", "count": 1
    } in data["links"]


async def test_findings_graph_limit_no_dangling_servers(client):
    """Nodes that miss the per-layer cut must not appear disconnected."""
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        # top.example/a is hit twice, so with limit=1 it is the only URL
        # that survives the cut; dropped.example/b falls off.
        await _insert_findings(
            db,
            [
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://top.example/a",
                    "base_url": "top.example",
                    "ts": "2026-08-05T05:00:00Z",
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://top.example/a",
                    "base_url": "top.example",
                    "ts": "2026-08-05T05:00:30Z",
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.2",
                    "url": "http://dropped.example/b",
                    "base_url": "dropped.example",
                    "ts": "2026-08-05T05:01:00Z",
                },
            ],
        )
    finally:
        await db.close()

    # limit=1 keeps only the top URL (http://top.example/a), so the server
    # behind the dropped URL must not show up as an isolated node.
    data = client.get("/api/findings/graph?limit=1").json()
    server_labels = [n["label"] for n in data["nodes"] if n["kind"] == "server"]
    assert server_labels == ["10.0.0.1"]

    url_labels = [n["label"] for n in data["nodes"] if n["kind"] == "url"]
    assert "http://dropped.example/b" not in url_labels
    # Every server node has at least one link.
    node_ids = {n["id"] for n in data["nodes"]}
    linked_ids = {lnk["source"] for lnk in data["links"]} | {
        lnk["target"] for lnk in data["links"]
    }
    assert linked_ids <= node_ids
    assert {n["id"] for n in data["nodes"] if n["kind"] == "server"} <= linked_ids


async def test_findings_graph_excludes_whitelisted_urls(client):
    """Whitelisted destinations must not appear in the Traffic Graph."""
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        await _insert_findings(
            db,
            [
                {
                    "client_ip": "1.2.3.4",
                    "server_ip": "10.0.0.1",
                    "url": "http://keep.example/a",
                    "base_url": "keep.example",
                    "ts": "2026-08-05T04:00:00Z",
                },
                {
                    "client_ip": "1.2.3.4",
                    "server_ip": "10.0.0.1",
                    "url": "http://safe.example/x",
                    "base_url": "safe.example",
                    "ts": "2026-08-05T04:01:00Z",
                },
            ],
        )
        # Whitelist safe.example so it must be dropped from the graph.
        resp = client.post(
            "/api/patterns/",
            json={"pattern": "safe.example", "pattern_type": "whitelist"},
        )
        assert resp.status_code == 201
    finally:
        await db.close()

    data = client.get("/api/findings/graph").json()
    url_labels = [n["label"] for n in data["nodes"] if n["kind"] == "url"]
    assert "http://keep.example/a" in url_labels
    assert "http://safe.example/x" not in url_labels


async def test_findings_graph_whitelist_supports_globs(client):
    """Wildcard whitelist patterns (`*safe*`) filter the graph like the monitor."""
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        await _insert_findings(
            db,
            [
                {
                    "client_ip": "1.2.3.4",
                    "server_ip": "10.0.0.1",
                    "url": "http://keep.example/a",
                    "base_url": "keep.example",
                    "ts": "2026-08-05T04:00:00Z",
                },
                {
                    "client_ip": "1.2.3.4",
                    "server_ip": "10.0.0.1",
                    "url": "http://notsafe-cdn.example/x",
                    "base_url": "notsafe-cdn.example",
                    "ts": "2026-08-05T04:01:00Z",
                },
            ],
        )
        resp = client.post(
            "/api/patterns/",
            json={"pattern": "*safe*", "pattern_type": "whitelist"},
        )
        assert resp.status_code == 201
    finally:
        await db.close()

    data = client.get("/api/findings/graph").json()
    url_labels = [n["label"] for n in data["nodes"] if n["kind"] == "url"]
    assert "http://keep.example/a" in url_labels
    # Glob *safe* matches the literal substring pattern anywhere in the URL.
    assert "http://notsafe-cdn.example/x" not in url_labels


async def test_store_findings_uses_es_timestamp(client):
    """ES @timestamp is authoritative; blank/NaT/epoch values are normalized."""
    from datetime import UTC, datetime

    import pandas as pd

    from app.database import get_db
    from app.services.monitor import store_findings

    epoch_ms = 1785906000000  # 2026-08-05T05:00:00Z
    epoch_s = 1785906000

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        df = pd.DataFrame(
            [
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/a",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": "2026-08-05T11:22:33.000Z",
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/b",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": "",
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/c",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": float("nan"),
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/d",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": epoch_ms,
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/e",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": pd.Timestamp("2026-08-05T12:00:00Z"),
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/f",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": pd.NaT,
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/g",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": epoch_s,  # epoch seconds
                },
                {
                    "client_ip": "1.1.1.1",
                    "server_ip": "10.0.0.1",
                    "url": "http://ts.example/h",
                    "base_url": "ts.example",
                    "action": "ALLOW",
                    "@timestamp": float("inf"),  # unusable, must not crash
                },
            ]
        )
        await store_findings(db, df)

        cursor = await db.execute("SELECT url, log_timestamp FROM findings ORDER BY id")
        rows = {r["url"]: r["log_timestamp"] for r in await cursor.fetchall()}
    finally:
        await db.close()

    # Real ES timestamps are stored verbatim.
    assert rows["http://ts.example/a"] == "2026-08-05T11:22:33.000Z"
    # Empty / NaN / NaT / inf timestamps fall back to the poll time — never
    # blank, "NaT" or a crash.
    for url in ("http://ts.example/b", "http://ts.example/c", "http://ts.example/f", "http://ts.example/h"):
        value = rows[url]
        assert value not in ("", "NaT")
        datetime.fromisoformat(value)  # must be a parseable ISO timestamp
    # Epoch millis and seconds are converted to ISO-8601 UTC.
    assert rows["http://ts.example/d"] == datetime.fromtimestamp(epoch_ms / 1000, UTC).isoformat()
    assert rows["http://ts.example/g"] == datetime.fromtimestamp(epoch_s, UTC).isoformat()
    # pandas Timestamp values are normalized to ISO.
    assert rows["http://ts.example/e"] == "2026-08-05T12:00:00+00:00"
    assert "NaT" not in rows.values()
    assert "" not in rows.values()


def test_validation_invalid_type(client):
    resp = client.post("/api/patterns/", json={"pattern": "test", "pattern_type": "invalid"})
    assert resp.status_code == 422


def test_validation_empty_pattern(client):
    resp = client.post("/api/patterns/", json={"pattern": "", "pattern_type": "block"})
    assert resp.status_code == 422


def test_validation_missing_pattern(client):
    resp = client.post("/api/patterns/", json={"pattern_type": "block"})
    assert resp.status_code == 422


def test_validation_whitelist_create(client):
    resp = client.post(
        "/api/patterns/", json={"pattern": "safe.com", "pattern_type": "whitelist"},
    )
    assert resp.status_code == 201
    assert resp.json()["pattern_type"] == "whitelist"


def test_validation_put_invalid_type(client):
    created = client.post("/api/patterns/", json={"pattern": "*valid*", "pattern_type": "block"})
    pid = created.json()["id"]
    resp = client.put(f"/api/patterns/{pid}", json={"pattern_type": "invalid"})
    assert resp.status_code == 422


async def test_store_findings_persists_rich_flat_columns(client):
    """The flat logstash-proxy fields must survive a poll into the findings table."""
    import pandas as pd

    from app.database import get_db
    from app.services.result_processor import store_findings

    df = pd.DataFrame(
        [
            {
                "@timestamp": "2026-09-03T09:36:12.000Z",
                "client_ip": "172.21.26.84",
                "server_ip": "142.251.154.119",
                "url": "https://www.google.com/gen_204",
                "base_url": "www.google.com",
                "domain": "www.google.com",
                "category": "Search Site",
                "http_method": "GET",
                "http_status_code": "204",
                "country_code": "US",
                "bytes_downloaded": 916,
                "bytes_uploaded": 4116,
                "rule_info": "DS",
                "rule_name": "-",
                "user_id": "172.21.26.84",
                "action": "ALLOW",
                "duration_seconds": 12.64,
            }
        ]
    )

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        inserted = await store_findings(db, df, matched_patterns=[])
        assert inserted == 1
        cur = await db.execute(
            "SELECT domain, category, http_method, http_status_code, country_code, "
            "bytes_downloaded, bytes_uploaded, rule_info, rule_name, user_id, "
            "action, duration_seconds FROM findings"
        )
        row = await cur.fetchone()
    finally:
        await db.close()

    assert row is not None
    assert row[0] == "www.google.com"   # domain
    assert row[1] == "Search Site"      # category
    assert row[2] == "GET"              # http_method
    assert row[3] == "204"              # http_status_code
    assert row[4] == "US"               # country_code
    # bytes_* persist as TEXT (migration columns); the frontend coerces for
    # bandwidth sums. duration_seconds is an INTEGER column.
    assert row[5] == "916"              # bytes_downloaded
    assert row[6] == "4116"             # bytes_uploaded
    assert row[7] == "DS"               # rule_info
    assert row[8] == "-"                # rule_name
    assert row[9] == "172.21.26.84"     # user_id
    assert row[10] == "ALLOW"           # action
    assert row[11] == 12                # duration_seconds (int)
