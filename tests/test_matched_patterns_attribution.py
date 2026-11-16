"""Regression: a finding's ``matched_patterns`` is never fabricated.

The matched list stored on a findings row (and the poll/query log) must be
the patterns that GENUINELY matched the row's URL/domain. When no block
pattern matches, the stored value is an EMPTY list — never the first block
pattern, never the full pattern set. The UI's "—" rendering is a display
concern; it must not drive persisted attribution ("no synthesized
measurements").

Two paths used to fabricate attribution, both pinned here:
- ``init_db`` startup backfill (app/database.py): legacy rows with empty
  ``matched_patterns`` were force-stamped with the first block pattern when
  nothing actually matched.
- the poll/query store path (app/services/monitor.py): when a batch matched
  nothing, ``log["matched_patterns"]`` fell back to ALL block patterns, and
  that list was then written onto every persisted row.
"""

import json

import pytest

BLOCK = "*zombot*"
MATCHING_URL = "http://zombot123.example/a"
MATCHING_BASE = "zombot123.example"
NONMATCHING_URL = "http://totallyunrelated.example/x"
NONMATCHING_BASE = "totallyunrelated.example"


def _hit(url, base_url, client_ip="10.1.2.3", action="ALLOW", ts="2026-08-07T10:00:00Z"):
    """One ES hit in the shape the monitor reads (``_source`` fields only)."""
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


class _FakeES:
    """Elasticsearch stand-in returning a fixed, pre-seeded hit list."""

    def __init__(self, hits):
        self._hits = list(hits)

    async def search(self, **kwargs):
        return {"hits": {"hits": self._hits}}

    async def close(self):
        pass

    async def field_caps(self, index):
        return {"fields": {}}

    async def ping(self):
        return True


def _poll_row(client):
    """The most recent poll log row."""
    body = client.get("/api/logs/?kind=poll").json()
    return body["items"][0]


def _findings(client):
    """All persisted findings rows."""
    return client.get("/api/findings/").json()


@pytest.fixture
def es_poll(monkeypatch):
    """Wire the poll path to a FakeES + recorded delivery calls (no HTTP).

    Returns a controller: ``set_hits`` re-aims the search result, then each
    test reads back ``matched_patterns`` off the monitor log row and the
    findings table.
    """
    from app.config import get_settings
    from app.services import monitor as svc

    state = {"hits": []}
    fake_es = _FakeES(state["hits"])

    def fake_build(*args, **kwargs):
        return fake_es

    async def fake_send(webhook_url, n_item, payload):
        return 200

    async def fake_msteams(log, result, matched_patterns, block_patterns, **kwargs):
        return None

    monkeypatch.setattr(svc, "build_es_client", fake_build)
    monkeypatch.setattr("app.services.es_client.es_client", lambda *a, **kw: fake_es)
    monkeypatch.setattr("app.services.es_client.build_es_client", fake_build)
    monkeypatch.setattr("app.services.delivery.send_logs", fake_send)
    monkeypatch.setattr(svc, "deliver_msteams", fake_msteams)
    monkeypatch.setattr(get_settings(), "webhook_url", "https://hooks.example/test")
    monkeypatch.setattr(get_settings(), "msteams_webhook_url", "https://teams.example/test")

    class Controller:
        def set_hits(self, hits):
            state["hits"] = list(hits)
            fake_es._hits = state["hits"]

    return Controller()


async def _replace_block_patterns(client):
    """Replace the (seeded) block-pattern set with exactly one known pattern.

    The app lifespan seeds ~23 block patterns, any of which could match a test
    URL by chance. For determinism we delete them all and insert a single
    distinctive pattern (``*zombot*``) whose only match is our own URL.
    """
    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM url_patterns WHERE pattern_type='block'")
        await db.execute(
            "INSERT INTO url_patterns (pattern, pattern_type) VALUES (?, 'block')",
            (BLOCK,),
        )
        await db.commit()
    finally:
        await db.close()


# ── (a) database.py startup backfill: no-match row stays empty ──────────────


async def test_backfill_never_fabricates_a_matching_pattern(client, db_path):
    """A legacy row whose URL matches NO block pattern keeps an empty
    ``matched_patterns`` — the backfill must NOT stamp the first pattern."""
    await _replace_block_patterns(client)
    from app.database import get_db, init_db

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            ("1.1.1.1", "", NONMATCHING_URL, NONMATCHING_BASE, "2026-08-05T04:00:00Z"),
        )
        await db.commit()
    finally:
        await db.close()

    # (Re-)run the startup migration; the backfill block is what matters.
    await init_db()

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT url, matched_patterns FROM findings WHERE url = ?",
            (NONMATCHING_URL,),
        )
        row = await cursor.fetchone()
    finally:
        await db.close()

    assert row is not None
    assert json.loads(row[1]) == []


async def test_backfill_records_genuinely_matching_pattern(client, db_path):
    """A legacy row whose URL matches a block pattern is stamped with exactly
    that pattern (the real-match path is preserved, not just the empty one)."""
    await _replace_block_patterns(client)
    from app.database import get_db, init_db

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?)",
            ("1.1.1.1", "", MATCHING_URL, MATCHING_BASE, "2026-08-05T04:00:00Z"),
        )
        await db.commit()
    finally:
        await db.close()

    await init_db()

    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT matched_patterns FROM findings WHERE url = ?",
            (MATCHING_URL,),
        )
        row = await cursor.fetchone()
    finally:
        await db.close()

    assert json.loads(row[0]) == [BLOCK]


# ── (b) monitor poll/store path: no-match batch stores empty, not all ───────


async def test_poll_stores_empty_matched_patterns_when_nothing_matches(
    client, es_poll, monkeypatch
):
    """A poll window whose rows match NO block pattern persists rows with
    ``matched_patterns == []`` and records an empty log list — not the full
    block-pattern set."""
    from app.services import monitor as svc

    await _replace_block_patterns(client)
    es_poll.set_hits([_hit(NONMATCHING_URL, NONMATCHING_BASE)])

    await svc.fetch_logs(minutes=5)

    row = _poll_row(client)
    assert json.loads(row["matched_patterns"] or "[]") == []

    stored = _findings(client)["items"]
    assert len(stored) == 1
    assert json.loads(stored[0]["matched_patterns"] or "[]") == []


async def test_poll_records_genuinely_matching_pattern(client, es_poll):
    """A poll window where a row genuinely matches records exactly that
    pattern on both the log and the persisted row (no over-attribution)."""
    from app.services import monitor as svc

    await _replace_block_patterns(client)
    es_poll.set_hits([_hit(MATCHING_URL, MATCHING_BASE)])

    await svc.fetch_logs(minutes=5)

    row = _poll_row(client)
    assert json.loads(row["matched_patterns"] or "[]") == [BLOCK]

    stored = _findings(client)["items"]
    assert len(stored) == 1
    assert json.loads(stored[0]["matched_patterns"] or "[]") == [BLOCK]