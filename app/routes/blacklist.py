from fastapi import APIRouter, Depends, HTTPException, Path, status
from fastapi.responses import PlainTextResponse

from app.database import get_db_conn
from app.models import BlacklistEntryCreate
from app.services.blacklist import normalize_blacklist_value

router = APIRouter(prefix="/api/blacklist", tags=["blacklist"])


async def _list_values(db, kind: str) -> list[str]:
    cursor = await db.execute(
        "SELECT value FROM blacklist_entries WHERE kind = ? ORDER BY value",
        (kind,),
    )
    return [row[0] for row in await cursor.fetchall()]


@router.get("/urls", response_class=PlainTextResponse)
async def list_blacklist_urls(db=Depends(get_db_conn)):
    body = "\n".join(await _list_values(db, "url"))
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")


@router.get("/ips", response_class=PlainTextResponse)
async def list_blacklist_ips(db=Depends(get_db_conn)):
    body = "\n".join(await _list_values(db, "ip"))
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")


@router.get("/entries")
async def list_blacklist_entries(db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT kind, value FROM blacklist_entries ORDER BY value")
    rows = await cursor.fetchall()
    urls = sorted([row[1] for row in rows if row[0] == "url"])
    ips = sorted([row[1] for row in rows if row[0] == "ip"])
    return {"urls": urls, "ips": ips}


@router.post("/", status_code=status.HTTP_201_CREATED)
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
    return {"added": [value] if cursor.rowcount else []}


@router.delete("/{kind}/{value}", status_code=status.HTTP_204_NO_CONTENT)
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
    return None
