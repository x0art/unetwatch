"""Tests for the delivery module (webhook + MS Teams delivery)."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class _FakeResp:
    """Mock response that supports `async with`."""
    def __init__(self, status: int):
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakePost:
    """Mock for session.post() — returns an async context manager."""
    def __init__(self, status: int):
        self.status = status

    async def __aenter__(self):
        return _FakeResp(self.status)

    async def __aexit__(self, *a):
        return False


# ── send_logs ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_send_logs_success():
    """send_logs POSTs the payload and returns 200."""
    from app.services.delivery import send_logs

    mock_session = MagicMock()
    mock_session.post = lambda *a, **kw: _FakePost(200)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.delivery.aiohttp.ClientSession", return_value=mock_session):
        status = await send_logs("https://hooks.example/x", 5, {"summary": {}})

    assert status == 200


@pytest.mark.asyncio
async def test_send_logs_failure():
    """send_logs returns the non-200 status on failure."""
    from app.services.delivery import send_logs

    mock_session = MagicMock()
    mock_session.post = lambda *a, **kw: _FakePost(502)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.delivery.aiohttp.ClientSession", return_value=mock_session):
        status = await send_logs("https://hooks.example/x", 3, {"data": 1})

    assert status == 502


# ── deliver_n8n ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deliver_n8n_calls_send_logs(monkeypatch):
    """deliver_n8n delegates to send_logs and records status in the log."""
    from app.services.delivery import deliver_n8n

    log = {"webhook_status": None, "webhook_error": None}
    fake_send = AsyncMock(return_value=200)
    monkeypatch.setattr("app.services.delivery.send_logs", fake_send)

    # Need a settings with webhook_url configured
    fake_settings = type("S", (), {"webhook_url": "https://hooks.example/x"})()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_n8n(log, {"summary": {"total_matches": 1}}, total_sum=1)

    assert log["webhook_status"] == 200
    assert log["webhook_error"] is None
    fake_send.assert_called_once_with(
        "https://hooks.example/x", 1, {"summary": {"total_matches": 1}}
    )


@pytest.mark.asyncio
async def test_deliver_n8n_no_url_skips(monkeypatch):
    """deliver_n8n skips delivery when no webhook URL is configured."""
    from app.services.delivery import deliver_n8n

    log = {"webhook_status": None, "webhook_error": None, "webhook_reason": None}
    fake_send = AsyncMock(return_value=200)
    monkeypatch.setattr("app.services.delivery.send_logs", fake_send)

    fake_settings = type("S", (), {"webhook_url": ""})()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_n8n(log, {}, total_sum=0)

    assert log["webhook_status"] is None
    assert "not configured" in log["webhook_reason"]
    fake_send.assert_not_called()


@pytest.mark.asyncio
async def test_deliver_n8n_send_error_records_failure(monkeypatch):
    """deliver_n8n catches send_logs exceptions and records them in the log."""
    from app.services.delivery import deliver_n8n

    log = {"webhook_status": None, "webhook_error": None}
    fake_send = AsyncMock(side_effect=ConnectionError("refused"))
    monkeypatch.setattr("app.services.delivery.send_logs", fake_send)

    fake_settings = type("S", (), {"webhook_url": "https://hooks.example/x"})()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_n8n(log, {"data": 1}, total_sum=1)

    assert log["webhook_status"] is None
    assert "refused" in log["webhook_error"]


# ── deliver_msteams ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deliver_msteams_builds_and_sends(monkeypatch):
    """deliver_msteams builds the card, wraps in envelope, sends, and records status."""
    from app.services.delivery import deliver_msteams

    log = {}
    result = [
        {"client_ip": "10.0.0.1", "base_url": ["evil.com"], "url": ["http://evil.com/x"]},
    ]
    matched_patterns = ["*evil*"]

    fake_card = {"type": "AdaptiveCard", "body": []}
    fake_build = lambda **kw: fake_card
    fake_send = AsyncMock(return_value=200)

    monkeypatch.setattr("app.services.msteams.build_adaptive_card", fake_build)
    monkeypatch.setattr("app.services.msteams.send_msteams_alert", fake_send)

    fake_settings = type("S", (), {
        "msteams_webhook_url": "https://teams.webhook.office.com/bot",
        "base_url": "https://unetwatch.example.com",
    })()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_msteams(log, result, matched_patterns, ["*evil*"])

    assert log["msteams_status"] == 200
    assert "msteams_error" not in log
    # Payload was stored for retry
    assert log["msteams_payload"] is not None
    payload = json.loads(log["msteams_payload"])
    assert payload["type"] == "message"
    assert payload["attachments"][0]["content"] == fake_card
    # Preview was recorded
    assert log["msteams_preview"]["client_ip"] == "10.0.0.1"
    assert "*evil*" in log["msteams_preview"]["pattern_match"]


@pytest.mark.asyncio
async def test_deliver_msteams_no_url_skips(monkeypatch):
    """deliver_msteams skips when msteams_webhook_url is not configured."""
    from app.services.delivery import deliver_msteams

    log = {}
    fake_send = AsyncMock(return_value=200)
    monkeypatch.setattr("app.services.msteams.send_msteams_alert", fake_send)

    fake_settings = type("S", (), {"msteams_webhook_url": ""})()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_msteams(log, [], [], [])

    assert "msteams_status" not in log
    fake_send.assert_not_called()


@pytest.mark.asyncio
async def test_deliver_msteams_send_error_records_failure(monkeypatch):
    """deliver_msteams catches send exceptions and records them."""
    from app.services.delivery import deliver_msteams

    log = {}
    result = [
        {"client_ip": "10.0.0.1", "base_url": ["bad.com"], "url": ["http://bad.com/x"]},
    ]

    fake_build = lambda **kw: {"body": []}
    fake_send = AsyncMock(side_effect=TimeoutError("timed out"))

    monkeypatch.setattr("app.services.msteams.build_adaptive_card", fake_build)
    monkeypatch.setattr("app.services.msteams.send_msteams_alert", fake_send)

    fake_settings = type("S", (), {
        "msteams_webhook_url": "https://teams.webhook.office.com/bot",
        "base_url": "",
    })()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_msteams(log, result, ["*bad*"], ["*bad*"])

    assert "msteams_status" not in log
    assert "timed out" in log["msteams_error"]


@pytest.mark.asyncio
async def test_deliver_msteams_deduplicates_domains(monkeypatch):
    """deliver_msteams deduplicates domains and URLs before building the card."""
    from app.services.delivery import deliver_msteams

    log = {}
    result = [
        {"client_ip": "10.0.0.1", "base_url": ["a.com", "b.com"], "url": ["http://a.com/x", "http://a.com/y"]},
        {"client_ip": "10.0.0.2", "base_url": ["a.com"], "url": ["http://a.com/x"]},
    ]

    captured = {}
    def fake_build(**kw):
        captured["domains"] = kw["target_domains"]
        captured["urls"] = kw["destination_urls"]
        return {"body": []}

    monkeypatch.setattr("app.services.msteams.build_adaptive_card", fake_build)
    fake_send = AsyncMock(return_value=200)
    monkeypatch.setattr("app.services.msteams.send_msteams_alert", fake_send)

    fake_settings = type("S", (), {
        "msteams_webhook_url": "https://teams.webhook.office.com/bot",
        "base_url": "",
    })()
    monkeypatch.setattr("app.services.delivery.get_settings", lambda: fake_settings)

    await deliver_msteams(log, result, ["*test*"], ["*test*"])

    # a.com appears twice in input but should be deduplicated
    assert captured["domains"] == ["a.com", "b.com"]
    # http://a.com/x appears twice but should be deduplicated
    assert captured["urls"] == ["http://a.com/x", "http://a.com/y"]
