"""Tests for the readout service: F1 ranked readout (sqlite + es + auto)."""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import readout as svc


@pytest.fixture(autouse=True)
def clear_env(monkeypatch):
    """Clear risk weight env vars for each test."""
    for key in list(os.environ.keys()):
        if key.startswith("RISK_WEIGHT_"):
            monkeypatch.delenv(key, raising=False)


import os


def test_get_risk_weights_from_env(monkeypatch):
    """Risk weights loaded from RISK_WEIGHT_* env vars."""
    monkeypatch.setenv("RISK_WEIGHT_MALWARE", "5.0")
    monkeypatch.setenv("RISK_WEIGHT_PHISHING", "3.0")
    monkeypatch.setenv("RISK_WEIGHT_C2", "10.0")
    # Invalid value falls back to 1.0
    monkeypatch.setenv("RISK_WEIGHT_BAD", "not-a-number")

    from app.config import get_settings

    get_settings.cache_clear()
    weights = svc._get_risk_weights()
    assert weights["malware"] == 5.0
    assert weights["phishing"] == 3.0
    assert weights["c2"] == 10.0
    assert weights["bad"] == 1.0
    get_settings.cache_clear()


def test_get_risk_weights_from_settings(monkeypatch):
    """Risk weights loaded from Settings fields (risk_weight_* in .env)."""
    monkeypatch.setenv("RISK_WEIGHT_MALWARE", "5.0")
    monkeypatch.setenv("RISK_WEIGHT_PHISHING", "3.0")

    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    # Simulate .env values by setting attributes
    settings.risk_weight_malware = 7.0
    settings.risk_weight_phishing = 4.0
    settings.risk_weight_exploit = 2.0

    weights = svc._get_risk_weights()
    assert weights["malware"] == 7.0
    assert weights["phishing"] == 4.0
    assert weights["exploit"] == 2.0
    get_settings.cache_clear()


async def test_sqlite_ranked_empty(client):
    """Empty findings returns empty list."""
    items = await svc._sqlite_ranked(1440, 50, None, {})
    assert items == []


async def test_sqlite_ranked_basic(client):
    """Basic sqlite ranking with matched_patterns."""
    from app.database import get_db

    # Insert test findings
    db = await get_db()
    try:
        now = datetime.now(UTC).isoformat()
        await db.executemany(
            """INSERT INTO findings
               (client_ip, server_ip, url, base_url, log_timestamp, matched_patterns)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                ("10.0.0.1", "10.9.9.9", "http://malware.example/a", "malware.example", now, json.dumps(["*malware*"])),
                ("10.0.0.1", "10.9.9.9", "http://malware.example/b", "malware.example", now, json.dumps(["*malware*"])),
                ("10.0.0.1", "10.9.9.9", "http://phishing.example/c", "phishing.example", now, json.dumps(["*phishing*"])),
                ("10.0.0.2", "10.9.9.9", "http://c2.example/d", "c2.example", now, json.dumps(["*c2*"])),
                ("10.0.0.3", "10.9.9.9", "http://clean.example/e", "clean.example", now, json.dumps([])),
            ],
        )
        await db.commit()
    finally:
        await db.close()

    weights = {"malware": 5.0, "phishing": 3.0, "c2": 10.0}
    items = await svc._sqlite_ranked(1440, 50, None, weights)

    assert len(items) == 3  # client with empty patterns excluded
    # 10.0.0.1: 2*malware(5) + 1*phishing(3) = 13
    # 10.0.0.2: 1*c2(10) = 10
    # 10.0.0.3: no patterns = excluded
    assert items[0]["client"] == "10.0.0.1"
    assert items[0]["risk_score"] == 13.0
    assert items[0]["total_hits"] == 3
    assert items[0]["policy_classes"] == {"*malware*": 2, "*phishing*": 1}
    assert items[1]["client"] == "10.0.0.2"
    assert items[1]["risk_score"] == 10.0


async def test_sqlite_ranked_search_filter(client):
    """Search parameter filters by URL/IP substring."""
    from app.database import get_db

    db = await get_db()
    try:
        now = datetime.now(UTC).isoformat()
        await db.executemany(
            """INSERT INTO findings
               (client_ip, server_ip, url, base_url, log_timestamp, matched_patterns)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                ("10.0.0.1", "10.9.9.9", "http://malware.example/a", "malware.example", now, json.dumps(["*malware*"])),
                ("10.0.0.2", "10.9.9.9", "http://other.example/b", "other.example", now, json.dumps(["*malware*"])),
            ],
        )
        await db.commit()
    finally:
        await db.close()

    weights = {"malware": 1.0}
    items = await svc._sqlite_ranked(1440, 50, "malware", weights)
    assert len(items) == 1
    assert items[0]["client"] == "10.0.0.1"


async def test_sqlite_ranked_minutes_filter(client):
    """Minutes parameter filters by time window."""
    from app.database import get_db

    db = await get_db()
    try:
        old = "2020-01-01T00:00:00+00:00"
        now = datetime.now(UTC).isoformat()
        await db.executemany(
            """INSERT INTO findings
               (client_ip, server_ip, url, base_url, log_timestamp, matched_patterns)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                ("10.0.0.1", "10.9.9.9", "http://malware.example/a", "malware.example", old, json.dumps(["*malware*"])),
                ("10.0.0.2", "10.9.9.9", "http://malware.example/b", "malware.example", now, json.dumps(["*malware*"])),
            ],
        )
        await db.commit()
    finally:
        await db.close()

    weights = {"malware": 1.0}
    items = await svc._sqlite_ranked(60, 50, None, weights)  # 60 min window
    assert len(items) == 1
    assert items[0]["client"] == "10.0.0.2"


async def test_es_ranked_empty(client, monkeypatch):
    """ES ranking returns empty when no hits."""
    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    settings.elastic_host = "http://localhost:9200"
    settings.elastic_index = "logs-*"
    settings.es_query_size = 5000

    class FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": []}}

        async def close(self):
            pass

        async def field_caps(self, index):
            return {"fields": {}}

        async def ping(self):
            return True

    fake_es = FakeES()

    def fake_build(*args, **kwargs):
        return fake_es

    # Patch build_es_client and es_client context manager everywhere they're used
    monkeypatch.setattr("app.services.es_client.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **kw: fake_es)
    monkeypatch.setattr("app.services.readout.build_es_client", fake_build)
    # Also patch es_fields which is used at startup
    monkeypatch.setattr("app.services.es_fields.es_client", lambda *a, **kw: fake_es)

    # Mock DB to return block patterns
    from app.database import get_db
    db = await get_db()
    try:
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*malware*', 'block')")
        await db.commit()
    finally:
        await db.close()

    items, es_online = await svc._es_ranked(60, 50, None, {"malware": 1.0})
    assert items == []
    assert es_online is True


async def test_es_ranked_with_hits(client, monkeypatch):
    """ES ranking processes live hits correctly."""
    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    settings.elastic_host = "http://localhost:9200"
    settings.elastic_index = "logs-*"
    settings.es_query_size = 5000

    now = datetime.now(UTC).isoformat()
    hits = [
        {
            "_source": {
                "@timestamp": now,
                "client_ip": "10.0.0.1",
                "server_ip": "10.9.9.9",
                "url": "http://malware.example/a",
                "base_url": "malware.example",
                "action": "ALLOW",
                "duration_seconds": 1.0,
            }
        },
        {
            "_source": {
                "@timestamp": now,
                "client_ip": "10.0.0.1",
                "server_ip": "10.9.9.9",
                "url": "http://malware.example/b",
                "base_url": "malware.example",
                "action": "ALLOW",
                "duration_seconds": 2.0,
            }
        },
        {
            "_source": {
                "@timestamp": now,
                "client_ip": "10.0.0.2",
                "server_ip": "10.9.9.9",
                "url": "http://phishing.example/c",
                "base_url": "phishing.example",
                "action": "ALLOW",
                "duration_seconds": 1.5,
            }
        },
    ]

    class FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": hits}}

        async def close(self):
            pass

        async def field_caps(self, index):
            return {"fields": {}}

        async def ping(self):
            return True

    fake_es = FakeES()

    def fake_build(*args, **kwargs):
        return fake_es

    # Patch build_es_client and es_client context manager everywhere they're used
    monkeypatch.setattr("app.services.es_client.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **kw: fake_es)
    monkeypatch.setattr("app.services.readout.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_fields.es_client", lambda *a, **kw: fake_es)

    # Mock DB to return block patterns and whitelist
    from app.database import get_db
    db = await get_db()
    try:
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*malware*', 'block')")
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*phishing*', 'block')")
        await db.commit()
    finally:
        await db.close()

    items, es_online = await svc._es_ranked(60, 50, None, {"malware": 2.0, "phishing": 1.0})
    assert es_online is True
    assert len(items) == 2
    # 10.0.0.1: 2*malware(2) = 4
    # 10.0.0.2: 1*phishing(1) = 1
    assert items[0]["client"] == "10.0.0.1"
    assert items[0]["risk_score"] == 4.0
    assert items[0]["total_hits"] == 2
    assert items[0]["policy_classes"] == {"*malware*": 2}
    assert items[1]["client"] == "10.0.0.2"
    assert items[1]["risk_score"] == 1.0


async def test_es_ranked_offline(client, monkeypatch):
    """ES ranking returns empty with es_online=False on connection error."""
    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    settings.elastic_host = "http://localhost:9200"
    settings.elastic_index = "logs-*"
    settings.es_query_size = 5000

    async def fake_es_client(*args, **kwargs):
        client = AsyncMock()
        client.search = AsyncMock(side_effect=ConnectionError("ES down"))
        client.close = AsyncMock()
        return client

    monkeypatch.setattr("app.services.readout._es_client_context", fake_es_client)

    # Mock DB
    from app.database import get_db
    db = await get_db()
    try:
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*malware*', 'block')")
        await db.commit()
    finally:
        await db.close()

    items, es_online = await svc._es_ranked(60, 50, None, {"malware": 1.0})
    assert items == []
    assert es_online is False


async def test_get_ranked_sqlite_source(client):
    """get_ranked with source=sqlite returns sqlite results."""
    from app.database import get_db

    db = await get_db()
    try:
        now = datetime.now(UTC).isoformat()
        await db.execute(
            """INSERT INTO findings
               (client_ip, server_ip, url, base_url, log_timestamp, matched_patterns)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("10.0.0.1", "10.9.9.9", "http://malware.example/a", "malware.example", now, json.dumps(["*malware*"])),
        )
        await db.commit()
    finally:
        await db.close()

    result = await svc.get_ranked(minutes=1440, limit=50, source="sqlite", search=None)
    assert result["source"] == "sqlite"
    assert result["es_online"] is True
    assert len(result["items"]) == 1
    assert result["items"][0]["client"] == "10.0.0.1"


async def test_get_ranked_es_source(client, monkeypatch):
    """get_ranked with source=es returns ES results."""
    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    settings.elastic_host = "http://localhost:9200"
    settings.elastic_index = "logs-*"
    settings.es_query_size = 5000

    now = datetime.now(UTC).isoformat()
    hits = [
        {
            "_source": {
                "@timestamp": now,
                "client_ip": "10.0.0.1",
                "server_ip": "10.9.9.9",
                "url": "http://malware.example/a",
                "base_url": "malware.example",
                "action": "ALLOW",
                "duration_seconds": 1.0,
            }
        },
    ]

    class FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": hits}}

        async def close(self):
            pass

        async def field_caps(self, index):
            return {"fields": {}}

        async def ping(self):
            return True

    fake_es = FakeES()

    def fake_build(*args, **kwargs):
        return fake_es

    # Patch build_es_client and es_client context manager everywhere they're used
    monkeypatch.setattr("app.services.es_client.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **kw: fake_es)
    monkeypatch.setattr("app.services.readout.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_fields.es_client", lambda *a, **kw: fake_es)

    from app.database import get_db
    db = await get_db()
    try:
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*malware*', 'block')")
        await db.commit()
    finally:
        await db.close()

    result = await svc.get_ranked(minutes=1440, limit=50, source="es", search=None)
    assert result["source"] == "es"
    assert result["es_online"] is True
    assert len(result["items"]) == 1


async def test_get_ranked_auto_fallback(client, monkeypatch):
    """get_ranked with source=auto falls back to ES when sqlite empty."""
    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    settings.elastic_host = "http://localhost:9200"
    settings.elastic_index = "logs-*"
    settings.es_query_size = 5000

    now = datetime.now(UTC).isoformat()
    hits = [
        {
            "_source": {
                "@timestamp": now,
                "client_ip": "10.0.0.1",
                "server_ip": "10.9.9.9",
                "url": "http://malware.example/a",
                "base_url": "malware.example",
                "action": "ALLOW",
                "duration_seconds": 1.0,
            }
        },
    ]

    class FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": hits}}

        async def close(self):
            pass

        async def field_caps(self, index):
            return {"fields": {}}

        async def ping(self):
            return True

    fake_es = FakeES()

    def fake_build(*args, **kwargs):
        return fake_es

    # Patch build_es_client and es_client context manager everywhere they're used
    monkeypatch.setattr("app.services.es_client.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **kw: fake_es)
    monkeypatch.setattr("app.services.readout.build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_fields.es_client", lambda *a, **kw: fake_es)

    from app.database import get_db
    db = await get_db()
    try:
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*malware*', 'block')")
        await db.commit()
    finally:
        await db.close()

    # No sqlite findings, should fall back to ES
    result = await svc.get_ranked(minutes=1440, limit=50, source="auto", search=None)
    assert result["source"] == "es"
    assert result["es_online"] is True
    assert len(result["items"]) == 1


async def test_get_ranked_auto_sqlite_has_data(client):
    """get_ranked with source=auto uses sqlite when it has data."""
    from app.database import get_db

    db = await get_db()
    try:
        now = datetime.now(UTC).isoformat()
        await db.execute(
            """INSERT INTO findings
               (client_ip, server_ip, url, base_url, log_timestamp, matched_patterns)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("10.0.0.1", "10.9.9.9", "http://malware.example/a", "malware.example", now, json.dumps(["*malware*"])),
        )
        await db.commit()
    finally:
        await db.close()

    result = await svc.get_ranked(minutes=1440, limit=50, source="auto", search=None)
    assert result["source"] == "sqlite"
    assert result["es_online"] is True
    assert len(result["items"]) == 1


async def test_get_ranked_es_failure_returns_200_shape(client, monkeypatch):
    """get_ranked with ES failure still returns 200-shaped response (no 5xx)."""
    from app.config import get_settings

    get_settings.cache_clear()
    settings = get_settings()
    settings.elastic_host = "http://localhost:9200"
    settings.elastic_index = "logs-*"
    settings.es_query_size = 5000

    async def fake_es_client(*args, **kwargs):
        client = AsyncMock()
        client.search = AsyncMock(side_effect=ConnectionError("ES down"))
        client.close = AsyncMock()
        return client

    monkeypatch.setattr("app.services.readout._es_client_context", fake_es_client)

    from app.database import get_db
    db = await get_db()
    try:
        await db.execute("INSERT INTO url_patterns (pattern, pattern_type) VALUES ('*malware*', 'block')")
        await db.commit()
    finally:
        await db.close()

    result = await svc.get_ranked(minutes=1440, limit=50, source="es", search=None)
    # Should not raise, returns empty with es_online=False
    assert result["source"] == "es"
    assert result["es_online"] is False
    assert result["items"] == []


async def test_item_shape(client):
    """Each ranked item has the correct shape with href."""
    from app.database import get_db

    db = await get_db()
    try:
        now = datetime.now(UTC).isoformat()
        await db.execute(
            """INSERT INTO findings
               (client_ip, server_ip, url, base_url, log_timestamp, matched_patterns)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("10.0.0.1", "10.9.9.9", "http://malware.example/a", "malware.example", now, json.dumps(["*malware*"])),
        )
        await db.commit()
    finally:
        await db.close()

    result = await svc.get_ranked(minutes=1440, limit=50, source="sqlite", search=None)
    item = result["items"][0]
    assert "client" in item
    assert "risk_score" in item
    assert "total_hits" in item
    assert "policy_classes" in item
    assert "top_urls" in item
    assert "last_seen" in item
    assert "href" in item
    assert item["href"] == "/api/readout/client/10.0.0.1"
    assert isinstance(item["policy_classes"], dict)
    assert isinstance(item["top_urls"], list)