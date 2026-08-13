"""findings_graph whitelist exclusion — SQL fast path + response shape.

The graph endpoint pushes whitelist exclusion into SQL (NOT LIKE clauses)
with a pure-Python re.search fallback for patterns that can't be safely
translated. These tests pin that whitelisted destinations never appear as
graph nodes, and that the response shape stays {nodes, links, flows}.
"""


async def test_findings_graph_whitelist_excluded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", "2026-01-01T00:00:00Z"),
            (
                "1.1.1.1",
                "",
                "http://safe-porn-ads.example/b",
                "safe-porn-ads.example",
                "2026-01-01T00:00:00Z",
            ),
        ],
    )
    await db.commit()
    await db.close()

    # Add the whitelist pattern (*porn-ads* → SQL '%porn-ads%' via the fast
    # path). Note: `*porn*` itself is pre-seeded as a block pattern, so it
    # would 409 on the UNIQUE(pattern) constraint — this one is not seeded.
    resp = client.post(
        "/api/patterns/", json={"pattern": "*porn-ads*", "pattern_type": "whitelist"}
    )
    assert resp.status_code == 201

    res = client.get("/api/findings/graph?limit=30")
    assert res.status_code == 200
    data = res.json()
    assert set(data) == {"nodes", "links", "flows"}
    urls = {n["label"] for n in data["nodes"] if n["kind"] == "url"}
    assert "http://safe-porn-ads.example/b" not in urls  # whitelisted -> excluded
    assert "http://evil.example/a" in urls


async def test_findings_graph_keeps_rows_without_whitelist(client, db_path):
    """Without any whitelist patterns the graph still returns every row."""
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        [
            ("2.2.2.2", "", "http://keep.example/x", "keep.example", "2026-01-01T00:00:00Z"),
        ],
    )
    await db.commit()
    await db.close()

    res = client.get("/api/findings/graph?limit=30")
    assert res.status_code == 200
    data = res.json()
    urls = {n["label"] for n in data["nodes"] if n["kind"] == "url"}
    assert "http://keep.example/x" in urls
    # The matching flow row must be present too.
    assert any(f["url"] == "http://keep.example/x" for f in data["flows"])
