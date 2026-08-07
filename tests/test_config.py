"""Production-mode config validation (fail-fast on weak/default credentials)."""

import pytest

from app.config import Settings, get_settings


def test_production_rejects_default_password(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ADMIN_PASS", "changeme")
    monkeypatch.setenv("API_KEY", "some-real-key")
    monkeypatch.setenv("ELASTIC_HOST", "https://es.internal:9200")
    with pytest.raises(ValueError, match="strong ADMIN_PASS"):
        Settings()


def test_production_rejects_missing_api_key(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ADMIN_PASS", "s3cure-passphrase")
    monkeypatch.delenv("API_KEY", raising=False)
    with pytest.raises(ValueError, match="non-empty API_KEY"):
        Settings()


def test_production_rejects_localhost_es(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ADMIN_PASS", "s3cure-passphrase")
    monkeypatch.setenv("API_KEY", "some-real-key")
    monkeypatch.setenv("ELASTIC_HOST", "http://localhost:9200")
    with pytest.raises(ValueError, match="explicit ELASTIC_HOST"):
        Settings()


def test_development_allows_defaults(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ADMIN_PASS", "changeme")
    monkeypatch.delenv("API_KEY", raising=False)
    # Defaults (including changeme) are fine in development.
    assert Settings().app_env == "development"


def test_get_settings_caches(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    get_settings.cache_clear()
    a = get_settings()
    b = get_settings()
    assert a is b
