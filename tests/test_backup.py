"""Tests for JSON backup/restore at /api/backup/ (spec §3)."""

import aiosqlite


async def _seed(db_path):
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT INTO url_patterns (pattern, pattern_type) VALUES (?, ?)",
        ("*evil*", "block"),
    )
    await db.execute("INSERT INTO url_whitelist (pattern) VALUES (?)", ("*safe*",))
    await db.execute(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        ("1.2.3.4", "", "http://evil.example/x", "evil.example", "2026-01-01T00:00:00Z"),
    )
    await db.execute(
        "INSERT INTO blacklist_entries (kind, value, source) VALUES (?, ?, ?)",
        ("url", "evil.example", "manual"),
    )
    await db.execute(
        "INSERT INTO tracked_urls (url, source) VALUES (?, ?)",
        ("http://evil.example/x", "manual"),
    )
    await db.execute(
        "INSERT INTO redirect_edges (source_url, target_url, http_status,"
        " first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        (
            "http://evil.example/x",
            "http://evil.example/y",
            302,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        ),
    )
    await db.execute(
        "INSERT INTO monitor_logs (kind, started_at) VALUES (?, ?)",
        ("poll", "2026-01-01T00:00:00Z"),
    )
    await db.commit()
    await db.close()


async def test_backup_export_shape(client, db_path):
    """Export carries seeded rows, no secret-ish keys, no monitor_logs."""
    await _seed(db_path)
    resp = client.get("/api/backup/export")
    assert resp.status_code == 200
    assert "unetwatch-backup-" in resp.headers["content-disposition"]
    body = resp.json()

    assert body["version"] == 1
    assert body["exported_at"]
    assert {"pattern": "*evil*", "pattern_type": "block"} in body["patterns"]
    assert {"pattern": "*safe*"} in body["whitelist"]
    assert any(f["url"] == "http://evil.example/x" for f in body["findings"])
    assert {"kind": "url", "value": "evil.example", "source": "manual"} in body[
        "blacklist"
    ]
    assert any(t["url"] == "http://evil.example/x" for t in body["tracked_urls"])
    assert any(
        e["source_url"] == "http://evil.example/x" for e in body["redirect_edges"]
    )

    # Findings / tracked / edges carry rows minus id.
    for section in ("findings", "tracked_urls", "redirect_edges"):
        assert body[section], section
        assert all("id" not in row for row in body[section]), section

    # No credentials, no session material, no monitor noise anywhere.
    blob = resp.text.lower()
    for key in ("monitor_logs", "api_key", "admin_pass", "elastic_pass", "token"):
        assert key not in blob, key


async def _counts(db_path):
    db = await aiosqlite.connect(db_path)
    out = {}
    for table in (
        "url_patterns",
        "url_whitelist",
        "findings",
        "blacklist_entries",
        "tracked_urls",
        "redirect_edges",
    ):
        cursor = await db.execute(f"SELECT COUNT(*) FROM {table}")
        out[table] = (await cursor.fetchone())[0]
    await db.close()
    return out


async def test_backup_import_round_trip(client, db_path):
    """Export → wipe → import restores the same counts."""
    await _seed(db_path)
    backup = client.get("/api/backup/export").json()
    before = await _counts(db_path)

    db = await aiosqlite.connect(db_path)
    for table in (
        "url_patterns",
        "url_whitelist",
        "findings",
        "blacklist_entries",
        "tracked_urls",
        "redirect_edges",
    ):
        await db.execute(f"DELETE FROM {table}")
    await db.commit()
    await db.close()
    wiped = await _counts(db_path)
    assert all(v == 0 for v in wiped.values())

    resp = client.post("/api/backup/import", json=backup)
    assert resp.status_code == 200
    data = resp.json()
    assert data["dry_run"] is False
    assert all(v == 0 for v in data["skipped"].values())
    assert await _counts(db_path) == before


async def test_backup_import_dry_run_writes_nothing(client, db_path):
    await _seed(db_path)
    backup = client.get("/api/backup/export").json()
    backup["dry_run"] = True
    before = await _counts(db_path)

    resp = client.post("/api/backup/import", json=backup)
    assert resp.status_code == 200
    data = resp.json()
    assert data["dry_run"] is True
    # Everything already exists → all skipped, none added.
    assert all(v == 0 for v in data["added"].values())
    assert await _counts(db_path) == before


async def test_backup_import_bad_version_400(client):
    resp = client.post("/api/backup/import", json={"version": 999})
    assert resp.status_code == 400


async def test_backup_import_idempotent(client, db_path):
    """Re-importing the same backup adds 0 rows."""
    await _seed(db_path)
    backup = client.get("/api/backup/export").json()

    first = client.post("/api/backup/import", json=backup).json()
    assert all(v == 0 for v in first["added"].values())

    second = client.post("/api/backup/import", json=backup).json()
    assert all(v == 0 for v in second["added"].values())
    total_added = sum(second["added"].values())
    assert total_added == 0
