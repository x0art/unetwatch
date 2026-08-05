"""Tests for URL pattern CRUD endpoints."""


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


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


async def test_findings_seeded_on_startup(client):
    from app.services.seed import seed_findings

    await seed_findings()
    resp = client.get("/api/findings/")
    data = resp.json()
    assert data["total"] == 5
    assert data["items"][0]["client_ip"] == "198.51.100.9"
    assert data["items"][0]["server_ip"] == "10.0.0.8"


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

    resp = client.get("/api/findings/?search=nomatch")
    assert resp.json()["total"] == 0

    resp = client.get("/api/findings/?limit=1&offset=1")
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 1


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
