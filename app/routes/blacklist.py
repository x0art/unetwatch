from fastapi import APIRouter, Depends, HTTPException, Path, status
from fastapi.responses import FileResponse

from app.config import verify_admin
from app.database import get_db_conn
from app.models import BlacklistBulkAdd, BlacklistBulkDelete, BlacklistEntryCreate
from app.services.blacklist import normalize_blacklist_value
from app.services.feeds import _feed_path, sync_regenerate

# Router is mounted WITHOUT verify_admin so the public plain-text feeds
# (/urls.txt, /ips.txt) can be fetched by external integrations (nginx,
# fail2ban, firewall scripts). Write routes opt back in per-route below.
router = APIRouter(prefix="/api/blacklist", tags=["blacklist"])


async def _list_values(db, kind: str) -> list[str]:
    cursor = await db.execute(
        "SELECT value FROM blacklist_entries WHERE kind = ? ORDER BY value",
        (kind,),
    )
    return [row[0] for row in await cursor.fetchall()]


@router.get("/urls.txt")
async def list_blacklist_urls():
    """Serve the on-disk URL feed as a real file (public).

    ``no-store``: the admin UI reloads the feeds after every add/delete, and
    downstream integrations (nginx, fail2ban) depend on the current list.
    FileResponse's ETag/Last-Modified would otherwise make browsers apply
    heuristic caching and serve a stale feed (missing the newest entries).
    """
    return FileResponse(
        _feed_path("url"), media_type="text/plain", headers={"Cache-Control": "no-store"}
    )


@router.get("/ips.txt")
async def list_blacklist_ips():
    """Serve the on-disk IP feed as a real file (public).

    Same ``no-store`` rationale as the URL feed — see list_blacklist_urls.
    """
    return FileResponse(
        _feed_path("ip"), media_type="text/plain", headers={"Cache-Control": "no-store"}
    )


@router.get("/entries", dependencies=[Depends(verify_admin)])
async def list_blacklist_entries(db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT kind, value FROM blacklist_entries ORDER BY value")
    rows = await cursor.fetchall()
    urls = sorted([row[1] for row in rows if row[0] == "url"])
    ips = sorted([row[1] for row in rows if row[0] == "ip"])
    return {"urls": urls, "ips": ips}


@router.post("/", status_code=status.HTTP_201_CREATED, dependencies=[Depends(verify_admin)])
async def add_blacklist_entry(payload: BlacklistEntryCreate, db=Depends(get_db_conn)):
    try:
        kind, value = normalize_blacklist_value(payload.value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cursor = await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value, source, finding_id)"
        " VALUES (?, ?, ?, ?)",
        (kind, value, payload.source, payload.finding_id),
    )
    await db.commit()
    if cursor.rowcount:
        # Regenerate the feed so the public .txt files match the DB.
        await sync_regenerate(db, (kind,))
    return {"added": [value] if cursor.rowcount else []}


@router.post(
    "/bulk",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def bulk_add_blacklist(payload: BlacklistBulkAdd, db=Depends(get_db_conn)):
    """Add many entries at once. Each raw value is normalized like a single
    add; duplicates (within the batch or already in the DB) are skipped.
    Returns the added/skipped values and any that failed to normalize."""
    added: list[str] = []
    skipped: list[str] = []
    errors: list[dict] = []
    touched: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for raw in payload.values:
        v = raw.strip()
        if not v:
            continue
        try:
            kind, value = normalize_blacklist_value(v)
        except ValueError as e:
            errors.append({"value": v, "error": str(e)})
            continue
        key = (kind, value)
        if key in seen:
            # Duplicate within this batch — report it rather than dropping it.
            skipped.append(value)
            continue
        seen.add(key)
        cursor = await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
            " VALUES (?, ?, 'manual')",
            (kind, value),
        )
        if cursor.rowcount:
            added.append(value)
            touched.add(kind)
        else:
            skipped.append(value)
    await db.commit()
    if touched:
        # Regenerate the affected feeds so the public .txt files match.
        await sync_regenerate(db, tuple(sorted(touched)))
    return {"added": added, "skipped": skipped, "errors": errors}


@router.post(
    "/bulk-delete",
    dependencies=[Depends(verify_admin)],
)
async def bulk_delete_blacklist(payload: BlacklistBulkDelete, db=Depends(get_db_conn)):
    """Delete many entries by kind+value at once. Returns how many rows were
    actually removed (entries not present are silently skipped)."""
    if not payload.entries:
        return {"deleted": 0}
    deleted = 0
    touched: set[str] = set()
    for ref in payload.entries:
        cursor = await db.execute(
            "DELETE FROM blacklist_entries WHERE kind = ? AND value = ?",
            (ref.kind, ref.value),
        )
        deleted += cursor.rowcount
        if cursor.rowcount:
            touched.add(ref.kind)
    await db.commit()
    if touched:
        # Regenerate the affected feeds so the public .txt files match.
        await sync_regenerate(db, tuple(sorted(touched)))
    return {"deleted": deleted}


@router.delete(
    "/{kind}/{value}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_blacklist_entry(
    kind: str = Path(pattern="^(url|ip)$"),
    value: str = Path(min_length=1, max_length=500),
    db=Depends(get_db_conn),
):
    cursor = await db.execute(
        "DELETE FROM blacklist_entries WHERE kind = ? AND value = ?",
        (kind, value),
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Blacklist entry not found")
    # Regenerate the feed so the public .txt files match the DB.
    await sync_regenerate(db, (kind,))
    return None
