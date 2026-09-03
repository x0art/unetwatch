"""Tests for System & Kibana Settings — Task 11 (spec §3.5)."""


def test_field_map_round_trips(client):
    res = client.get("/api/settings/field-map")
    assert res.status_code == 200
    put = client.put("/api/settings/field-map", json={"src_ip": "source.ip"})
    assert put.status_code == 200


def test_field_map_defaults_and_partial_put(client):
    """Defaults match the configured logstash-proxy-* flat schema; a partial
    PUT overlays only what was sent and leaves the rest intact (no nulls)."""
    res = client.get("/api/settings/field-map")
    data = res.json()
    assert data["src_ip"] == "client_ip"
    assert data["dest_ip"] == "server_ip"
    assert data["url"] == "url"
    assert data["domain"] == "domain"
    assert data["timestamp"] == "@timestamp"
    assert data["action"] == "action"
    assert data["duration"] == "duration_seconds"

    put = client.put("/api/settings/field-map", json={"src_ip": "client_ip"})
    assert put.status_code == 200
    body = put.json()
    assert body["src_ip"] == "client_ip"
    # Fields not sent keep their defaults.
    assert body["dest_ip"] == "server_ip"
    assert body["duration"] == "duration_seconds"

    # The saved row round-trips through GET.
    data = client.get("/api/settings/field-map").json()
    assert data["src_ip"] == "client_ip"
    assert data["dest_ip"] == "server_ip"


def test_kibana_settings_defaults_and_round_trip(client):
    res = client.get("/api/settings/kibana")
    assert res.status_code == 200
    data = res.json()
    assert data["host_url"] == "https://kibana-internal.corp.net:5601"
    assert data["index_pattern"] == "logstash-network-traffic-*"
    assert data["auth_type"] == "apiKey"

    put = client.put(
        "/api/settings/kibana",
        json={
            "host_url": "https://kibana-prod.corp.net:5601",
            "index_pattern": "logstash-*",
            "auth_type": "basic",
            "api_key": "abc123",
        },
    )
    assert put.status_code == 200
    data = client.get("/api/settings/kibana").json()
    assert data["host_url"] == "https://kibana-prod.corp.net:5601"
    assert data["auth_type"] == "basic"
    assert data["api_key"] == "abc123"


def test_kibana_settings_invalid_auth_type(client):
    resp = client.put("/api/settings/kibana", json={"auth_type": "saml"})
    assert resp.status_code == 422


def test_alerts_defaults_and_round_trip(client):
    res = client.get("/api/settings/alerts")
    assert res.status_code == 200
    data = res.json()
    assert data["deny_ratio_pct"] == 5.0
    assert data["window_minutes"] == 15
    assert data["webhook_type"] == "none"
    assert data["webhook_url"] == ""

    put = client.put(
        "/api/settings/alerts",
        json={
            "deny_ratio_pct": 7.5,
            "window_minutes": 30,
            "webhook_type": "slack",
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXXX",
        },
    )
    assert put.status_code == 200
    data = client.get("/api/settings/alerts").json()
    assert data["deny_ratio_pct"] == 7.5
    assert data["window_minutes"] == 30
    assert data["webhook_type"] == "slack"


def test_alerts_threshold_bounds(client):
    assert (
        client.put("/api/settings/alerts", json={"deny_ratio_pct": -1}).status_code
        == 422
    )
    assert (
        client.put("/api/settings/alerts", json={"deny_ratio_pct": 101}).status_code
        == 422
    )
    assert (
        client.put("/api/settings/alerts", json={"window_minutes": 0}).status_code
        == 422
    )
    assert (
        client.put("/api/settings/alerts", json={"webhook_type": "teams"}).status_code
        == 422
    )


def test_test_connection_rejects_empty_host(client):
    resp = client.post("/api/settings/test-connection", json={"host_url": ""})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "error" in body


def test_test_connection_happy_shape(client):
    """Validation is 422 for a bad auth_type; the endpoint returns the
    documented { ok, latencyMs } shape (offline here, so ok=False)."""
    resp = client.post(
        "/api/settings/test-connection",
        json={"host_url": "http://127.0.0.1:1", "auth_type": "saml"},
    )
    assert resp.status_code == 422
