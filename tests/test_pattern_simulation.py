"""Test Task 9 — Live Kibana Pattern Simulation endpoint."""


def test_simulate_pattern_returns_preview(client):
    res = client.post(
        "/api/patterns/simulate",
        json={"pattern": "*://*executable-share.net/download/*.exe", "timeRange": "24h"},
    )
    assert res.status_code == 200
    body = res.json()
    assert "matchCount" in body
    assert "preview" in body
    assert isinstance(body["preview"], list)
    assert len(body["preview"]) <= 10


async def test_simulate_matches_findings(client):
    """Wildcard patterns match persisted findings within the time window."""
    from datetime import UTC, datetime

    from app.database import get_db

    db = await get_db()
    try:
        await db.execute("DELETE FROM findings")
        now = datetime.now(UTC).isoformat()
        for ip, url in [
            ("10.0.0.1", "http://executable-share.net/download/setup.exe"),
            ("10.0.0.2", "https://cdn.executable-share.net/download/helper.exe"),
            ("10.0.0.3", "http://safe.example/page"),
        ]:
            await db.execute(
                "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
                " VALUES (?, ?, ?, ?, ?)",
                (ip, "203.0.113.1", url, url.split("/")[2], now),
            )
        await db.commit()
    finally:
        await db.close()

    res = client.post(
        "/api/patterns/simulate",
        json={"pattern": "*://*executable-share.net/download/*.exe", "timeRange": "24h"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["matchCount"] == 2
    assert len(body["preview"]) == 2
    urls = {row["url"] for row in body["preview"]}
    assert "http://safe.example/page" not in urls
