from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse

from app.database import get_db_conn

router = APIRouter(prefix="/api/blacklist", tags=["blacklist"])


@router.get("/urls", response_class=PlainTextResponse)
async def list_blacklist_urls(db=Depends(get_db_conn)):
    cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'block' ORDER BY pattern"
    )
    rows = await cursor.fetchall()
    body = "\n".join(row[0] for row in rows)
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")


@router.get("/ips", response_class=PlainTextResponse)
async def list_blacklist_ips(
    db=Depends(get_db_conn),
    limit: int = Query(1000, ge=1, le=10000),
    search: str | None = Query(None, max_length=200),
):
    pat_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'block' ORDER BY pattern"
    )
    patterns = [row[0] for row in await pat_cursor.fetchall()]
    if not patterns:
        return PlainTextResponse("", media_type="text/plain; charset=utf-8")

    where = []
    params: list[str] = []
    if search:
        where.append("client_ip LIKE ?")
        params.append(f"%{search}%")

    url_match = " OR ".join(["INSTR(url, ?) > 0 OR INSTR(base_url, ?) > 0"] * len(patterns))
    match_clause = f"({url_match})"
    for pat in patterns:
        params.extend([pat, pat])

    where.append(match_clause)
    clause = f"WHERE {' AND '.join(where)}"

    cursor = await db.execute(
        f"SELECT DISTINCT client_ip FROM findings {clause} ORDER BY client_ip LIMIT ?",
        (*params, limit),
    )
    rows = await cursor.fetchall()
    body = "\n".join(row[0] for row in rows)
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")
