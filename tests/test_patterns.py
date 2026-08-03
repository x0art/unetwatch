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
