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
            error TEXT
        )
    """)

    # Migration: add webhook_reason to databases that predate the column
    # (explains why a delivery was skipped: no URL configured, nothing to
    # send after filtering, etc.).
    cursor = await db.execute("PRAGMA table_info(monitor_logs)")
    columns = {row[1] for row in await cursor.fetchall()}
    if "webhook_reason" not in columns:
        await db.execute(
            "ALTER TABLE monitor_logs ADD COLUMN webhook_reason TEXT"
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
