"""URL/Domain search gating: full-URL drill-down finds host-level rows.

Covers the url_breakdown hostname normalization (full URL → hostname LIKE
match) and the run_all_query exclude_blacklist control (default shows
blacklisted rows; True strips them).
"""

import aiosqlite

from app.routes.findings import _normalize_url_host
from app.services.monitor import _invalidate_query_cache, run_all_query


async def _seed(db_path) -> None:
    from app.database import init_db

    await init_db()
    db = await aiosqlite.connect(db_path)
    await db.execute("DELETE FROM findings")
    await db.execute("DELETE FROM blacklist_entries")
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        [
            ("1.1.1.1", "", "http://evil.example/deep/path?q=1", "evil.example",
             "2026-08-01T00:00:00Z"),
            ("2.2.2.2", "", "http://evil.example/other", "evil.example",
             "2026-08-01T00:00:01Z"),
            ("3.3.3.3", "", "http://safe.example/", "safe.example",
             "2026-08-01T00:00:02Z"),
        ],
    )
    await db.execute(
        "INSERT INTO blacklist_entries (kind, value) VALUES ('url', 'evil.example')"
    )
    await db.commit()
    await db.close()


def test_normalize_url_host_strips_scheme_port_path():
    assert _normalize_url_host("https://evil.example:8443/deep/path?q=1") == "evil.example"
    assert _normalize_url_host("http://evil.example/other") == "evil.example"
    assert _normalize_url_host("evil.example") == "evil.example"
    assert _normalize_url_host("  EVIL.Example  ") == "evil.example"
    assert _normalize_url_host("") == ""


async def test_url_breakdown_full_url_matches_host_rows(client, db_path):
    """A full-URL drill-down resolves to the hostname and matches every path."""
    await _seed(db_path)
    # Path param must be URL-encoded; TestClient handles the raw string here.
    res = client.get("/api/findings/url/http://evil.example/deep/path?q=1")
    assert res.status_code == 200
    data = res.json()
    assert data["source"] == "findings"
    assert data["total_accesses"] == 2
    assert {c["client_ip"] for c in data["clients"]} == {"1.1.1.1", "2.2.2.2"}


async def test_url_breakdown_origin_matches_host_rows(client, db_path):
    await _seed(db_path)
    res = client.get("/api/findings/url/https://evil.example:8443")
    assert res.status_code == 200
    assert res.json()["total_accesses"] == 2


class _FakeES:
    """Minimal ES stub: returns the given docs as hits."""

    def __init__(self, docs):
        self._docs = docs

    async def search(self, index=None, body=None):
        return {"hits": {"hits": [{"_source": d} for d in self._docs]}}

    async def close(self):
        pass


def _doc(url, base_url, client_ip="1.1.1.1"):
    return {
        "url": url,
        "base_url": base_url,
        "client_ip": client_ip,
        "server_ip": "",
        "action": "ALLOW",
        "@timestamp": "2026-08-01T00:00:00Z",
    }


async def _run_all(docs, db_path, **kwargs):
    import app.services.monitor as mon

    fake = _FakeES(docs)
    orig_context = mon._es_client_context

    class _Ctx:
        async def __aenter__(self):
            return fake

        async def __aexit__(self, *exc):
            return False

    mon._es_client_context = lambda *a, **k: _Ctx()  # noqa: E731
    try:
        _invalidate_query_cache()
        return await run_all_query(minutes=60, **kwargs)
    finally:
        mon._es_client_context = orig_context
        _invalidate_query_cache()


async def test_run_all_query_default_shows_blacklisted(db_path):
    """exclude_blacklist=False (default) keeps blacklisted rows visible."""
    await _seed(db_path)
    docs = [
        _doc("http://evil.example/a", "evil.example"),
        _doc("http://safe.example/", "safe.example"),
    ]
    out = await _run_all(docs, db_path)
    urls = {i["url"] for i in out["items"]}
    assert urls == {"http://evil.example/a", "http://safe.example/"}
    assert out["total_requests"] == 2


async def test_run_all_query_exclude_blacklist_strips(db_path):
    await _seed(db_path)
    docs = [
        _doc("http://evil.example/a", "evil.example"),
        _doc("http://safe.example/", "safe.example"),
    ]
    out = await _run_all(docs, db_path, exclude_blacklist=True)
    urls = [i["url"] for i in out["items"]]
    assert urls == ["http://safe.example/"]
    assert out["total_requests"] == 1


async def test_minutes_caps_allow_365d(client):
    """A 400-day window validates (365d cap), a 4000-day window 422s."""
    ok = client.get("/api/query/run?view_mode=all&minutes=500000")
    assert ok.status_code == 200
    bad = client.get("/api/query/run?view_mode=all&minutes=600000")
    assert bad.status_code == 422
