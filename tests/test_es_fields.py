"""Unit tests for the es_fields field-sample gate."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.es_fields import _invalidate_cache, fetch_field_inventory, get_cached_inventory


class MockESClient:
    """Mock AsyncElasticsearch client for testing."""

    def __init__(self, sample_doc=None, field_caps=None, should_fail=False):
        self._sample_doc = sample_doc or {}
        self._field_caps = field_caps or {}
        self._should_fail = should_fail

    async def search(self, index, body):
        if self._should_fail:
            raise Exception("ES search failed")
        return {"hits": {"hits": [{"_source": self._sample_doc}] if self._sample_doc else []}}

    async def field_caps(self, index):
        if self._should_fail:
            raise Exception("ES field_caps failed")
        return {"fields": self._field_caps}

    async def close(self):
        pass


@pytest.fixture
def mock_settings():
    """Mock settings for tests."""
    with patch("app.config.get_settings") as mock:
        mock.return_value = MagicMock(elastic_index="logs-test")
        yield mock


@pytest.fixture(autouse=True)
def clear_cache():
    """Clear cache before and after each test."""
    _invalidate_cache()
    yield
    _invalidate_cache()


async def test_fetch_field_inventory_success(mock_settings):
    """Test successful fetch with sample doc and field caps."""
    sample = {
        "@timestamp": "2024-01-01T00:00:00Z",
        "url": "http://example.com",
        "client_ip": "1.2.3.4",
        "server_ip": "5.6.7.8",
        "duration_seconds": 10,
        "action": "block",
        "user_agent": "Mozilla/5.0",
        "username": "testuser",
        "session": "abc123",
    }
    caps = {k: {"type": "keyword"} for k in sample.keys()}

    mock_es = MockESClient(sample_doc=sample, field_caps=caps)

    result = await fetch_field_inventory(es=mock_es)

    assert result["es_online"] is True
    assert result["cached"] is False
    assert result["mode"] == "UC-A"
    assert result["sample"] == sample
    assert result["field_caps"] == caps


async def test_fetch_field_inventory_uc_b_mode(mock_settings):
    """Test UC-B mode (has username+session but no user_agent)."""
    sample = {
        "@timestamp": "2024-01-01T00:00:00Z",
        "url": "http://example.com",
        "client_ip": "1.2.3.4",
        "server_ip": "5.6.7.8",
        "duration_seconds": 10,
        "action": "block",
        "username": "testuser",
        "session": "abc123",
    }
    caps = {k: {"type": "keyword"} for k in sample.keys()}

    mock_es = MockESClient(sample_doc=sample, field_caps=caps)

    result = await fetch_field_inventory(es=mock_es)

    assert result["mode"] == "UC-B"


async def test_fetch_field_inventory_collapsed_mode(mock_settings):
    """Test COLLAPSED mode (only baseline fields)."""
    sample = {
        "@timestamp": "2024-01-01T00:00:00Z",
        "url": "http://example.com",
        "client_ip": "1.2.3.4",
        "server_ip": "5.6.7.8",
        "duration_seconds": 10,
        "action": "block",
    }
    caps = {k: {"type": "keyword"} for k in sample.keys()}

    mock_es = MockESClient(sample_doc=sample, field_caps=caps)

    result = await fetch_field_inventory(es=mock_es)

    assert result["mode"] == "COLLAPSED"


async def test_fetch_field_inventory_es_failure(mock_settings):
    """Test graceful degradation when ES is unreachable."""
    mock_es = MockESClient(should_fail=True)

    result = await fetch_field_inventory(es=mock_es)

    assert result["es_online"] is False
    assert result["mode"] == "UNKNOWN"
    assert result["sample"] == {}
    assert result["field_caps"] == {}


async def test_fetch_field_inventory_empty_index(mock_settings):
    """Test when index has no documents."""
    mock_es = MockESClient(sample_doc={}, field_caps={})

    result = await fetch_field_inventory(es=mock_es)

    assert result["es_online"] is True
    assert result["mode"] == "UNKNOWN"  # no baseline fields
    assert result["sample"] == {}


async def test_fetch_field_inventory_cached(mock_settings):
    """Test that second call returns cached result."""
    sample = {
        "@timestamp": "2024-01-01T00:00:00Z",
        "url": "http://example.com",
        "client_ip": "1.2.3.4",
        "server_ip": "5.6.7.8",
        "duration_seconds": 10,
        "action": "block",
        "user_agent": "Mozilla/5.0",
        "username": "testuser",
        "session": "abc123",
    }
    caps = {k: {"type": "keyword"} for k in sample.keys()}

    mock_es = MockESClient(sample_doc=sample, field_caps=caps)

    # First call
    result1 = await fetch_field_inventory(es=mock_es)
    assert result1["cached"] is False

    # Second call should use cache
    result2 = await fetch_field_inventory()
    assert result2["cached"] is True
    assert result2["mode"] == "UC-A"
    assert result2["sample"] == sample


async def test_get_cached_inventory_before_fetch():
    """Test get_cached_inventory returns None before first fetch."""
    result = get_cached_inventory()
    assert result is None


async def test_get_cached_inventory_after_fetch(mock_settings):
    """Test get_cached_inventory returns cached data after fetch."""
    sample = {"@timestamp": "2024-01-01T00:00:00Z", "url": "test"}
    mock_es = MockESClient(sample_doc=sample, field_caps={"@timestamp": {}, "url": {}})

    await fetch_field_inventory(es=mock_es)

    cached = get_cached_inventory()
    assert cached is not None
    assert cached["sample"] == sample


async def test_invalidate_cache_clears(mock_settings):
    """Test _invalidate_cache clears the cache."""
    sample = {"@timestamp": "2024-01-01T00:00:00Z", "url": "test"}
    mock_es = MockESClient(sample_doc=sample, field_caps={"@timestamp": {}, "url": {}})

    await fetch_field_inventory(es=mock_es)
    assert get_cached_inventory() is not None

    _invalidate_cache()
    assert get_cached_inventory() is None