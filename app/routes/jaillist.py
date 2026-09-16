from fastapi import APIRouter, Depends, HTTPException, Path, status
from fastapi.responses import FileResponse

from app.config import verify_admin
from app.database import get_db_conn
from app.models import JaillistBulkAdd, JaillistBulkDelete, JaillistEntryCreate
from app.services.feeds import jail_feed_path, sync_regenerate_jail
from app.services.jaillist import normalize_jaillist_value

# Router is mounted WITHOUT verify_admin so the public plain-text feed
# (/api/jaillist/ips.txt, file jail-ips.txt) can be fetched by external
# integrations (firewall, fail2ban).
# Write/list routes opt back in per-route below.
router = APIRouter(prefix="/api/jaillist", tags=["jaillist"])


@router.get("/ips.txt")
async def list_jaillist_ips():
    """Serve the on-disk jail feed as a real file (public).

    ``no-store``: downstream integrations (firewall, fail2ban) depend on the
    current list, and FileResponse's ETag/Last-Modified would otherwise make
    browsers apply heuristic caching and serve a stale feed.
    """
    return FileResponse(
        jail_feed_path(), media_type="text/plain", headers={"Cache-Control": "no-store"}
    )


@router.get("/entries", dependencies=[Depends(verify_admin)])
async def list_jaillist_entries(db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT value FROM jaillist_entries ORDER BY value")
    rows = await cursor.fetchall()
    return {"ips": [row[0] for row in rows]}


@router.post("/", status_code=status.HTTP_201_CREATED, dependencies=[Depends(verify_admin)])
async def add_jaillist_entry(payload: JaillistEntryCreate, db=Depends(get_db_conn)):
    try:
        value = normalize_jaillist_value(payload.value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cursor = await db.execute(
        "INSERT OR IGNORE INTO jaillist_entries (value, source, finding_id)"
        " VALUES (?, ?, ?)",
        (value, payload.source, payload.finding_id),
    )
    await db.commit()
    if cursor.rowcount:
        # Regenerate the feed so the public .txt file matches the DB.
        await sync_regenerate_jail(db)
    return {"added": [value] if cursor.rowcount else []}


@router.post(
    "/bulk",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def bulk_add_jaillist(payload: JaillistBulkAdd, db=Depends(get_db_conn)):
    """Add many entries at once. Each raw value is normalized like a single
    add; duplicates (within the batch or already in the DB) are skipped.
    Returns the added/skipped values and any that failed to normalize."""
    added: list[str] = []
    skipped: list[str] = []
    errors: list[dict] = []
    touched = False
    seen: set[str] = set()
    for raw in payload.values:
        v = raw.strip()
        if not v:
            continue
        try:
            value = normalize_jaillist_value(v)
        except ValueError as e:
            errors.append({"value": v, "error": str(e)})
            continue
        if value in seen:
            # Duplicate within this batch — report it rather than dropping it.
            skipped.append(value)
            continue
        seen.add(value)
        cursor = await db.execute(
            "INSERT OR IGNORE INTO jaillist_entries (value, source)"
            " VALUES (?, 'manual')",
            (value,),
        )
        if cursor.rowcount:
            added.append(value)
            touched = True
        else:
            skipped.append(value)
    await db.commit()
    if touched:
        # Regenerate the feed so the public .txt file matches the DB.
        await sync_regenerate_jail(db)
    return {"added": added, "skipped": skipped, "errors": errors}


@router.post(
    "/bulk-delete",
    dependencies=[Depends(verify_admin)],
)
async def bulk_delete_jaillist(payload: JaillistBulkDelete, db=Depends(get_db_conn)):
    """Delete many entries by value (flat list — no kind). Returns how many
    rows were actually removed (entries not present are silently skipped)."""
    if not payload.values:
        return {"deleted": 0}
    deleted = 0
    touched = False
    for raw in payload.values:
        v = raw.strip()
        if not v:
            continue
        # Normalize like an insert so a stored `ip/32` is matched when the
        # caller passes a bare `ip`. Also match the passed-in value as-is so
        # pre-/32 legacy rows (still bare) stay deletable.
        try:
            lookup = normalize_jaillist_value(v)
        except ValueError:
            lookup = v
        candidates = (lookup, v) if lookup != v else (lookup,)
        placeholders = ",".join("?" for _ in candidates)
        cursor = await db.execute(
            "DELETE FROM jaillist_entries WHERE value IN"
            f" ({placeholders})",
            candidates,
        )
        deleted += cursor.rowcount
        if cursor.rowcount:
            touched = True
    if touched:
        # Regenerate the feed so the public .txt file matches the DB.
        await sync_regenerate_jail(db)
    return {"deleted": deleted}


@router.post("/upstream-sync", dependencies=[Depends(verify_admin)])
async def upstream_sync():
    """Run an upstream jaillist sync now; returns the sync stats."""
    from app.services.upstream_jaillist import sync_upstream_jaillist

    return await sync_upstream_jaillist()


@router.get("/upstream-status", dependencies=[Depends(verify_admin)])
async def upstream_status():
    """Current upstream jaillist status."""
    from app.services.upstream_jaillist import get_upstream_status

    return await get_upstream_status()


@router.delete(
    "/{value}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_jaillist_entry(
    value: str = Path(min_length=1, max_length=500),
    db=Depends(get_db_conn),
):
    # Normalize like an insert so a stored `ip/32` is matched when the caller
    # passes a bare `ip`. Also match the passed-in value as-is so pre-/32
    # legacy rows (still bare) stay deletable.
    try:
        lookup = normalize_jaillist_value(value)
    except ValueError:
        lookup = value
    candidates = (lookup, value) if lookup != value else (lookup,)
    placeholders = ",".join("?" for _ in candidates)
    cursor = await db.execute(
        "DELETE FROM jaillist_entries WHERE value IN"
        f" ({placeholders})",
        candidates,
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Jaillist entry not found")
    # Regenerate the feed so the public .txt file matches the DB.
    await sync_regenerate_jail(db)
    return None
