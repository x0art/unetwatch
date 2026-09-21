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
        "INSERT INTO jaillist_entries (value, source) VALUES (?, ?)",
        ("10.0.0.77", "manual"),
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
    # Shape changed per docs/suggestion-queues.md §7.1: the explicit export
    # column lists now carry the new columns (blacklist: finding_id;
    # jaillist: the eight findability columns). The seeded rows carry only
    # value/source, so every new column is at its column default here; full
    # dict equality is kept so an accidental column drop still fails.
    assert {
        "kind": "url",
        "value": "evil.example",
        "source": "manual",
        "finding_id": None,
    } in body["blacklist"]
    assert {
        "value": "10.0.0.77",
        "source": "manual",
        "finding_id": None,
        "reason": "",
        "url": "",
        "category": "",
        "note": "",
        "evidence_summary": "{}",
        "decided_by": "",
        "decided_at": "",
        "verdict_id": None,
    } in body["jaillist"]
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
        "jaillist_entries",
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
        "jaillist_entries",
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


async def test_backup_import_coerces_unknown_jaillist_source(client, db_path):
    """A crafted backup claiming an unknown jaillist source imports as manual."""
    await _seed(db_path)
    backup = client.get("/api/backup/export").json()
    backup["jaillist"].append({"value": "9.9.9.9", "source": "evil"})
    resp = client.post("/api/backup/import", json=backup)
    assert resp.status_code == 200
    db = await aiosqlite.connect(db_path)
    cursor = await db.execute(
        "SELECT source FROM jaillist_entries WHERE value = '9.9.9.9'"
    )
    row = await cursor.fetchone()
    await db.close()
    assert row[0] == "manual"


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


async def test_backup_round_trips_jaillist_findability_columns(client, db_path):
    """The §7.1 findability columns survive export → wipe → import.

    These columns are the operator's jail justification — the information
    substitute for the expiry policy the owner declined — and the explicit
    export column list would silently drop any of them. Pin the round-trip
    so a future column addition that forgets the export fails here.
    """
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT INTO jaillist_entries (value, source, finding_id, reason, url,"
        " category, note, evidence_summary, decided_by, decided_at, verdict_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "10.7.7.7/32",
            "finding",
            77,
            "REACH to 3 blocked destinations across 2 days",
            "https://evil.example/video/123",
            "operator-class",
            "noted",
            '{"rule_ids": ["S2", "S5"]}',
            "admin",
            "2026-09-21T03:17:36+00:00",
            12,
        ),
    )
    await db.commit()
    await db.close()

    backup = client.get("/api/backup/export").json()
    entry = next(e for e in backup["jaillist"] if e["value"] == "10.7.7.7/32")
    # The export carries every findability column, not just value/source.
    assert entry["finding_id"] == 77
    assert entry["reason"] == "REACH to 3 blocked destinations across 2 days"
    assert entry["url"] == "https://evil.example/video/123"
    assert entry["category"] == "operator-class"
    assert entry["note"] == "noted"
    assert entry["evidence_summary"] == '{"rule_ids": ["S2", "S5"]}'
    assert entry["decided_by"] == "admin"
    assert entry["decided_at"] == "2026-09-21T03:17:36+00:00"
    assert entry["verdict_id"] == 12

    db = await aiosqlite.connect(db_path)
    await db.execute("DELETE FROM jaillist_entries")
    await db.commit()
    await db.close()

    resp = client.post("/api/backup/import", json=backup)
    assert resp.status_code == 200

    db = await aiosqlite.connect(db_path)
    db.row_factory = aiosqlite.Row
    cursor = await db.execute(
        "SELECT finding_id, reason, url, category, note, evidence_summary,"
        " decided_by, decided_at, verdict_id FROM jaillist_entries"
        " WHERE value = '10.7.7.7/32'"
    )
    row = await cursor.fetchone()
    await db.close()
    assert row["finding_id"] == 77
    assert row["reason"] == "REACH to 3 blocked destinations across 2 days"
    assert row["url"] == "https://evil.example/video/123"
    assert row["category"] == "operator-class"
    assert row["note"] == "noted"
    assert row["evidence_summary"] == '{"rule_ids": ["S2", "S5"]}'
    assert row["decided_by"] == "admin"
    assert row["decided_at"] == "2026-09-21T03:17:36+00:00"
    assert row["verdict_id"] == 12
