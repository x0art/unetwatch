
from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_db_conn
from app.models import (
    PatternBulkImport,
    UrlPatternCreate,
    UrlPatternResponse,
    UrlPatternUpdate,
)

router = APIRouter(prefix="/api/patterns", tags=["patterns"])


# ── Block/Whitelist patterns CRUD ──────────────────────────────────────────

@router.get("/", response_model=list[UrlPatternResponse])
async def list_patterns(
    db=Depends(get_db_conn),
    pattern_type: str | None = Query(None, pattern="^(block|whitelist)$"),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("id", pattern="^(id|pattern|pattern_type|created_at)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    where = []
    params: list = []
    if pattern_type:
        where.append("pattern_type = ?")
        params.append(pattern_type)
    if search:
        where.append("pattern LIKE ?")
        params.append(f"%{search}%")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    order = f"ORDER BY {sort_by} {sort_order.upper()}"
    cursor = await db.execute(
        f"SELECT * FROM url_patterns {clause} {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.get("/{pattern_id}", response_model=UrlPatternResponse)
async def get_pattern(pattern_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pattern_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Pattern not found")
    return dict(row)


@router.post("/", response_model=UrlPatternResponse, status_code=201)
async def create_pattern(data: UrlPatternCreate, db=Depends(get_db_conn)):
    try:
        cursor = await db.execute(
            "INSERT INTO url_patterns (pattern, pattern_type) VALUES (?, ?)",
            (data.pattern, data.pattern_type),
        )
        await db.commit()
        pid = cursor.lastrowid
        cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pid,))
        return dict(await cursor.fetchone())
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, f"Pattern '{data.pattern}' already exists")
        raise HTTPException(500, str(e))


@router.put("/{pattern_id}", response_model=UrlPatternResponse)
async def update_pattern(pattern_id: int, data: UrlPatternUpdate, db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pattern_id,))
    if not await cursor.fetchone():
        raise HTTPException(404, "Pattern not found")

    updates = {}
    if data.pattern is not None:
        updates["pattern"] = data.pattern
    if data.pattern_type is not None:
        updates["pattern_type"] = data.pattern_type

    if not updates:
        raise HTTPException(400, "No fields to update")

    # Always refresh updated_at; set_clause has zero user-controlled identifiers.
    updates["updated_at"] = "CURRENT_TIMESTAMP"
    set_clause = ", ".join(
        f"{k} = {v}" if k == "updated_at" else f"{k} = ?"
        for k, v in updates.items()
    )
    values = [v for k, v in updates.items() if k != "updated_at"]

    try:
        await db.execute(
            f"UPDATE url_patterns SET {set_clause} WHERE id = ?",
            (*values, pattern_id),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, f"Pattern '{data.pattern}' already exists")
        raise HTTPException(500, str(e))

    cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pattern_id,))
    return dict(await cursor.fetchone())


@router.delete("/{pattern_id}", status_code=204)
async def delete_pattern(pattern_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("DELETE FROM url_patterns WHERE id = ?", (pattern_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Pattern not found")


# ── Bulk import ────────────────────────────────────────────────────────────

@router.post("/bulk", response_model=list[UrlPatternResponse], status_code=201)
async def bulk_import_patterns(data: PatternBulkImport, db=Depends(get_db_conn)):
    results = []
    for p in data.patterns:
        try:
            cursor = await db.execute(
                "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type) VALUES (?, ?)",
                (p, data.pattern_type),
            )
            await db.commit()
            pid = cursor.lastrowid
            if pid:
                cursor = await db.execute("SELECT * FROM url_patterns WHERE id = ?", (pid,))
                results.append(dict(await cursor.fetchone()))
        except Exception:
            continue
    return results


# ── Stats ──────────────────────────────────────────────────────────────────

@router.get("/stats/counts")
async def pattern_counts(db=Depends(get_db_conn)):
    cursor = await db.execute(
        "SELECT pattern_type, COUNT(*) as count FROM url_patterns GROUP BY pattern_type"
    )
    rows = await cursor.fetchall()
    return {r["pattern_type"]: r["count"] for r in rows}
