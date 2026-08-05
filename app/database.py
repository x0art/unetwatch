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
