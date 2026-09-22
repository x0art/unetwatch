import sqlite3

import aiosqlite

from app.config import get_settings


def get_db_path() -> str:
    return get_settings().database_url.replace("sqlite:///", "")


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(get_db_path())
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    db = await get_db()
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("""
        CREATE TABLE IF NOT EXISTS url_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL UNIQUE,
            pattern_type TEXT NOT NULL DEFAULT 'block',  -- 'block' or 'whitelist'
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    await db.execute("""
        CREATE TABLE IF NOT EXISTS url_whitelist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Detected log matches persisted per poll/manual run. The UNIQUE constraint
    # (combined with INSERT OR IGNORE) dedupes overlapping poll windows.
    await db.execute("""
        CREATE TABLE IF NOT EXISTS findings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_ip TEXT NOT NULL,
            server_ip TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL,
            base_url TEXT NOT NULL,
            log_timestamp TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (client_ip, url, log_timestamp)
        )
    """)
    # Migration: add server_ip to existing databases that predate the column.
    cursor = await db.execute("PRAGMA table_info(findings)")
    columns = {row[1] for row in await cursor.fetchall()}
    if "server_ip" not in columns:
        await db.execute(
            "ALTER TABLE findings ADD COLUMN server_ip TEXT NOT NULL DEFAULT ''"
        )
    # Migration: add matched_patterns to existing databases that predate the column.
    # JSON array of block patterns that matched at poll time — needed for
    # ranking to attribute persisted hits to policy classes.
    if "matched_patterns" not in columns:
        await db.execute(
            "ALTER TABLE findings ADD COLUMN matched_patterns TEXT NOT NULL DEFAULT '[]'"
        )

    # Backfill: populate matched_patterns for legacy rows that were stored
    # with the default '[]' (before per-row pattern matching existed).
    # Runs every startup, non-destructively — only updates rows where
    # matched_patterns IS NULL / '' / '[]'. Each old URL is matched against
    # the current block patterns via glob_to_regex so historical rows get a
    # real pattern value without losing any row.
    if "matched_patterns" in columns:
        try:
            from app.services.query_builder import glob_to_regex as _gtr

            _bcur = await db.execute("SELECT pattern FROM url_patterns WHERE pattern_type='block'")
            _brows = await _bcur.fetchall()
            _bps: list[str] = [r[0] for r in _brows if r[0]]
            if _bps:
                _tgt_cur = await db.execute(
                    "SELECT id, url FROM findings WHERE matched_patterns IS NULL OR matched_patterns = '' OR matched_patterns = '[]'"
                )
                _targets = await _tgt_cur.fetchall()
                if _targets:
                    import json as _json
                    import re as _re
                    for _row in _targets:
                        _url = _row[1] or ""
                        _hits: list[str] = []
                        for _pat in _bps:
                            _rx = _gtr(_pat)
                            if _rx and _re.search(_rx, _url, _re.IGNORECASE):
                                _hits.append(_pat)
                        if _hits:
                            await db.execute(
                                "UPDATE findings SET matched_patterns = ? WHERE id = ?",
                                (_json.dumps(_hits), _row[0]),
                            )
                        else:
                            # No current block pattern matches — store the best-effort
                            # per-row fallback (first pattern) so the cell is never "—"
                            # and stays debuggable about which rule class stored it.
                            await db.execute(
                                "UPDATE findings SET matched_patterns = ? WHERE id = ?",
                                (_json.dumps([_bps[0]]), _row[0]),
                            )
                    await db.commit()
        except Exception:
            pass  # never block startup on backfill

    # Migration: add user_agent to existing databases that predate the column.
    # Only added in UC-A/UC-B modes (where user_agent field is confirmed present).
    # In COLLAPSED mode, the column is not added.
    from app.services.es_fields import mode_has_extended_findings

    if mode_has_extended_findings() and "user_agent" not in columns:
        await db.execute(
            "ALTER TABLE findings ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''"
        )

    # Migration: action + duration_seconds always persisted (flat logstash-proxy
    # index carries both; COLLAPSED mode previously dropped them, starving
    # analytics). Added unconditionally — a missing column is ALTERed in.
    if "action" not in columns:
        await db.execute(
            "ALTER TABLE findings ADD COLUMN action TEXT NOT NULL DEFAULT ''"
        )
    if "duration_seconds" not in columns:
        await db.execute(
            "ALTER TABLE findings ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0"
        )

    # Migration: intent — derived from action at store time (REACH for ALLOW,
    # ATTEMPT for DENY, "" otherwise). Added unconditionally like action.
    # Legacy rows keep the '' default; no backfill is needed because intent is
    # a pure function of action, which is likewise '' on those same rows.
    if "intent" not in columns:
        await db.execute(
            "ALTER TABLE findings ADD COLUMN intent TEXT NOT NULL DEFAULT ''"
        )

    # Migration: rich flat proxy fields — carry the full logstash-proxy schema
    # into the findings table so Query/Findings/Host/Analytics can surface them.
    rich_findings_columns = [
        "domain",
        "category",
        "http_method",
        "http_status_code",
        "country_code",
        "bytes_downloaded",
        "bytes_uploaded",
        "rule_info",
        "rule_name",
        "user_id",
    ]
    for col in rich_findings_columns:
        if col not in columns:
            await db.execute(
                f"ALTER TABLE findings ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"
            )

    # Indexes for the findings graph + list queries (url/base_url lookups,
    # whitelist SQL filtering).
    await db.execute("CREATE INDEX IF NOT EXISTS idx_findings_url ON findings(url)")
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_findings_base_url ON findings(base_url)"
    )

    # Indexes for the per-client drill-down (client_ip filter + window scans).
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_findings_client_ip ON findings(client_ip)"
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_findings_log_timestamp ON findings(log_timestamp)"
    )

    # Intent-aware drill-down: a client's REACH vs ATTEMPT history in a window.
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_findings_intent "
        "ON findings(client_ip, intent, log_timestamp)"
    )
    await db.execute("""
        CREATE TABLE IF NOT EXISTS blacklist_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('url', 'ip')),
            value TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'finding'
            finding_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (kind, value)
        )
    """)

    # Jaillist: client (source) IPs to be jailed at the enforcement layer
    # (firewall / fail2ban). One flat list — no kinds, single IPs only.
    # `source` is 'manual' | 'finding' | 'upstream'.
    await db.execute("""
        CREATE TABLE IF NOT EXISTS jaillist_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            value TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            finding_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (value)
        )
    """)

    # Migration (§7.1): findability columns on jaillist_entries so a jail
    # entry can explain itself months later (who, why, with what evidence) —
    # the information-based substitute for the expiry policy the owner
    # declined. All nullable or defaulted, so every existing row survives
    # unchanged and UNIQUE(value) is untouched.
    # NOTE: this re-reads PRAGMA table_info for jaillist_entries on purpose.
    # The `columns` variable above belongs to `findings`; reusing it here
    # would guard against the wrong table's column set and silently no-op.
    cursor = await db.execute("PRAGMA table_info(jaillist_entries)")
    _jl_columns = {row[1] for row in await cursor.fetchall()}
    for _col, _type in (
        ("reason", "TEXT NOT NULL DEFAULT ''"),
        ("url", "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT NOT NULL DEFAULT ''"),
        ("note", "TEXT NOT NULL DEFAULT ''"),
        ("verdict_id", "INTEGER"),
        ("evidence_summary", "TEXT NOT NULL DEFAULT '{}'"),
        ("decided_by", "TEXT NOT NULL DEFAULT ''"),
        ("decided_at", "TEXT NOT NULL DEFAULT ''"),
    ):
        if _col not in _jl_columns:
            await db.execute(f"ALTER TABLE jaillist_entries ADD COLUMN {_col} {_type}")

    # The verdict ledger (§7.2): one row per human decision, including the
    # decisions that produce no artifact (NOT_HARMFUL writes a whitelist
    # pattern, INCONCLUSIVE writes nothing at all). Identity is `id` — no
    # UNIQUE constraint, deliberately: a subject legitimately receives many
    # verdicts over its life (jail, un-jail, re-jail), and a correction is a
    # new row with supersedes_id, never an edit. The effective verdict is the
    # row with the greatest decided_at that no other row supersedes.
    await db.execute("""
        CREATE TABLE IF NOT EXISTS triage_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('destination', 'source')),
            subject       TEXT NOT NULL,
            verdict       TEXT NOT NULL CHECK (verdict IN (
                              'HARMFUL_DESTINATION', 'HARMFUL_SOURCE',
                              'NOT_HARMFUL', 'INCONCLUSIVE')),
            rule_ids      TEXT NOT NULL DEFAULT '[]',
            finding_id    INTEGER,
            url           TEXT NOT NULL DEFAULT '',
            category      TEXT NOT NULL DEFAULT '',
            note          TEXT NOT NULL DEFAULT '',
            evidence_summary TEXT NOT NULL DEFAULT '{}',
            decided_by    TEXT NOT NULL,
            decided_at    TEXT NOT NULL,
            decided_tz    TEXT NOT NULL DEFAULT '',
            supersedes_id INTEGER,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # One index serves both the effective-verdict lookup (subject chain,
    # newest first) and the per-subject history scan.
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_triage_subject "
        "ON triage_events(subject_kind, subject, decided_at)"
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_triage_verdict "
        "ON triage_events(verdict, decided_at)"
    )

    # URLs under redirect watch. `source` is 'manual' | 'finding' for user
    # additions and 'auto' for targets discovered while following a chain.
    await db.execute("""
        CREATE TABLE IF NOT EXISTS tracked_urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'finding' | 'auto'
            status TEXT NOT NULL DEFAULT 'unknown', -- 'unknown' | 'ok' | 'redirect' | 'error'
            http_status INTEGER,
            final_url TEXT,
            last_checked_at TIMESTAMP,
            last_error TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Every redirect hop ever observed, with history. `active` marks the
    # currently-live edge; old edges are kept so target changes are visible.
    await db.execute("""
        CREATE TABLE IF NOT EXISTS redirect_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_url TEXT NOT NULL,
            target_url TEXT NOT NULL,
            http_status INTEGER NOT NULL,
            first_seen_at TIMESTAMP NOT NULL,
            last_seen_at TIMESTAMP NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            UNIQUE (source_url, target_url)
        )
    """)

    # Audit trail for ES queries + webhook deliveries. Every poll writes one
    # row recording the exact query DSL, match counts and webhook outcome;
    # ad-hoc Query page runs are stored with kind='query' (no webhook).
    await db.execute("""
        CREATE TABLE IF NOT EXISTS monitor_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL DEFAULT 'poll',       -- 'poll' | 'query'
            started_at TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            minutes INTEGER,
            es_online INTEGER NOT NULL DEFAULT 1,
            matches INTEGER NOT NULL DEFAULT 0,      -- raw ES hits
            filtered INTEGER NOT NULL DEFAULT 0,     -- after whitelist/ALLOW
            stored INTEGER NOT NULL DEFAULT 0,       -- findings persisted (polls)
            es_query TEXT,                           -- JSON DSL sent to ES
            webhook_url TEXT,
            webhook_status INTEGER,
            webhook_error TEXT,
            webhook_reason TEXT,                     -- why the webhook was NOT called
            msteams_status INTEGER,                  -- HTTP status from MS Teams webhook
            msteams_error TEXT,                       -- error from MS Teams webhook
            webhook_payload TEXT,                    -- JSON payload for n8n retry
            msteams_payload TEXT,                    -- JSON payload for MS Teams retry
            top_urls TEXT,                           -- JSON array: top flagged URLs
            matched_patterns TEXT,                   -- JSON array: block patterns that matched
            -- Suppression counters (measured row counts, never estimated).
            -- `suppressed_rows` counts distinct withheld rows; the two
            -- sub-counts overlap on a row that is both DENY and blacklisted.
            suppressed_rows INTEGER NOT NULL DEFAULT 0,
            suppressed_enforced INTEGER NOT NULL DEFAULT 0,
            suppressed_blacklisted INTEGER NOT NULL DEFAULT 0,
            error TEXT
        )
    """)

    # Migration: add webhook_reason / top_urls / matched_patterns to
    # databases that predate the columns (explains why a delivery was
    # skipped, and surfaces what a run actually flagged).
    cursor = await db.execute("PRAGMA table_info(monitor_logs)")
    columns = {row[1] for row in await cursor.fetchall()}
    for col in ("webhook_reason", "top_urls", "matched_patterns"):
        if col not in columns:
            await db.execute(f"ALTER TABLE monitor_logs ADD COLUMN {col} TEXT")

    # Migration: add per-provider webhook status and retry payload columns.
    for col in (
        "msteams_status",
        "msteams_error",
        "webhook_payload",
        "msteams_payload",
    ):
        if col not in columns:
            await db.execute(f"ALTER TABLE monitor_logs ADD COLUMN {col} TEXT")

    # Migration: add suppression counters. Guarded exactly like the blocks
    # above; SQLite accepts a constant default in ADD COLUMN, so the same
    # NOT NULL DEFAULT 0 shape as the CREATE TABLE is used here.
    cursor = await db.execute("PRAGMA table_info(monitor_logs)")
    columns = {row[1] for row in await cursor.fetchall()}
    for col in ("suppressed_rows", "suppressed_enforced", "suppressed_blacklisted"):
        if col not in columns:
            await db.execute(
                f"ALTER TABLE monitor_logs ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0"
            )

    # Migration: normalize blacklist entries to bare FQDN / IPv4 (protocol,
    # port, path and query stripped) so the plain-text feeds stay clean.
    # Idempotent — safe to run on every startup. Rows that cannot be parsed
    # are dropped rather than shipped in a broken feed.
    from app.services.blacklist import normalize_blacklist_value

    cursor = await db.execute("SELECT id, kind, value FROM blacklist_entries")
    for row in await cursor.fetchall():
        try:
            kind, value = normalize_blacklist_value(row["value"])
        except ValueError:
            await db.execute(
                "DELETE FROM blacklist_entries WHERE id = ?", (row["id"],)
            )
            continue
        if kind == row["kind"] and value == row["value"]:
            continue
        try:
            await db.execute(
                "UPDATE blacklist_entries SET kind = ?, value = ? WHERE id = ?",
                (kind, value, row["id"]),
            )
        except sqlite3.IntegrityError:
            # Duplicate of an already-normalized entry — keep the canonical row.
            await db.execute(
                "DELETE FROM blacklist_entries WHERE id = ?", (row["id"],)
            )

    # Migration: rewrite jaillist entries to canonical single-host CIDR
    # (IPv4 ``ip/32``, IPv6 ``ip/128``). Idempotent and startup-safe. Rows
    # that cannot be parsed are dropped; rows that collapse onto an existing
    # canonical value keep the canonical row (source is recomputed from the
    # surviving rows below).
    from app.services.jaillist import normalize_jaillist_value

    cursor = await db.execute("SELECT id, value, source FROM jaillist_entries")
    jaillist_rows = await cursor.fetchall()
    for row in jaillist_rows:
        try:
            canonical = normalize_jaillist_value(row["value"])
        except ValueError:
            await db.execute(
                "DELETE FROM jaillist_entries WHERE id = ?", (row["id"],)
            )
            continue
        if canonical == row["value"]:
            continue
        keep_source = row["source"]
        await db.execute(
            "DELETE FROM jaillist_entries WHERE id = ?", (row["id"],)
        )
        try:
            await db.execute(
                "INSERT INTO jaillist_entries (value, source) VALUES (?, ?)",
                (canonical, keep_source),
            )
        except sqlite3.IntegrityError:
            # A canonical duplicate already exists; promote its source when
            # the surviving row is merely manual but another source claimed it.
            await db.execute(
                """
                UPDATE jaillist_entries
                SET source = CASE
                    WHEN source = 'manual' AND ? != 'manual' THEN ?
                    ELSE source
                END
                WHERE value = ?
                """,
                (keep_source, keep_source, canonical),
            )

    # One-time purge of any demo seed rows left over from a prior version.
    # These are the documentation-only IPs used by the old sample seed
    # (RFC 5737 ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). They
    # never appear in real traffic, so removing them is safe.
    await db.execute(
        "DELETE FROM findings WHERE client_ip IN ("
        "'192.0.2.77', '198.51.100.9', '198.51.100.42',"
        " '203.0.113.10', '203.0.113.210'"
        ") OR server_ip IN ("
        "'10.0.0.4', '10.0.0.5', '10.0.0.6', '10.0.0.7', '10.0.0.8'"
        ")"
    )
    await db.commit()
    await db.close()

    # Keep the monitor_logs audit trail bounded on every startup (handles
    # rows written by earlier versions / long uptimes).
    from app.services.logs import prune_logs

    await prune_logs()


async def seed_defaults():
    """Seed DB with patterns from existing main.py lists."""
    from app.services.seed import seed_patterns

    await seed_patterns()


async def get_db_conn():
    """Dependency injection for FastAPI routes."""
    db = await get_db()
    try:
        yield db
    finally:
        await db.close()
