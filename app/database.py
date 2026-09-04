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
    # Migration: add Rule Definition metadata (Task 9 — spec §3.3) to existing
    # databases that predate the columns. `name` is the rule's display name,
    # `category` the threat-class tag, `notes` free-text context. All optional
    # (nullable) so pre-existing rows and bare bulk imports keep working.
    cursor = await db.execute("PRAGMA table_info(url_patterns)")
    columns = {row[1] for row in await cursor.fetchall()}
    for col in ("name", "category", "notes"):
        if col not in columns:
            await db.execute(f"ALTER TABLE url_patterns ADD COLUMN {col} TEXT")
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

    # Generic key/value settings store for System Settings (kibana,
    # field-map, alerts). Task 11+ — single TEXT JSON column.
    await db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)

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
