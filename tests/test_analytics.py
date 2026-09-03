"""Analytics & Reports endpoints — shape and aggregation tests (spec §3.4).

All endpoints aggregate the persisted ``findings`` table (the same slice the
Findings page shows). These tests pin the response shapes and the COLLAPSED
fallbacks: when the ``action`` column is absent, DENY/blocked counts use
``matched_patterns != '[]'`` as the proxy, and volume uses the documented
per-request byte heuristic.
"""

import re

_INSERT_SQL = (
    "INSERT INTO findings (client_ip, server_ip, url, base_url, "
    "log_timestamp, matched_patterns) VALUES (?, ?, ?, ?, ?, ?)"
)


async def test_analytics_summary(client):
    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert "totalVolume" in data
    assert "totalBlocked" in data
    assert "topBandwidthHost" in data
    assert "peakTrafficTime" in data
    assert "has_data" in data
    # Empty DB → no data in window.
    assert data["has_data"] is False


async def test_analytics_summary_seeded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        _INSERT_SQL,
        [
            (
                "10.0.0.1",
                "172.16.0.1",
                "http://a.example/x",
                "a.example",
                "2026-09-01T10:00:00Z",
                '["*/admin/*"]',
            ),
            (
                "10.0.0.1",
                "172.16.0.1",
                "http://a.example/y",
                "a.example",
                "2026-09-01T11:00:00Z",
                '["*/admin/*"]',
            ),
            (
                "10.0.0.2",
                "172.16.0.2",
                "http://b.example/z",
                "b.example",
                "2026-09-02T14:00:00Z",
                '["*paypal*"]',
            ),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/analytics/summary?range=30d")
    assert res.status_code == 200
    data = res.json()
    assert data["has_data"] is True
    # COLLAPSED mode (no action column) → blocked = rows with a matched pattern.
    assert data["totalBlocked"] == 3
    # Volume heuristic: 8 KiB per request when duration_seconds is unavailable.
    assert data["totalVolume"] == 3 * 8192
    assert data["topBandwidthHost"] == "10.0.0.1"
    assert re.match(r"^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:00", data["peakTrafficTime"])


async def test_analytics_summary_previous_period(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        _INSERT_SQL,
        [
            ("10.0.0.1", "", "http://a.example/x", "a.example", "2026-09-01T10:00:00Z", "[]"),
            ("10.0.0.1", "", "http://a.example/y", "a.example", "2026-09-02T10:00:00Z", "[]"),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/analytics/summary?range=30d&compare=previous")
    assert res.status_code == 200
    data = res.json()
    assert data["has_data"] is True
    assert "previous" in data
    assert "volumeDeltaPct" in data
    assert "blockedDeltaPct" in data


async def test_analytics_bandwidth_shape(client):
    res = client.get("/api/analytics/bandwidth?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert "points" in data
    assert all({"bucket", "inbound", "outbound"} <= set(p) for p in data["points"])


async def test_analytics_bandwidth_seeded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        [
            ("10.0.0.1", "", "http://a.example/x", "a.example", "2026-09-01T10:00:00Z"),
            ("10.0.0.1", "", "http://a.example/y", "a.example", "2026-09-01T11:00:00Z"),
            ("10.0.0.2", "", "http://b.example/z", "b.example", "2026-09-02T14:00:00Z"),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/analytics/bandwidth?range=30d")
    assert res.status_code == 200
    points = res.json()["points"]
    by_bucket = {p["bucket"]: p for p in points}
    assert "2026-09-01" in by_bucket
    assert by_bucket["2026-09-01"]["outbound"] == 2 * 8192
    assert by_bucket["2026-09-02"]["outbound"] == 8192
    # Direction is not captured by the feed → inbound stays zero.
    assert by_bucket["2026-09-01"]["inbound"] == 0


async def test_analytics_enforcements_seeded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        _INSERT_SQL,
        [
            (
                "10.0.0.1",
                "",
                "http://a.example/x",
                "a.example",
                "2026-09-01T10:00:00Z",
                '["*/admin/*"]',
            ),
            (
                "10.0.0.1",
                "",
                "http://a.example/y",
                "a.example",
                "2026-09-01T11:00:00Z",
                "[]",
            ),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/analytics/enforcements?range=30d")
    assert res.status_code == 200
    by_bucket = {p["bucket"]: p for p in res.json()["points"]}
    assert by_bucket["2026-09-01"]["deny"] == 1  # matched pattern → deny proxy
    assert by_bucket["2026-09-01"]["allow"] == 1


async def test_analytics_top_domains_seeded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        [
            ("10.0.0.1", "", "http://a.example/x", "a.example", "2026-09-01T10:00:00Z"),
            ("10.0.0.1", "", "http://a.example/y", "a.example", "2026-09-01T11:00:00Z"),
            ("10.0.0.2", "", "http://b.example/z", "b.example", "2026-09-02T14:00:00Z"),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/analytics/top-domains?range=30d")
    assert res.status_code == 200
    items = res.json()["items"]
    assert items[0]["domain"] == "a.example"
    assert items[0]["volume"] == 2 * 8192
    assert items[0]["pct"] > items[1]["pct"]
    assert items[1]["domain"] == "b.example"


async def test_analytics_top_denied_seeded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        _INSERT_SQL,
        [
            (
                "10.0.0.1",
                "",
                "http://a.example/x",
                "a.example",
                "2026-09-01T10:00:00Z",
                '["*/admin/*"]',
            ),
            (
                "10.0.0.1",
                "",
                "http://a.example/y",
                "a.example",
                "2026-09-01T11:00:00Z",
                '["*/admin/*", "*c2*"]',
            ),
            (
                "10.0.0.2",
                "",
                "http://b.example/z",
                "b.example",
                "2026-09-02T14:00:00Z",
                '["*paypal*"]',
            ),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/analytics/top-denied?range=30d")
    assert res.status_code == 200
    items = res.json()["items"]
    assert items[0]["domain"] == "a.example"
    assert items[0]["blocks"] == 2
    assert items[0]["primaryRule"] == "*/admin/*"
    assert items[1]["domain"] == "b.example"
    assert items[1]["blocks"] == 1
    assert items[1]["primaryRule"] == "*paypal*"
