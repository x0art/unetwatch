"""Tests for the per-client URL drill-down endpoints (Traffic page)."""


async def _seed_findings(db_path) -> None:
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.execute("DELETE FROM findings")
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        [
            # client 1.1.1.1 -> 2 URLs, 3 accesses, ALL on a.example
            ("1.1.1.1", "", "http://a.example/1", "a.example", "2026-08-01T00:00:00Z"),
            ("1.1.1.1", "", "http://a.example/1", "a.example", "2026-08-01T00:00:01Z"),
            ("1.1.1.1", "", "http://a.example/2", "a.example", "2026-08-01T00:00:02Z"),
            # client 2.2.2.2 -> 2 URLs, 3 accesses (mixed hosts)
            ("2.2.2.2", "", "http://b.example/3", "b.example", "2026-08-01T00:00:03Z"),
            ("2.2.2.2", "", "http://c.example/4", "c.example", "2026-08-01T00:00:04Z"),
            ("2.2.2.2", "", "http://c.example/4", "c.example", "2026-08-01T00:00:05Z"),
            # old row outside any 24h window
            ("3.3.3.3", "", "http://d.example/5", "d.example", "2020-01-01T00:00:00Z"),
        ],
    )
    await db.commit()
    await db.close()


async def test_top_clients_ranked(client, db_path):
    await _seed_findings(db_path)
    res = client.get("/api/findings/top-clients")
    assert res.status_code == 200
    assert res.json()["items"] == [
        {"client_ip": "1.1.1.1", "count": 3},
        {"client_ip": "2.2.2.2", "count": 3},
        {"client_ip": "3.3.3.3", "count": 1},
    ]


async def test_top_clients_search(client, db_path):
    await _seed_findings(db_path)
    items = client.get("/api/findings/top-clients?search=1.1.").json()["items"]
    assert items == [{"client_ip": "1.1.1.1", "count": 3}]
    assert client.get("/api/findings/top-clients?search=nope").json()["items"] == []


async def test_top_clients_limit(client, db_path):
    await _seed_findings(db_path)
    items = client.get("/api/findings/top-clients?limit=2").json()["items"]
    assert len(items) == 2
    assert items[0]["client_ip"] == "1.1.1.1"


async def test_top_clients_whitelist_glob_excluded(client, db_path):
    """SQL-expressible whitelist globs drop matching clients (fast path)."""
    await _seed_findings(db_path)
    resp = client.post(
        "/api/patterns/", json={"pattern": "*a.example*", "pattern_type": "whitelist"}
    )
    assert resp.status_code == 201
    items = client.get("/api/findings/top-clients").json()["items"]
    assert items == [
        {"client_ip": "2.2.2.2", "count": 3},
        {"client_ip": "3.3.3.3", "count": 1},
    ]


async def test_top_clients_whitelist_fallback_excluded(client, db_path):
    """Literal whitelist patterns (no wildcard) use the Python row-level fallback."""
    await _seed_findings(db_path)
    resp = client.post(
        "/api/patterns/", json={"pattern": "a.example", "pattern_type": "whitelist"}
    )
    assert resp.status_code == 201
    items = client.get("/api/findings/top-clients").json()["items"]
    assert items == [
        {"client_ip": "2.2.2.2", "count": 3},
        {"client_ip": "3.3.3.3", "count": 1},
    ]
