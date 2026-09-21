"""Verdict ledger — the record of a human decision on a flagged subject.

Covers the four verdicts (each writes exactly one ``triage_events`` row),
the artifacts two of them write, ``INCONCLUSIVE`` writing nothing else, the
``finding_id`` link the design notes was "never populated by any caller",
and rejection of an out-of-enum verdict.
"""
import aiosqlite
import pytest


async def _seed_findings(db_path, rows) -> None:
    db = await aiosqlite.connect(db_path)
    await db.execute("DELETE FROM findings")
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp,"
        " action, intent, matched_patterns) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    await db.commit()
    await db.close()


async def _count(db_path, table: str, where: str = "", args: tuple = ()) -> int:
    db = await aiosqlite.connect(db_path)
    cur = await db.execute(f"SELECT COUNT(*) FROM {table} {where}", args)
    n = (await cur.fetchone())[0]
    await db.close()
    return n


async def _row(db_path, sql: str, args: tuple = ()):
    db = await aiosqlite.connect(db_path)
    db.row_factory = aiosqlite.Row
    cur = await db.execute(sql, args)
    row = await cur.fetchone()
    await db.close()
    return row


async def _post(client, **body):
    return client.post("/api/triage/verdict", json=body)


# ── one ledger row per verdict ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "verdict,kind,subject",
    [
        ("HARMFUL_DESTINATION", "destination", "evil.example"),
        ("HARMFUL_SOURCE", "source", "10.5.5.5"),
        ("NOT_HARMFUL", "destination", "legit.example"),
        ("INCONCLUSIVE", "destination", "parked.example"),
    ],
)
async def test_each_verdict_writes_exactly_one_event(
    client, db_path, verdict, kind, subject
):
    res = await _post(
        client, subject_kind=kind, subject=subject, verdict=verdict, finding_id=42
    )
    assert res.status_code == 201, res.text
    assert res.json()["verdict"] == verdict
    assert await _count(db_path, "triage_events") == 1
    row = await _row(
        db_path,
        "SELECT subject_kind, subject, verdict, finding_id, decided_by,"
        " decided_at, decided_tz FROM triage_events",
    )
    assert row["subject_kind"] == kind
    assert row["subject"] == subject
    assert row["verdict"] == verdict
    assert row["finding_id"] == 42
    # The authenticated admin identity and a UTC timestamp are recorded.
    assert row["decided_by"] == "admin"
    assert row["decided_at"].endswith("+00:00")
    assert row["decided_tz"]


async def test_inconclusive_writes_no_other_table(client, db_path):
    """The design's mandatory state: one ledger row, and NOTHING else."""
    res = await _post(
        client,
        subject_kind="destination",
        subject="parked.example",
        verdict="INCONCLUSIVE",
        finding_id=1,
    )
    assert res.status_code == 201
    assert res.json()["artifact"] is None
    assert await _count(db_path, "triage_events") == 1
    # The default seed populates the list tables, so assert on the SUBJECT:
    # INCONCLUSIVE must not have created any artifact for it.
    assert (
        await _count(
            db_path,
            "blacklist_entries",
            "WHERE value = ? OR finding_id = ?",
            ("parked.example", 1),
        )
        == 0
    )
    assert await _count(db_path, "jaillist_entries", "WHERE finding_id = ?", (1,)) == 0
    assert (
        await _count(
            db_path,
            "url_patterns",
            "WHERE pattern = ? AND pattern_type = 'whitelist'",
            ("parked.example",),
        )
        == 0
    )


async def test_invalid_verdict_is_rejected(client, db_path):
    res = await _post(
        client, subject_kind="destination", subject="x.example", verdict="MAYBE"
    )
    assert res.status_code == 422
    assert await _count(db_path, "triage_events") == 0


async def test_invalid_subject_kind_is_rejected(client, db_path):
    res = await _post(
        client, subject_kind="banana", subject="x.example", verdict="INCONCLUSIVE"
    )
    assert res.status_code == 422
    assert await _count(db_path, "triage_events") == 0


# ── HARMFUL_DESTINATION writes the blacklist and the feed ───────────────────


async def test_harmful_destination_blacklists_and_populates_finding_id(
    client, db_path
):
    res = await _post(
        client,
        subject_kind="destination",
        subject="https://evil.example/path?x=1",
        verdict="HARMFUL_DESTINATION",
        finding_id=7,
    )
    assert res.status_code == 201, res.text
    assert res.json()["artifact"] == {
        "kind": "url",
        "value": "evil.example",
        "added": True,
    }
    assert await _count(db_path, "triage_events") == 1
    row = await _row(
        db_path,
        "SELECT kind, value, source, finding_id FROM blacklist_entries",
    )
    assert row["kind"] == "url"
    assert row["value"] == "evil.example"
    assert row["finding_id"] == 7  # the dead-by-default column, now populated


async def test_harmful_destination_regenerates_urls_feed(client, db_path):
    from pathlib import Path

    await _post(
        client,
        subject_kind="destination",
        subject="evil.example",
        verdict="HARMFUL_DESTINATION",
    )
    feed = Path(db_path).parent / "feeds" / "urls.txt"
    assert feed.exists()
    assert feed.read_bytes() == b"evil.example\r\n"


# ── HARMFUL_SOURCE jails and regenerates jail-ips.txt ───────────────────────


async def test_harmful_source_jails_and_regenerates_feed(client, db_path):
    from pathlib import Path

    res = await _post(
        client,
        subject_kind="source",
        subject="10.9.9.9",
        verdict="HARMFUL_SOURCE",
        finding_id=99,
        note="REACH to 3 blocked destinations across 2 days",
    )
    assert res.status_code == 201, res.text
    assert await _count(db_path, "triage_events") == 1
    row = await _row(
        db_path,
        "SELECT value, source, finding_id, reason, decided_by, evidence_summary,"
        " verdict_id FROM jaillist_entries",
    )
    assert row["value"] == "10.9.9.9/32"  # existing normalization path
    assert row["finding_id"] == 99
    assert row["reason"] == "REACH to 3 blocked destinations across 2 days"
    assert row["decided_by"] == "admin"
    assert row["evidence_summary"]  # frozen JSON, not empty
    assert row["verdict_id"] == 1  # links back to the ledger row

    feed = Path(db_path).parent / "feeds" / "jail-ips.txt"
    assert feed.exists()
    assert feed.read_bytes() == b"10.9.9.9/32\r\n"


# ── NOT_HARMFUL whitelists and excludes future findings ─────────────────────


async def test_not_harmful_creates_whitelist_and_excludes_from_findings(
    client, db_path
):
    await _seed_findings(
        db_path,
        [
            (
                "1.1.1.1",
                "",
                "http://legit.example/a",
                "legit.example",
                "2026-08-01T00:00:00Z",
                "ALLOW",
                "REACH",
                '["*block*"]',
            ),
        ],
    )
    # Pre-condition: the finding is visible.
    assert client.get("/api/findings/graph").json()["nodes"]

    res = await _post(
        client,
        subject_kind="destination",
        subject="legit.example",
        verdict="NOT_HARMFUL",
        finding_id=3,
    )
    assert res.status_code == 201, res.text
    assert res.json()["artifact"] == {"pattern": "legit.example", "created": True}
    assert await _count(db_path, "triage_events") == 1
    pat = await _row(
        db_path,
        "SELECT pattern, pattern_type FROM url_patterns WHERE pattern = 'legit.example'",
    )
    assert pat["pattern_type"] == "whitelist"

    # Post-condition: the whitelisted destination drops out of future findings.
    assert not client.get("/api/findings/graph").json()["nodes"]


# ── history endpoint: three distinguishable answers ─────────────────────────


async def test_history_distinguishes_block_states(client, db_path):
    # not blocked, no events
    res = client.get(
        "/api/triage/history",
        params={"subject_kind": "destination", "subject": "a.example"},
    ).json()
    assert res["blocked"] is False and res["has_events"] is False

    # blocked with events
    await _post(
        client,
        subject_kind="destination",
        subject="b.example",
        verdict="HARMFUL_DESTINATION",
        finding_id=1,
    )
    res = client.get(
        "/api/triage/history",
        params={"subject_kind": "destination", "subject": "b.example"},
    ).json()
    assert res["blocked"] is True and res["has_events"] is True
    assert res["effective_verdict"] == "HARMFUL_DESTINATION"
    assert len(res["verdicts"]) == 1


# ── supersede chain: effective verdict follows supersedes_id ────────────────


async def test_effective_verdict_follows_the_supersede_chain(client, db_path):
    first = await _post(
        client,
        subject_kind="destination",
        subject="c.example",
        verdict="INCONCLUSIVE",
        finding_id=1,
    )
    first_id = first.json()["verdict_id"]

    await _post(
        client,
        subject_kind="destination",
        subject="c.example",
        verdict="HARMFUL_DESTINATION",
        finding_id=2,
        supersedes_id=first_id,
    )
    res = client.get(
        "/api/triage/history",
        params={"subject_kind": "destination", "subject": "c.example"},
    ).json()
    assert res["effective_verdict"] == "HARMFUL_DESTINATION"
    assert res["effective_verdict_id"] != first_id
    assert len(res["verdicts"]) == 2  # the chain is not pruned


def test_verdict_requires_admin(db_path):
    """No credentials → 401, and nothing is written."""
    import asyncio

    from fastapi.testclient import TestClient

    from app.database import init_db
    from app.main import app

    asyncio.run(init_db())
    with TestClient(app, raise_server_exceptions=False) as anon:
        anon.headers.clear()
        res = anon.post(
            "/api/triage/verdict",
            json={
                "subject_kind": "destination",
                "subject": "x.example",
                "verdict": "INCONCLUSIVE",
            },
        )
    assert res.status_code == 401


# ── additive migration: a pre-existing DB upgrades with no row loss ─────────


def test_migration_is_additive_on_a_preexisting_db(tmp_path, monkeypatch):
    """An existing jaillist DB keeps every row and gains the §7.1 columns.

    The fresh ``PRAGMA table_info(jaillist_entries)`` guard is what makes this
    work — reusing the earlier ``columns`` set (which belongs to ``findings``)
    would silently no-op the ALTERs.
    """
    import asyncio
    import sqlite3

    dbfile = tmp_path / "old.db"
    con = sqlite3.connect(dbfile)
    con.executescript(
        """
        CREATE TABLE jaillist_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            value TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            finding_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (value)
        );
        INSERT INTO jaillist_entries (value, source)
            VALUES ('10.0.0.1/32', 'manual'), ('10.0.0.2/32', 'upstream');
        """
    )
    con.commit()
    con.close()

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{dbfile}")
    monkeypatch.setenv("BLACKLIST_DIR", str(tmp_path / "feeds"))
    from app.config import get_settings

    get_settings.cache_clear()

    from app.database import init_db

    asyncio.run(init_db())

    con = sqlite3.connect(dbfile)
    try:
        assert con.execute("SELECT COUNT(*) FROM jaillist_entries").fetchone()[0] == 2
        cols = {r[1] for r in con.execute("PRAGMA table_info(jaillist_entries)")}
        for col in (
            "reason",
            "url",
            "category",
            "note",
            "verdict_id",
            "evidence_summary",
            "decided_by",
            "decided_at",
        ):
            assert col in cols, col
        ddl = con.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'triage_events'"
        ).fetchone()[0]
        # No UNIQUE on the ledger — repetition is the point (design §7.2).
        assert "UNIQUE" not in ddl.upper()
        indexes = {
            r[0]
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
                " AND tbl_name = 'triage_events'"
            )
        }
        assert {"idx_triage_subject", "idx_triage_verdict"} <= indexes
    finally:
        con.close()
        get_settings.cache_clear()
