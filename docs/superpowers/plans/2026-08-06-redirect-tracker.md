# URL Redirect Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track URLs for redirects — auto-discover redirect chains, detect when targets change over time, and visualize URL relations as a layered flow graph, with a new Redirects page and a "Track" action on Findings.

**Architecture:** Two new SQLite tables (`tracked_urls`, `redirect_edges`) + a hop-by-hop HTTP checker (`app/services/redirects.py`) run by a second APScheduler job and an on-demand "Check now" endpoint. New `/api/redirects` router. React page `RedirectsPage.tsx` with a table, summary chips, layered SVG graph (Traffic Graph style), and per-URL history dialog; Findings page gains a Track button.

**Tech Stack:** FastAPI, aiosqlite, aiohttp (existing dep), React 19 + Tailwind v4 + lucide-react + Radix (existing).

## Global Constraints

- Python ≥ 3.12, `aiohttp` only HTTP client (no new deps), ruff line-length 100.
- No new npm deps. Reuse `Button`, `Badge`, `Input`, `Dialog`, `ConfirmDialog`, `EmptyState`, `Select`, `Skeleton`, `Pagination`, `StatCard`, `useToast`, `cn`, `useDebounce`.
- All `/api/redirects` routes mounted with `verify_admin` (like other routers).
- Follow existing route style: regex-validated `sort_by`/`sort_order` interpolated into ORDER BY only after validation.
- `source` values: `manual` | `finding` (user input), `auto` (discovered targets).
- Validation gates: `pytest`, `cd admin-ui && npx tsc --noEmit`, `npm run build`, `npm run lint`, code review.

---

### Task 1: DB tables + settings

**Files:**
- Modify: `app/config.py`
- Modify: `app/database.py`

- [ ] **Step 1: Add settings to `app/config.py`** (after `es_query_size`)

```python
    redirect_check_interval_minutes: int = 60
    redirect_timeout_seconds: int = 10
    redirect_max_hops: int = 10
```

- [ ] **Step 2: Add tables to `init_db()` in `app/database.py`** (after `blacklist_entries` block)

```python
    await db.execute(
        """
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
        """
    )
    await db.execute(
        """
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
        """
    )
```

- [ ] **Step 3: Verify** — `python -c "from app.database import init_db; import asyncio; asyncio.run(init_db())"` exits 0.
- [ ] **Step 4: Commit** — `git add app/config.py app/database.py && git commit -m "feat(redirects): tracked_urls and redirect_edges tables + settings"`

---

### Task 2: Redirect checker service

**Files:**
- Create: `app/services/redirects.py`
- Test: `tests/test_redirects.py` (checker-focused tests)

**Interfaces:**
- Consumes: settings (`redirect_max_hops`, `redirect_timeout_seconds`); tables from Task 1.
- Produces: `is_valid_url(value) -> bool`; `check_url(session, url) -> tuple[list[tuple[str,str,int]], int, str, str | None]` returning `(hops, final_status, final_url, error)`; `check_all(url: str | None = None) -> dict`.

- [ ] **Step 1: Write failing tests**

```python
"""Unit tests for the redirect checker service (no HTTP)."""
import asyncio

from app.database import init_db
from app.main import app
from fastapi.testclient import TestClient


def test_is_valid_url():
    from app.services.redirects import is_valid_url

    assert is_valid_url("http://example.com/a")
    assert is_valid_url("https://example.com")
    assert not is_valid_url("example.com/a")
    assert not is_valid_url("http://exa mple.com/x")
    assert not is_valid_url("ftp://example.com/a")


async def test_check_url_follows_chain_and_detects_change(client, monkeypatch):
    from app.services import redirects as svc

    # Track one URL via the API
    r = client.post("/api/redirects/", json={"url": "http://a.example/1"})
    assert r.status_code == 201
    tracked_id = r.json()["id"]

    calls = {"n": 0}

    async def fake_check(session, url):
        calls["n"] += 1
        if calls["n"] == 1:
            return ([("http://a.example/1", "http://b.example/2", 301)], 301, "http://b.example/2", None)
        # Later check: a.example/1 now points at c.example/3
        return ([("http://a.example/1", "http://c.example/3", 301)], 301, "http://c.example/3", None)

    monkeypatch.setattr(svc, "check_url", fake_check)

    first = client.post("/api/redirects/check")
    assert first.status_code == 200
    assert first.json()["checked"] == 1

    # Target auto-added to tracked list
    listed = client.get("/api/redirects/").json()["items"]
    urls = {i["url"] for i in listed}
    assert "http://b.example/2" in urls

    # Edge recorded as active
    second = client.post("/api/redirects/check")
    assert second.json()["updated"][0]["status"] == "redirect"

    from app.database import get_db

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT target_url, active FROM redirect_edges WHERE source_url = ? ORDER BY target_url",
            ("http://a.example/1",),
        )
        edges = await cur.fetchall()
    finally:
        await db.close()

    assert {e["target_url"]: e["active"] for e in edges} == {
        "http://b.example/2": 0,
        "http://c.example/3": 1,
    }


async def test_check_all_ok_status(client, monkeypatch):
    from app.services import redirects as svc

    client.post("/api/redirects/", json={"url": "http://ok.example/x"})

    async def fake_check(session, url):
        return [], 200, url, None

    monkeypatch.setattr(svc, "check_url", fake_check)

    resp = client.post("/api/redirects/check")
    assert resp.status_code == 200
    assert resp.json()["updated"][0]["status"] == "ok"

    item = client.get("/api/redirects/").json()["items"][0]
    assert item["status"] == "ok"
    assert item["http_status"] == 200
    assert item["last_checked_at"] is not None
```

- [ ] **Step 2: Run tests, expect FAIL** — `pytest tests/test_redirects.py -v` (module missing).
- [ ] **Step 3: Implement `app/services/redirects.py`**

```python
"""Redirect tracking service: hop-by-hop HTTP checks of tracked URLs.

Follows redirect chains manually (aiohttp with ``allow_redirects=False``),
records every hop as a ``redirect_edges`` row, auto-adds hop targets to
``tracked_urls`` so whole chains are monitored transitively, and marks
edges the source no longer points at as inactive (history is kept).
"""
from datetime import UTC, datetime
from urllib.parse import urljoin

import aiohttp

from app.config import get_settings


def is_valid_url(value: str) -> bool:
    """A tracked URL must be absolute http(s) with no whitespace."""
    v = value.strip()
    return v.startswith(("http://", "https://")) and " " not in v


async def _request_once(session: aiohttp.ClientSession, method: str, url: str, timeout: float):
    """Single request with redirects disabled; returns (status, Location)."""
    async with session.request(
        method,
        url,
        allow_redirects=False,
        timeout=timeout,
        headers={"User-Agent": "elk-monitor/0.1"},
    ) as resp:
        return resp.status, resp.headers.get("Location")


async def check_url(session: aiohttp.ClientSession, url: str):
    """Follow redirects hop-by-hop for one URL.

    Returns ``(hops, final_status, final_url, error)`` where ``hops`` is a
    list of ``(source_url, target_url, http_status)`` tuples. HEAD first,
    GET fallback when the server rejects HEAD (405/501).
    """
    settings = get_settings()
    max_hops = settings.redirect_max_hops
    timeout = settings.redirect_timeout_seconds

    hops: list[tuple[str, str, int]] = []
    current = url
    seen: set[str] = set()

    for _ in range(max_hops):
        if current in seen:
            return hops, 0, current, "redirect loop detected"
        seen.add(current)

        try:
            status, location = await _request_once(session, "HEAD", current, timeout)
        except Exception as e:
            return hops, 0, current, f"request failed: {e}"

        if status in (405, 501):
            # Server doesn't support HEAD; retry once with GET.
            try:
                status, location = await _request_once(session, "GET", current, timeout)
            except Exception as e:
                return hops, 0, current, f"request failed: {e}"

        if status in (301, 302, 303, 307, 308) and location:
            target = urljoin(current, location)
            if not target.startswith(("http://", "https://")):
                return hops, status, current, "invalid redirect location"
            hops.append((current, target, status))
            current = target
            continue

        return hops, status, current, None

    return hops, 0, current, "max hops exceeded"


def _classify_status(hops: list, final_status: int, error: str | None) -> str:
    if error:
        return "error"
    if hops:
        return "redirect"
    if final_status and 200 <= final_status < 400:
        return "ok"
    return "error"


async def _check_one(db, session: aiohttp.ClientSession, row) -> dict | None:
    """Check a single tracked row, persist edges + auto-added targets."""
    url = row["url"]
    hops, final_status, final_url, error = await check_url(session, url)
    status = _classify_status(hops, final_status, error)
    now = datetime.now(UTC).isoformat()

    await db.execute(
        "UPDATE tracked_urls SET status = ?, http_status = ?, final_url = ?,"
        " last_checked_at = ?, last_error = ? WHERE id = ?",
        (status, final_status or None, final_url, now, error, row["id"]),
    )

    for source, target, hstatus in hops:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, ?, ?, ?, 1)"
            " ON CONFLICT (source_url, target_url) DO UPDATE SET"
            " last_seen_at = excluded.last_seen_at,"
            " http_status = excluded.http_status, active = 1",
            (source, target, hstatus, now, now),
        )
        await db.execute(
            "INSERT OR IGNORE INTO tracked_urls (url, source) VALUES (?, 'auto')",
            (target,),
        )

    if hops:
        current_targets = [t for _, t, _ in hops]
        placeholders = ", ".join("?" * len(current_targets))
        await db.execute(
            f"UPDATE redirect_edges SET active = 0"
            f" WHERE source_url = ? AND active = 1"
            f" AND target_url NOT IN ({placeholders})",
            (url, *current_targets),
        )
    else:
        await db.execute(
            "UPDATE redirect_edges SET active = 0 WHERE source_url = ? AND active = 1",
            (url,),
        )

    await db.commit()
    return {
        "url": url,
        "status": status,
        "http_status": final_status,
        "final_url": final_url,
        "error": error,
    }


async def check_all(url: str | None = None) -> dict:
    """Re-check every tracked URL (or one). Used by the scheduler + /check."""
    from app.database import get_db

    db = await get_db()
    try:
        if url:
            cursor = await db.execute("SELECT * FROM tracked_urls WHERE url = ?", (url,))
        else:
            cursor = await db.execute("SELECT * FROM tracked_urls")
        rows = await cursor.fetchall()

        updated: list[dict] = []
        async with aiohttp.ClientSession() as session:
            for row in rows:
                result = await _check_one(db, session, row)
                if result:
                    updated.append(result)
        return {"checked": len(rows), "updated": updated}
    finally:
        await db.close()
```

- [ ] **Step 4: Run tests, expect PASS** — `pytest tests/test_redirects.py -v`.
- [ ] **Step 5: Commit** — `git add app/services/redirects.py tests/test_redirects.py && git commit -m "feat(redirects): hop-by-hop checker service"`

---

### Task 3: Redirects API router

**Files:**
- Modify: `app/models.py`
- Create: `app/routes/redirects.py`
- Modify: `app/main.py`
- Test: `tests/test_redirects.py` (CRUD/graph/history/auth tests)

**Interfaces:**
- Consumes: `is_valid_url`, `check_all` from Task 2; tables from Task 1.
- Produces: router `redirects` with prefix `/api/redirects` (mounted in `app/main.py`).

- [ ] **Step 1: Add Pydantic models to `app/models.py`**

```python
class RedirectTrackCreate(BaseModel):
    url: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="manual", pattern="^(manual|finding)$")


class RedirectCheckRequest(BaseModel):
    url: str | None = Field(None, max_length=500)
```

- [ ] **Step 2: Write failing tests** (append to `tests/test_redirects.py`)

```python
def test_redirects_add_invalid_url(client):
    resp = client.post("/api/redirects/", json={"url": "example.com/a"})
    assert resp.status_code in (400, 422)
    resp2 = client.post("/api/redirects/", json={"url": "http://exa mple.com/x"})
    assert resp2.status_code in (400, 422)


def test_redirects_add_duplicate(client):
    first = client.post("/api/redirects/", json={"url": "http://dup.example/x"})
    assert first.status_code == 201
    second = client.post("/api/redirects/", json={"url": "http://dup.example/x"})
    assert second.status_code == 409


def test_redirects_list_empty(client):
    resp = client.get("/api/redirects/")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0}


def test_redirects_list_search(client):
    client.post("/api/redirects/", json={"url": "http://alpha.example/a"})
    client.post("/api/redirects/", json={"url": "http://beta.example/b"})
    hit = client.get("/api/redirects/?search=alpha").json()
    assert hit["total"] == 1 and hit["items"][0]["url"] == "http://alpha.example/a"
    miss = client.get("/api/redirects/?search=nope").json()
    assert miss["total"] == 0


def test_redirects_delete_keeps_edges(client, db_path):
    from app.database import get_db

    resp = client.post("/api/redirects/", json={"url": "http://gone.example/x"})
    tracked_id = resp.json()["id"]

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 301, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 1)",
            ("http://gone.example/x", "http://target.example/y"),
        )
        await db.commit()
    finally:
        await db.close()

    deleted = client.delete(f"/api/redirects/{tracked_id}")
    assert deleted.status_code == 204
    assert client.get("/api/redirects/").json()["total"] == 0

    db = await get_db()
    try:
        cur = await db.execute("SELECT COUNT(*) AS n FROM redirect_edges")
        assert (await cur.fetchone())["n"] == 1
    finally:
        await db.close()


def test_redirects_graph_shape(client, db_path):
    client.post("/api/redirects/", json={"url": "http://g1.example/a"})
    client.post("/api/redirects/", json={"url": "http://g2.example/b"})

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 301, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 1)",
            ("http://g1.example/a", "http://g2.example/b"),
        )
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 302, '2026-08-05T00:00:00', '2026-08-05T00:00:00', 0)",
            ("http://g1.example/a", "http://old.example/x"),
        )
        await db.commit()
    finally:
        await db.close()

    resp = client.get("/api/redirects/graph")
    assert resp.status_code == 200
    data = resp.json()
    assert {n["id"] for n in data["nodes"]} == {"http://g1.example/a", "http://g2.example/b"}
    assert len(data["links"]) == 2
    active = [l for l in data["links"] if l["active"]]
    assert active == [{"source": "http://g1.example/a", "target": "http://g2.example/b", "http_status": 301, "active": True}]


def test_redirects_history(client, db_path):
    resp = client.post("/api/redirects/", json={"url": "http://h1.example/a"})
    tracked_id = resp.json()["id"]

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 301, '2026-08-05T00:00:00', '2026-08-05T00:00:00', 0)",
            ("http://h1.example/a", "http://old.example/x"),
        )
        await db.execute(
            "INSERT INTO redirect_edges"
            " (source_url, target_url, http_status, first_seen_at, last_seen_at, active)"
            " VALUES (?, ?, 302, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 1)",
            ("http://h1.example/a", "http://new.example/y"),
        )
        await db.commit()
    finally:
        await db.close()

    data = client.get(f"/api/redirects/{tracked_id}/history").json()
    assert data["url"] == "http://h1.example/a"
    active = [e for e in data["edges"] if e["active"]]
    assert len(active) == 1 and active[0]["target_url"] == "http://new.example/y"


def test_redirects_requires_auth(db_path):
    import asyncio

    from fastapi.testclient import TestClient

    asyncio.run(init_db())
    with TestClient(app, raise_server_exceptions=False) as c:
        c.headers.clear()
        assert c.get("/api/redirects/").status_code == 401
        assert c.post("/api/redirects/", json={"url": "http://x.example/y"}).status_code == 401
```

- [ ] **Step 3: Run tests, expect FAIL** — `pytest tests/test_redirects.py -v`.
- [ ] **Step 4: Implement `app/routes/redirects.py`**

```python
from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_db_conn
from app.models import RedirectCheckRequest, RedirectTrackCreate
from app.services.redirects import check_all, is_valid_url

router = APIRouter(prefix="/api/redirects", tags=["redirects"])

_HISTORY_COUNT_SQL = (
    "(SELECT COUNT(*) FROM redirect_edges e WHERE e.source_url = t.url) AS history_count"
)


@router.get("/")
async def list_tracked_urls(
    db=Depends(get_db_conn),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("id", pattern="^(id|url|source|status|last_checked_at)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    where = []
    params: list = []
    if search:
        where.append("t.url LIKE ?")
        params.append(f"%{search}%")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    count_cursor = await db.execute(
        f"SELECT COUNT(*) AS total FROM tracked_urls t {clause}", params
    )
    total = (await count_cursor.fetchone())["total"]

    cursor = await db.execute(
        f"SELECT t.*, {_HISTORY_COUNT_SQL} FROM tracked_urls t {clause}"
        f" ORDER BY t.{sort_by} {sort_order.upper()} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return {"items": [dict(r) for r in rows], "total": total}


@router.post("/", status_code=201)
async def add_tracked_url(payload: RedirectTrackCreate, db=Depends(get_db_conn)):
    url = payload.url.strip()
    if not is_valid_url(url):
        raise HTTPException(400, "url must start with http:// or https:// and contain no spaces")
    try:
        cursor = await db.execute(
            "INSERT INTO tracked_urls (url, source) VALUES (?, ?)",
            (url, payload.source),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE" in str(e):
            raise HTTPException(409, f"URL already tracked: {url}")
        raise HTTPException(500, str(e))
    pid = cursor.lastrowid
    cursor = await db.execute(
        f"SELECT t.*, {_HISTORY_COUNT_SQL} FROM tracked_urls t WHERE t.id = ?",
        (pid,),
    )
    return dict(await cursor.fetchone())


@router.delete("/{tracked_id}", status_code=204)
async def delete_tracked_url(tracked_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("DELETE FROM tracked_urls WHERE id = ?", (tracked_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Tracked URL not found")
    return None


@router.post("/check")
async def run_redirect_check(
    payload: RedirectCheckRequest | None = None,
    db=Depends(get_db_conn),
):
    url = payload.url.strip() if payload and payload.url else None
    if url is not None:
        cursor = await db.execute("SELECT id FROM tracked_urls WHERE url = ?", (url,))
        if not await cursor.fetchone():
            raise HTTPException(404, "URL is not being tracked")
    return await check_all(url)


@router.get("/graph")
async def redirect_graph(db=Depends(get_db_conn)):
    cursor = await db.execute(
        f"SELECT t.*, {_HISTORY_COUNT_SQL} FROM tracked_urls t"
    )
    rows = await cursor.fetchall()
    nodes = [
        {
            "id": r["url"],
            "label": r["url"],
            "status": r["status"],
            "final_url": r["final_url"],
            "history_count": r["history_count"],
        }
        for r in rows
    ]
    edge_cursor = await db.execute(
        "SELECT source_url, target_url, http_status, active FROM redirect_edges"
    )
    links = [
        {
            "source": e["source_url"],
            "target": e["target_url"],
            "http_status": e["http_status"],
            "active": bool(e["active"]),
        }
        for e in await edge_cursor.fetchall()
    ]
    return {"nodes": nodes, "links": links}


@router.get("/{tracked_id}/history")
async def url_history(tracked_id: int, db=Depends(get_db_conn)):
    cursor = await db.execute("SELECT * FROM tracked_urls WHERE id = ?", (tracked_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Tracked URL not found")
    edge_cursor = await db.execute(
        "SELECT target_url, http_status, first_seen_at, last_seen_at, active"
        " FROM redirect_edges WHERE source_url = ? ORDER BY last_seen_at DESC",
        (row["url"],),
    )
    edges = await edge_cursor.fetchall()
    return {
        "url": row["url"],
        "status": row["status"],
        "edges": [dict(e) for e in edges],
    }
```

- [ ] **Step 5: Mount router in `app/main.py`**

In the import line:
```python
from app.routes import auth as auth_routes
from app.routes import blacklist, findings, monitor, patterns, redirects
```
After the blacklist include:
```python
app.include_router(redirects.router, dependencies=[Depends(verify_admin)])
```

- [ ] **Step 6: Run all backend tests** — `pytest` (all pass).
- [ ] **Step 7: Commit** — `git add app/models.py app/routes/redirects.py app/main.py tests/test_redirects.py && git commit -m "feat(redirects): /api/redirects router (CRUD, check, graph, history)"`

---

### Task 4: Scheduler job

**Files:**
- Modify: `app/main.py`

- [ ] **Step 1: Add the job inside `lifespan`** (next to the `fetch_logs` job)

```python
    from app.services.monitor import fetch_logs
    from app.services.redirects import check_all

    scheduler.add_job(
        fetch_logs,
        "interval",
        minutes=settings.poll_interval_minutes,
        kwargs={"minutes": settings.poll_interval_minutes},
    )
    scheduler.add_job(
        check_all,
        "interval",
        minutes=settings.redirect_check_interval_minutes,
    )
```

- [ ] **Step 2: Verify** — `python -c "from app.main import app; print('ok')"` exits 0.
- [ ] **Step 3: Commit** — `git add app/main.py && git commit -m "feat(redirects): schedule periodic redirect checks"`

---

### Task 5: Frontend API client

**Files:**
- Modify: `admin-ui/src/api.ts`

- [ ] **Step 1: Add types** (after the blacklist interfaces)

```ts
export interface TrackedUrl {
  id: number
  url: string
  source: "manual" | "finding" | "auto"
  status: "unknown" | "ok" | "redirect" | "error"
  http_status: number | null
  final_url: string | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string | null
  history_count: number
}

export interface TrackedUrlsResponse {
  items: TrackedUrl[]
  total: number
}

export interface RedirectLink {
  source: string
  target: string
  http_status: number
  active: boolean
}

export interface RedirectGraphNode {
  id: string
  label: string
  status: TrackedUrl["status"]
  final_url: string | null
  history_count: number
}

export interface RedirectGraph {
  nodes: RedirectGraphNode[]
  links: RedirectLink[]
}

export interface RedirectCheckResult {
  url: string
  status: TrackedUrl["status"]
  http_status: number | null
  final_url: string | null
  error: string | null
}

export interface RedirectCheckResponse {
  checked: number
  updated: RedirectCheckResult[]
}

export interface UrlRedirectHistory {
  url: string
  status: TrackedUrl["status"]
  edges: {
    target_url: string
    http_status: number
    first_seen_at: string
    last_seen_at: string
    active: boolean
  }[]
}
```

- [ ] **Step 2: Add functions** (at the end of `api.ts`)

```ts
export async function listTrackedUrls(params?: {
  search?: string
  limit?: number
  offset?: number
  sort_by?: "id" | "url" | "source" | "status" | "last_checked_at"
  sort_order?: "asc" | "desc"
}): Promise<TrackedUrlsResponse> {
  const qs = new URLSearchParams()
  if (params?.search) qs.set("search", params.search)
  if (params?.limit) qs.set("limit", String(params.limit))
  if (params?.offset) qs.set("offset", String(params.offset))
  if (params?.sort_by) qs.set("sort_by", params.sort_by)
  if (params?.sort_order) qs.set("sort_order", params.sort_order)
  return request(`/redirects/?${qs}`)
}

export async function addTrackedUrl(data: {
  url: string
  source?: "manual" | "finding"
}): Promise<TrackedUrl> {
  return request("/redirects/", { method: "POST", body: JSON.stringify(data) })
}

export async function deleteTrackedUrl(id: number): Promise<void> {
  return request(`/redirects/${id}`, { method: "DELETE" })
}

export async function checkRedirects(url?: string): Promise<RedirectCheckResponse> {
  return request("/redirects/check", {
    method: "POST",
    body: JSON.stringify(url ? { url } : {}),
  })
}

export async function getRedirectGraph(): Promise<RedirectGraph> {
  return request("/redirects/graph")
}

export async function getUrlRedirectHistory(id: number): Promise<UrlRedirectHistory> {
  return request(`/redirects/${id}/history`)
}
```

- [ ] **Step 3: Typecheck** — `cd admin-ui && npx tsc --noEmit` (clean).
- [ ] **Step 4: Commit** — `git add admin-ui/src/api.ts && git commit -m "feat(redirects): api client for redirect tracker"`

---

### Task 6: Redirects page (table + graph + history)

**Files:**
- Create: `admin-ui/src/components/RedirectsPage.tsx`
- Modify: `admin-ui/src/components/Sidebar.tsx` (View union + nav item)
- Modify: `admin-ui/src/App.tsx` (route)

**Interfaces:**
- Consumes: all api.ts functions from Task 5; `View` from Sidebar.
- Produces: `RedirectsPage` component (no props).

- [ ] **Step 1: Add nav item in `Sidebar.tsx`**

Import `GitBranch` from lucide-react; extend the union + `DEFAULT_NAV`:
```ts
export type View = "dashboard" | "patterns" | "findings" | "graph" | "blacklist" | "redirects"
...
  { view: "redirects", label: "Redirects", icon: GitBranch },
```

- [ ] **Step 2: Route in `App.tsx`** — import `RedirectsPage`, add `{view === "redirects" && <RedirectsPage />}`.

- [ ] **Step 3: Implement `RedirectsPage.tsx`**

Structure (full component — table + summary chips + graph + history dialog):

```tsx
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Clock,
  CornerUpRight,
  GitBranch,
  History,
  RefreshCcw,
  Search,
  SearchX,
  Trash2,
} from "lucide-react"
import {
  type RedirectGraph,
  type TrackedUrl,
  type UrlRedirectHistory,
  addTrackedUrl,
  checkRedirects,
  deleteTrackedUrl,
  getRedirectGraph,
  getUrlRedirectHistory,
  listTrackedUrls,
} from "../api"
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Input,
  Pagination,
  Skeleton,
  useToast,
} from "./ui"
import { useDebounce, cn } from "../lib/utils"

const PAGE_SIZE = 25

const STATUS_META: Record<TrackedUrl["status"], { label: string; variant: "default" | "success" | "warning" | "destructive" }> = {
  unknown: { label: "Unknown", variant: "default" },
  ok: { label: "OK", variant: "success" },
  redirect: { label: "Redirecting", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
}

const SOURCE_META: Record<TrackedUrl["source"], { label: string; variant: "default" | "secondary" | "outline" }> = {
  manual: { label: "Manual", variant: "secondary" },
  finding: { label: "From finding", variant: "outline" },
  auto: { label: "Auto", variant: "default" },
}

type SortKey = "id" | "url" | "source" | "status" | "last_checked_at"
type SortDir = "asc" | "desc"

function formatWhen(ts: string | null) {
  if (!ts) return "—"
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

/* ── layered two-column graph (Traffic Graph style) ─────────────── */

const COLUMNS = [
  { key: "source", x: 24, width: 380, label: "Redirect sources" },
  { key: "target", x: 448, width: 380, label: "Destinations" },
]
const NODE_HEIGHT = 40
const TOP_PAD = 84
const BOTTOM_PAD = 32
const MAX_CANVAS_HEIGHT = 640

const STATUS_NODE_STYLE: Record<TrackedUrl["status"], string> = {
  ok: "fill-success/15 stroke-success",
  redirect: "fill-warning/15 stroke-warning",
  error: "fill-danger/15 stroke-danger",
  unknown: "fill-muted stroke-muted-foreground/50",
}
const STATUS_LABEL_STYLE: Record<TrackedUrl["status"], string> = {
  ok: "fill-success",
  redirect: "fill-warning",
  error: "fill-danger",
  unknown: "fill-muted-foreground",
}

interface LayoutNode {
  id: string
  column: "source" | "target"
  label: string
  status: TrackedUrl["status"]
  history_count: number
  x: number
  y: number
  width: number
  height: number
}

function buildLayout(graph: RedirectGraph) {
  const active = graph.links.filter((l) => l.active)
  const sources = new Set(active.map((l) => l.source))
  const targets = new Set(active.map((l) => l.target))
  const left = graph.nodes.filter((n) => sources.has(n.id))
  const right = graph.nodes.filter((n) => targets.has(n.id))

  const maxRows = Math.max(left.length, right.length, 1)
  const slot = Math.max(52, Math.min(64, Math.floor((MAX_CANVAS_HEIGHT - TOP_PAD - BOTTOM_PAD) / maxRows)))
  const height = Math.max(320, TOP_PAD + maxRows * slot + BOTTOM_PAD)

  const nodes: LayoutNode[] = []
  const place = (list: RedirectGraph["nodes"], column: "source" | "target") => {
    const col = COLUMNS.find((c) => c.key === column)!
    list.forEach((n, i) => {
      nodes.push({
        id: `${column}:${n.id}`,
        column,
        label: n.label,
        status: n.status,
        history_count: n.history_count,
        x: col.x,
        y: TOP_PAD + i * slot + (slot - NODE_HEIGHT) / 2,
        width: col.width,
        height: NODE_HEIGHT,
      })
    })
  }
  place(left, "source")
  place(right, "target")

  return { nodes, width: 448 + 380 + 40, height }
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function edgePath(a: LayoutNode, b: LayoutNode) {
  const sx = a.x + a.width
  const sy = a.y + a.height / 2
  const tx = b.x
  const ty = b.y + b.height / 2
  const dx = Math.max(40, (tx - sx) / 2)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}
```

Component body (state, fetchers, table, graph, dialogs) — see implementation; key behaviors:
- `load()` fetches `listTrackedUrls` (debounced search + sort + pagination) and `getRedirectGraph` in parallel.
- Add URL: validates non-empty, calls `addTrackedUrl({ url, source: "manual" })`, toast, reload.
- Check now: `checkRedirects()`, toast with `checked`/`updated` counts, reload.
- Delete: `ConfirmDialog` → `deleteTrackedUrl(id)` → reload.
- History: `getUrlRedirectHistory(id)` into `Dialog`.
- Graph: sources left / targets right, arrows, hover highlight (neighbors), click node → sets search filter + toasts; toggle `showHistory` renders `active === false` links dashed.
- Summary chips via `StatCard` (total / redirecting / ok / error counts).

- [ ] **Step 4: Typecheck + lint** — `cd admin-ui && npx tsc --noEmit && npm run lint`.
- [ ] **Step 5: Commit** — `git add admin-ui/src/components/RedirectsPage.tsx admin-ui/src/components/Sidebar.tsx admin-ui/src/App.tsx && git commit -m "feat(redirects): redirects page with table, graph and history"`

---

### Task 7: Findings page Track button

**Files:**
- Modify: `admin-ui/src/components/FindingsPage.tsx`

- [ ] **Step 1: Add tracked-URL index + action**

- Import `CornerUpRight` icon and `addTrackedUrl`, `listTrackedUrls` from `../api`.
- New state `trackedIndex: Record<string, true>`; fetch once via `listTrackedUrls({ limit: 5000 })` (same pattern as the whitelist index).
- New handler:
```tsx
const handleTrackRedirect = async (url: string) => {
  setBusy(true)
  try {
    await addTrackedUrl({ url, source: "finding" })
    toast({ title: "URL added to redirect tracking", description: url, variant: "success" })
    setTrackedIndex((prev) => ({ ...prev, [url]: true }))
  } catch (e) {
    const message = (e as Error).message
    if (message.includes("already tracked")) {
      setTrackedIndex((prev) => ({ ...prev, [url]: true }))
      toast({ title: "Already tracked", description: url, variant: "info" })
    } else {
      toast({ title: "Track redirect failed", description: message, variant: "error" })
    }
  } finally {
    setBusy(false)
  }
}
```
- In the actions cell, before the delete button:
```tsx
<Button
  variant="ghost"
  size="icon"
  className="h-8 w-8 text-muted-foreground hover:text-foreground"
  onClick={() => handleTrackRedirect(f.url)}
  disabled={busy || trackedIndex[f.url]}
  aria-label={`Track redirects for ${f.url}`}
>
  {trackedIndex[f.url] ? <History className="h-4 w-4" /> : <CornerUpRight className="h-4 w-4" />}
</Button>
```

- [ ] **Step 2: Typecheck + lint** — `cd admin-ui && npx tsc --noEmit && npm run lint`.
- [ ] **Step 3: Commit** — `git add admin-ui/src/components/FindingsPage.tsx && git commit -m "feat(findings): track redirects from finding rows"`

---

### Task 8: Full validation + review

- [ ] **Step 1: Run all gates in parallel** — `pytest`; `cd admin-ui && npx tsc --noEmit`; `npm run build`; `npm run lint`.
- [ ] **Step 2: Code review** — code-reviewer-deepseek-flash on the diff; fix issues found.
- [ ] **Step 3: Re-run gates** until green.
