"""Tests for pre-delivery alert suppression in the monitor poll.

A poll persists EVERY filtered match (findings are evidence and are never
dropped), but only the ALERTABLE subset may reach the two delivery paths. A row
is suppressed, before delivery, when either:

* ``action == "DENY"`` — the proxy already enforced the policy (ADR 0001: the
  request is "handled"), so alerting on it re-counts a request the operator
  knows was stopped; or
* ``base_url`` is already in ``blacklist_entries`` — the destination is already
  blocked, so an alert naming it is noise, not signal.

Harness modelled on ``tests/test_logs.py::test_fetch_logs_records_query_and_webhook``:
a FakeES with an async ``search``, the same set of monkeypatch targets
(``build_es_client`` on the monitor service, the ``es_client`` context manager
in ``app.services.es_client``, and ``send_logs`` in ``app.services.delivery``),
the ``client`` fixture from ``tests/conftest.py`` (admin:admin Basic auth + a
temp DB), and a recorded-call list on the fake ``send_logs`` so delivery is an
observable. No test makes a network call: the n8n ``send_logs`` and the MS Teams
``deliver_msteams``/``send_msteams_alert`` are both patched.
"""

import pytest

# The suppression reason is asserted only by the stable prefix/substring the
# backend itself owns (``monitor.fetch_logs``); the exact counts are read back
# off the row, never restated as literals in the assertion.
SUPPRESSION_MARKER = "suppressed"


def _hit(action, url, base_url, client_ip="10.1.2.3", ts="2026-08-07T10:00:00Z"):
    """One ES hit in the shape ``fetch_logs`` reads (``_source`` fields only)."""
    return {
        "_source": {
            "@timestamp": ts,
            "client_ip": client_ip,
            "server_ip": "10.9.9.9",
            "url": url,
            "base_url": base_url,
            "duration_seconds": 1.5,
            "action": action,
        }
    }


class FakeES:
    """Elasticsearch stand-in returning a fixed, pre-seeded hit list."""

    def __init__(self, hits):
        self._hits = hits

    async def search(self, **kwargs):
        return {"hits": {"hits": list(self._hits)}}

    async def close(self):
        pass

    async def field_caps(self, index):
        return {"fields": {}}

    async def ping(self):
        return True


@pytest.fixture
def monkeypatch_poll(monkeypatch):
    """Wire the poll path to a FakeES + recorded delivery calls.

    Returns a small controller so each test can set the hits, then read back
    ``n8n_calls`` (the ``(url, n_item, payload)`` tuples ``send_logs`` received)
    and ``msteams_calls`` (deliver_msteams invocations). Everything is patched
    in-process — no HTTP is issued.
    """
    from app.config import get_settings
    from app.services import monitor as svc

    state = {"hits": [], "n8n_calls": [], "msteams_calls": []}

    fake_es = FakeES(state["hits"])

    def fake_build(*args, **kwargs):
        return fake_es

    async def fake_send(webhook_url, n_item, payload):
        state["n8n_calls"].append((webhook_url, n_item, payload))
        return 200

    async def fake_msteams(log, result, matched_patterns, block_patterns, **kwargs):
        state["msteams_calls"].append(result)

    monkeypatch.setattr(svc, "build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **kw: fake_es)
    monkeypatch.setattr("app.services.es_client.build_es_client", fake_build)
    monkeypatch.setattr("app.services.delivery.send_logs", fake_send)
    # MS Teams is patched at its delivery seam so nothing is sent and the
    # "was delivery attempted?" question stays observable without a network
    # call. It is patched on the MONITOR namespace — the name ``fetch_logs``
    # resolves at call time — and accepts the poll's extra suppression kwargs.
    monkeypatch.setattr(svc, "deliver_msteams", fake_msteams)
    monkeypatch.setattr(get_settings(), "webhook_url", "https://hooks.example/test")
    # MS Teams must be *enabled* for deliver_msteams's early return not to mask
    # a skipped call: we want to observe the invocation decision itself.
    monkeypatch.setattr(get_settings(), "msteams_webhook_url", "https://teams.example/test")

    class Controller:
        def set_hits(self, hits):
            state["hits"] = hits
            fake_es._hits = hits

        @property
        def n8n_calls(self):
            return state["n8n_calls"]

        @property
        def msteams_calls(self):
            return state["msteams_calls"]

    return Controller()


def _poll_row(client):
    """The single poll log row most recently written."""
    body = client.get("/api/logs/?kind=poll").json()
    assert body["total"] >= 1
    return body["items"][0]


def _blacklist_host(client, host):
    """Add ``host`` to the blacklist through the real API route."""
    resp = client.post("/api/blacklist/", json={"value": host})
    assert resp.status_code == 201, resp.text
    return resp.json()


# ── (a) DENY-only window: enforced rows never alert, but ARE persisted ───────


async def test_deny_only_window_is_suppressed_but_persisted(client, monkeypatch_poll):
    """A window whose only row is a DENY alerts nothing yet is still evidence."""
    from app.services import monitor as svc

    monkeypatch_poll.set_hits([_hit("DENY", "http://bad.example/x", "bad.example")])

    await svc.fetch_logs(minutes=5)

    # Delivery did not happen — neither path.
    assert monkeypatch_poll.n8n_calls == []
    assert monkeypatch_poll.msteams_calls == []

    row = _poll_row(client)
    assert row["filtered"] == 1  # the row survived the whitelist/action filter
    assert row["suppressed_rows"] == 1
    assert row["suppressed_enforced"] == 1
    assert row["webhook_status"] is None
    assert row["webhook_reason"] is not None
    assert SUPPRESSION_MARKER in row["webhook_reason"]

    # The DENY is evidence: persisted, even though it was suppressed.
    findings = client.get("/api/findings/?limit=50").json()
    assert findings["total"] == 1
    assert findings["items"][0]["url"] == "http://bad.example/x"
    assert findings["items"][0]["action"] == "DENY"


# ── (b) ALLOW to an already-blacklisted destination: no alert, still stored ──


async def test_allow_to_blacklisted_destination_is_suppressed_but_persisted(
    client, monkeypatch_poll
):
    """A REACH to an already-blocked host does not re-alert (noise), but the
    row is still persisted — the block was defeated, which is evidence."""
    from app.services import monitor as svc

    _blacklist_host(client, "blocked.example")
    monkeypatch_poll.set_hits(
        [_hit("ALLOW", "http://blocked.example/v", "blocked.example")]
    )

    await svc.fetch_logs(minutes=5)

    assert monkeypatch_poll.n8n_calls == []
    assert monkeypatch_poll.msteams_calls == []

    row = _poll_row(client)
    assert row["filtered"] == 1
    assert row["suppressed_rows"] == 1
    assert row["suppressed_blacklisted"] == 1
    assert row["suppressed_enforced"] == 0
    assert row["webhook_status"] is None
    assert row["webhook_reason"] is not None
    assert SUPPRESSION_MARKER in row["webhook_reason"]

    findings = client.get("/api/findings/?limit=50").json()
    assert findings["total"] == 1
    assert findings["items"][0]["url"] == "http://blocked.example/v"


# ── (c) mixed window: delivery carries ONLY the alertable row ────────────────


async def test_mixed_window_delivers_only_alertable_rows(client, monkeypatch_poll):
    """One alertable ALLOW + one suppressed DENY: the webhook fires, reports the
    FULL filtered count as ``total_matches``, and lists only the alertable row."""
    from app.services import monitor as svc

    monkeypatch_poll.set_hits(
        [
            _hit(
                "ALLOW",
                "http://new.example/x",
                "new.example",
                client_ip="10.1.2.3",
                ts="2026-08-07T10:00:00Z",
            ),
            _hit(
                "DENY",
                "http://stopped.example/y",
                "stopped.example",
                client_ip="10.1.2.4",
                ts="2026-08-07T10:01:00Z",
            ),
        ]
    )

    await svc.fetch_logs(minutes=5)

    # The webhook fired exactly once.
    assert len(monkeypatch_poll.n8n_calls) == 1
    _url, _n_item, payload = monkeypatch_poll.n8n_calls[0]

    # ``total_matches`` counts the rows actually IN the alert — the alertable
    # subset (1), NOT the full filtered window (which the ``monitor_logs`` row
    # records separately as ``filtered``). Pinning both facts keeps the
    # distinction — "how many this alert is about" vs "how many the poll saw" —
    # from silently collapsing.
    assert payload["summary"]["total_matches"] == 1

    # ... while the documents list likewise holds ONLY the alertable ALLOW row.
    delivered_urls = [
        u for doc in payload["documents"] for u in doc["url"]
    ]
    assert delivered_urls == ["http://new.example/x"]
    assert len(payload["documents"]) == 1

    # MS Teams was invoked too (the same alertable subset).
    assert len(monkeypatch_poll.msteams_calls) == 1

    row = _poll_row(client)
    assert row["filtered"] == 2
    assert row["suppressed_rows"] == 1
    assert row["suppressed_enforced"] == 1
    assert row["webhook_status"] == 200


# ── (d) plain ALLOW to a non-blacklisted host: unchanged behaviour ───────────


async def test_alertable_allow_is_delivered_unchanged(client, monkeypatch_poll):
    """An ordinary ALLOW to an unlisted host still delivers — the guard against
    over-suppression."""
    from app.services import monitor as svc

    monkeypatch_poll.set_hits([_hit("ALLOW", "http://fine.example/x", "fine.example")])

    await svc.fetch_logs(minutes=5)

    assert len(monkeypatch_poll.n8n_calls) == 1
    assert len(monkeypatch_poll.msteams_calls) == 1

    row = _poll_row(client)
    assert row["filtered"] == 1
    assert row["suppressed_rows"] == 0
    assert row["webhook_status"] == 200
    assert row["webhook_error"] is None
    assert row["webhook_reason"] is None

    findings = client.get("/api/findings/?limit=50").json()
    assert findings["total"] == 1


# ── (e) the recorded suppression counts are measured, not invented ───────────


async def test_suppression_counts_are_measured_from_seeded_rows(
    client, monkeypatch_poll
):
    """Counts on the ``monitor_logs`` row equal the seeded suppression mix:
    one DENY (enforced) + one ALLOW to a blacklisted host (blacklisted) + one
    alertable ALLOW."""
    from app.services import monitor as svc

    _blacklist_host(client, "blocked.example")
    monkeypatch_poll.set_hits(
        [
            _hit("DENY", "http://bad.example/d", "bad.example", ts="2026-08-07T10:00:00Z"),
            _hit(
                "ALLOW",
                "http://blocked.example/b",
                "blocked.example",
                ts="2026-08-07T10:01:00Z",
            ),
            _hit(
                "ALLOW",
                "http://fine.example/f",
                "fine.example",
                ts="2026-08-07T10:02:00Z",
            ),
        ]
    )

    await svc.fetch_logs(minutes=5)

    row = _poll_row(client)
    assert row["filtered"] == 3
    # Measured integers reflecting the three seeded rows above — not invented:
    # DENY → enforced; ALLOW to a blacklist member → blacklisted; the third
    # ALLOW → alertable.
    assert row["suppressed_rows"] == 2
    assert row["suppressed_enforced"] == 1
    assert row["suppressed_blacklisted"] == 1
    assert row["stored"] == 3  # every row persisted, including suppressed ones

    findings = client.get("/api/findings/?limit=50").json()
    assert findings["total"] == 3
