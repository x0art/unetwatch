"""JSON backup/restore of operator data (no SQL, no credentials).

Excluded by design: ``monitor_logs`` (noise), session tokens, and all
credentials (ADMIN_*, API_KEY, ES creds, webhooks live in ``.env`` and are
restored via ``.env``).

- ``GET /api/backup/export`` → ``application/json`` attachment
  ``unetwatch-backup-YYYYMMDD-HHMMSS.json`` with
  ``{ version, exported_at, patterns, whitelist, findings, blacklist,
  jaillist, tracked_urls, redirect_edges }`` (rows minus ``id``).
- ``POST /api/backup/import`` → restores with ``INSERT OR IGNORE`` on the
  natural UNIQUEs; returns ``{ dry_run, added, skipped }`` per section.
  Unknown ``version`` → 400. Never deletes; ``dry_run`` writes nothing.
  Body capped at ~10 MiB (content-length check on the raw bytes).
"""

import json
import sqlite3
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_db_conn

router = APIRouter(prefix="/api/backup", tags=["backup"])

BACKUP_VERSION = 1
MAX_IMPORT_BYTES = 10 * 1024 * 1024

# Natural UNIQUE key per section, used for dry-run existence checks.
_NATURAL_KEYS: dict[str, tuple[str, ...]] = {
    "patterns": ("pattern",),
    "whitelist": ("pattern",),
    "findings": ("client_ip", "url", "log_timestamp"),
    "blacklist": ("kind", "value"),
    "jaillist": ("value",),
    "tracked_urls": ("url",),
    "redirect_edges": ("source_url", "target_url"),
}

_TABLES: dict[str, str] = {
    "patterns": "url_patterns",
    "whitelist": "url_whitelist",
    "findings": "findings",
    "blacklist": "blacklist_entries",
    "jaillist": "jaillist_entries",
    "tracked_urls": "tracked_urls",
    "redirect_edges": "redirect_edges",
}


async def _table_columns(db, table: str) -> list[str]:
    cursor = await db.execute(f"PRAGMA table_info({table})")
    return [row[1] for row in await cursor.fetchall()]


def _row_without_id(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys() if k != "id"}


@router.get("/export")
async def export_backup(db=Depends(get_db_conn)):
    """Download the full operator-data backup as a JSON attachment."""
    patterns_cur = await db.execute(
        "SELECT pattern, pattern_type FROM url_patterns ORDER BY id"
    )
    whitelist_cur = await db.execute("SELECT pattern FROM url_whitelist ORDER BY id")
    blacklist_cur = await db.execute(
        "SELECT kind, value, source FROM blacklist_entries ORDER BY id"
    )
    jaillist_cur = await db.execute(
        "SELECT value, source FROM jaillist_entries ORDER BY id"
    )
    findings_cur = await db.execute("SELECT * FROM findings ORDER BY id")
    tracked_cur = await db.execute("SELECT * FROM tracked_urls ORDER BY id")
    edges_cur = await db.execute("SELECT * FROM redirect_edges ORDER BY id")

    body = {
        "version": BACKUP_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "patterns": [dict(r) for r in await patterns_cur.fetchall()],
        "whitelist": [dict(r) for r in await whitelist_cur.fetchall()],
        "findings": [_row_without_id(r) for r in await findings_cur.fetchall()],
        "blacklist": [dict(r) for r in await blacklist_cur.fetchall()],
        "jaillist": [dict(r) for r in await jaillist_cur.fetchall()],
        "tracked_urls": [_row_without_id(r) for r in await tracked_cur.fetchall()],
        "redirect_edges": [_row_without_id(r) for r in await edges_cur.fetchall()],
    }
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return JSONResponse(
        content=body,
        media_type="application/json",
        headers={
            "Content-Disposition": (
                f"attachment; filename=unetwatch-backup-{stamp}.json"
            )
        },
    )


def _as_list(payload: dict, key: str) -> list:
    value = payload.get(key, [])
    return value if isinstance(value, list) else []


@router.post("/import")
async def import_backup(request: Request, db=Depends(get_db_conn)):
    """Restore a backup file. ``INSERT OR IGNORE`` on natural UNIQUEs; never deletes."""
    # Reject oversized uploads before buffering the body (Content-Length
    # pre-check); the byte-length check below remains as a backstop.
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "Backup file too large (max ~10 MiB)")
    raw = await request.body()
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "Backup file too large (max ~10 MiB)")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(400, "Invalid JSON backup file")
    if not isinstance(payload, dict):
        raise HTTPException(400, "Invalid backup file shape")
    if payload.get("version") != BACKUP_VERSION:
        raise HTTPException(
            400, f"Unsupported backup version: {payload.get('version')!r}"
        )

    dry_run = payload.get("dry_run") is True
    added: dict[str, int] = {s: 0 for s in _TABLES}
    skipped: dict[str, int] = {s: 0 for s in _TABLES}

    # Cache real table columns once so older backups (missing newer
    # migration columns) still import — unknown keys are dropped.
    columns: dict[str, set[str]] = {}
    for section, table in _TABLES.items():
        columns[section] = set(await _table_columns(db, table))

    async def exists(section: str, row: dict) -> bool:
        table = _TABLES[section]
        keys = _NATURAL_KEYS[section]
        if any(row.get(k) is None for k in keys):
            return True  # missing natural key → cannot insert → counts as skipped
        clause = " AND ".join(f"{k} = ?" for k in keys)
        cursor = await db.execute(
            f"SELECT 1 FROM {table} WHERE {clause}",
            tuple(row.get(k) for k in keys),
        )
        return await cursor.fetchone() is not None

    async def insert(section: str, row: dict) -> bool:
        """INSERT OR IGNORE one normalized row. Returns True when added."""
        table = _TABLES[section]
        cols = [c for c in row if c in columns[section] and c != "id"]
        if not cols:
            return False
        try:
            cursor = await db.execute(
                f"INSERT OR IGNORE INTO {table} ({', '.join(cols)})"
                f" VALUES ({', '.join('?' * len(cols))})",
                tuple(row[c] for c in cols),
            )
            return cursor.rowcount == 1
        except sqlite3.IntegrityError:
            # CHECK-constraint violation (e.g. bad blacklist kind) → skip.
            return False

    # ── url_patterns / url_whitelist (fixed shapes) ──
    for item in _as_list(payload, "patterns"):
        if not isinstance(item, dict) or not item.get("pattern"):
            skipped["patterns"] += 1
            continue
        row = {
            "pattern": item["pattern"],
            "pattern_type": item.get("pattern_type") or "block",
        }
        if dry_run:
            if await exists("patterns", row):
                skipped["patterns"] += 1
            else:
                added["patterns"] += 1
        elif await insert("patterns", row):
            added["patterns"] += 1
        else:
            skipped["patterns"] += 1

    for item in _as_list(payload, "whitelist"):
        if not isinstance(item, dict) or not item.get("pattern"):
            skipped["whitelist"] += 1
            continue
        row = {"pattern": item["pattern"]}
        if dry_run:
            if await exists("whitelist", row):
                skipped["whitelist"] += 1
            else:
                added["whitelist"] += 1
        elif await insert("whitelist", row):
            added["whitelist"] += 1
        else:
            skipped["whitelist"] += 1

    # ── blacklist_entries (fixed shape, source defaults to manual) ──
    allowed_sources = {"manual", "finding", "upstream", "redirect", "auto"}
    for item in _as_list(payload, "blacklist"):
        if not isinstance(item, dict) or not item.get("kind") or not item.get("value"):
            skipped["blacklist"] += 1
            continue
        source = item.get("source") or "manual"
        if source not in allowed_sources:
            # Unknown provenance (crafted file) → manual, never 'upstream'.
            source = "manual"
        row = {
            "kind": item["kind"],
            "value": item["value"],
            "source": source,
        }
        if dry_run:
            if await exists("blacklist", row):
                skipped["blacklist"] += 1
            else:
                added["blacklist"] += 1
        elif await insert("blacklist", row):
            added["blacklist"] += 1
        else:
            skipped["blacklist"] += 1

    # ── jaillist_entries (fixed shape, source defaults to manual) ──
    jaillist_sources = {"manual", "finding", "upstream"}
    for item in _as_list(payload, "jaillist"):
        if not isinstance(item, dict) or not item.get("value"):
            skipped["jaillist"] += 1
            continue
        source = item.get("source") or "manual"
        if source not in jaillist_sources:
            # Unknown provenance (crafted file) → manual, never 'upstream'.
            source = "manual"
        row = {
            "value": item["value"],
            "source": source,
        }
        if dry_run:
            if await exists("jaillist", row):
                skipped["jaillist"] += 1
            else:
                added["jaillist"] += 1
        elif await insert("jaillist", row):
            added["jaillist"] += 1
        else:
            skipped["jaillist"] += 1

    # ── findings / tracked_urls / redirect_edges (dynamic row shapes) ──
    for section in ("findings", "tracked_urls", "redirect_edges"):
        for item in _as_list(payload, section):
            if not isinstance(item, dict):
                skipped[section] += 1
                continue
            row = {k: v for k, v in item.items() if k != "id"}
            if dry_run:
                if await exists(section, row):
                    skipped[section] += 1
                else:
                    added[section] += 1
            elif await insert(section, row):
                added[section] += 1
            else:
                skipped[section] += 1

    if not dry_run:
        await db.commit()
    return {"dry_run": dry_run, "added": added, "skipped": skipped}
