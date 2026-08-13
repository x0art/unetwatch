# Per-Client URL Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Traffic page, let the user pick a client IP and see an animated radial diagram of which URLs that client accessed and how often, with filters (source, time window, URL substring, top-N cap) and a click-to-filter flows table.

**Architecture:** Backend adds three read-only endpoints sharing one response shape (`{client_ip, source, total_accesses, es_online, urls[]}`) — `top-clients` and `client/{ip}` aggregate the persisted `findings` table in SQL (whitelist exclusion pushed into `NOT LIKE` clauses + Python fallback, exactly like `findings_graph`), and `query/client` aggregates a client-filtered live-ES query. Frontend adds a `RadialDiagram` ECharts component (graph + animated `lines` trail overlay, deterministic fixed layout, zero force simulation) and wires it into `GraphPage` as a focused drill-down mode that replaces the aggregate sankey/ranked panels.

**Tech Stack:** Python 3.12 / FastAPI / aiosqlite / pytest / ruff; React 19 / Vite / Tailwind v4 / TypeScript / ECharts (already a dependency). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-client-url-drilldown-design.md`

## Global Constraints

- No new dependencies on either side (ECharts + FastAPI are already present).
- Backend changed files keep `ruff check` clean and `pytest` green (`asyncio_mode = "auto"`; `tests/conftest.py` provides `db_path` + `client` fixtures; TestClient runs the app lifespan, which seeds block + whitelist patterns — tests must `DELETE FROM findings` first to isolate).
- Whitelist exclusion reuses `_whitelist_sql_clauses` + `_build_pattern_regex` from `app/services/monitor.py` (same semantics as `findings_graph`).
- Motion discipline: ECharts animates only `transform`/`opacity` on canvas; no DOM layout churn, no springs; `prefers-reduced-motion` honored via `matchMedia` → `animation: false` + no trail effect; deterministic fixed node positions (no force-simulation jitter); data-change diff skips `setOption` on identical data.
- No placeholders / stubs / `.only` / `test.skip` in changed files before completion.
- Frontend build = `cd admin-ui && npm run build` (tsc + vite); lint = `npm run lint` (oxlint, 0 errors). Backend test cmd = `.venv/bin/python -m pytest -q`; lint = `.venv/bin/python -m ruff check app tests` (both may need a `timeout` prefix in this environment).

---

## Task 1: Backend — `top-clients` endpoint + indexes

**Files:**
- Modify: `app/routes/findings.py` (add `top_clients` route; it already imports `re`, `Query`, and `_build_pattern_regex` / `_whitelist_sql_clauses` from `app.services.monitor`)
- Modify: `app/database.py` (two indexes after the existing url/base_url index block, around `database.py:58-62`)
- Test: `tests/test_client_breakdown.py` (create)

**Interfaces:**
- Consumes: `_build_pattern_regex`, `_whitelist_sql_clauses` (already exported from `app.services.monitor`)
- Produces: `GET /api/findings/top-clients?search=&limit=` → `{"items": [{"client_ip": str, "count": int}]}` — powers the picker autocomplete + top-clients list in Task 7.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_client_breakdown.py`:

```python
"""Tests for the per-client URL drill-down endpoints (Traffic page)."""


async def _seed_findings(db_path) -> None:
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.execute("DELETE FROM findings")
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, '', ?, ?)",
        [
            # client 1.1.1.1 -> 2 URLs, 3 accesses, ALL on a.example
            ("1.1.1.1", "http://a.example/1", "a.example", "2026-08-01T00:00:00Z"),
            ("1.1.1.1", "http://a.example/1", "a.example", "2026-08-01T00:00:01Z"),
            ("1.1.1.1", "http://a.example/2", "a.example", "2026-08-01T00:00:02Z"),
            # client 2.2.2.2 -> 2 URLs, 3 accesses (mixed hosts)
            ("2.2.2.2", "http://b.example/3", "b.example", "2026-08-01T00:00:03Z"),
            ("2.2.2.2", "http://c.example/4", "c.example", "2026-08-01T00:00:04Z"),
            ("2.2.2.2", "http://c.example/4", "c.example", "2026-08-01T00:00:05Z"),
            # old row outside any 24h window
            ("3.3.3.3", "http://d.example/5", "d.example", "2020-01-01T00:00:00Z"),
        ],
    )
    await db.commit()
    await db.close()


async def test_top_clients_ranked(client, db_path):
    await _seed_findings(db_path)
    res = client.get("/api/findings/top-clients")
    assert res.status_code == 200
    assert res.json()["items"] == [
        {"client_ip": "1.1.1.1", "count": 3},
        {"client_ip": "2.2.2.2", "count": 3},
        {"client_ip": "3.3.3.3", "count": 1},
    ]


async def test_top_clients_search(client, db_path):
    await _seed_findings(db_path)
    items = client.get("/api/findings/top-clients?search=1.1.").json()["items"]
    assert items == [{"client_ip": "1.1.1.1", "count": 3}]
    assert client.get("/api/findings/top-clients?search=nope").json()["items"] == []


async def test_top_clients_limit(client, db_path):
    await _seed_findings(db_path)
    items = client.get("/api/findings/top-clients?limit=2").json()["items"]
    assert len(items) == 2
    assert items[0]["client_ip"] == "1.1.1.1"


async def test_top_clients_whitelist_glob_excluded(client, db_path):
    """SQL-expressible whitelist globs drop matching clients (fast path)."""
    await _seed_findings(db_path)
    resp = client.post(
        "/api/patterns/", json={"pattern": "*a.example*", "pattern_type": "whitelist"}
    )
    assert resp.status_code == 201
    items = client.get("/api/findings/top-clients").json()["items"]
    assert items == [
        {"client_ip": "2.2.2.2", "count": 3},
        {"client_ip": "3.3.3.3", "count": 1},
    ]


async def test_top_clients_whitelist_fallback_excluded(client, db_path):
    """Literal whitelist patterns (no wildcard) use the Python row-level fallback."""
    await _seed_findings(db_path)
    resp = client.post(
        "/api/patterns/", json={"pattern": "a.example", "pattern_type": "whitelist"}
    )
    assert resp.status_code == 201
    items = client.get("/api/findings/top-clients").json()["items"]
    assert items == [
        {"client_ip": "2.2.2.2", "count": 3},
        {"client_ip": "3.3.3.3", "count": 1},
    ]
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 90 .venv/bin/python -m pytest tests/test_client_breakdown.py -v`
Expected: FAIL with `404` (route does not exist yet) and a module error for `_whitelist_fully_sql` if referenced.

- [ ] **Step 3: Implement the route**

In `app/routes/findings.py`, add after the `findings_graph` route (before `clear_findings`). Route order matters: `/top-clients` is a static GET path and must be declared before any `/{finding_id}`-style GET route — currently there is no `@router.get("/{...}")` in this file, so placement is safe anywhere among the GET routes:

```python
def _whitelist_fully_sql(patterns: list[str], sql_clauses: list[str]) -> bool:
    """True when every non-empty whitelist pattern produced a SQL clause.

    ``_whitelist_sql_clauses`` only emits clauses for patterns composed of
    literals + ``*``/``?``. If any pattern fell through (regex meta chars,
    whitespace, no wildcards at all) the caller must use the row-level Python
    fallback, since a grouped-by-client_ip query loses the url/base_url the
    regex needs.
    """
    return len([p for p in map(str.strip, patterns) if p]) == len(sql_clauses)


@router.get("/top-clients")
async def top_clients(
    db=Depends(get_db_conn),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(20, ge=1, le=100),
):
    """Top client IPs by total access count (drill-down picker + top list).

    Whitelisted destinations are excluded exactly like ``findings_graph``:
    SQL-expressible patterns become ``NOT LIKE`` clauses in the WHERE;
    anything else (or a mix) falls back to fetching rows and filtering in
    Python before aggregating, because the grouped query no longer carries
    the per-row url/base_url the regex needs.
    """
    wl_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'whitelist'"
    )
    wl_rows = await wl_cursor.fetchall()
    whitelist_patterns = [r[0] for r in wl_rows]
    whitelist_regex = _build_pattern_regex(whitelist_patterns)
    sql_clauses = _whitelist_sql_clauses(whitelist_patterns)

    where = ["client_ip != ''", *sql_clauses]
    params: list = []
    if search:
        where.append("client_ip LIKE ?")
        params.append(f"%{search}%")
    clause = f"WHERE {' AND '.join(where)}"

    if whitelist_regex and not _whitelist_fully_sql(whitelist_patterns, sql_clauses):
        # Row-level fallback: filter rows in Python, then aggregate. Bounded
        # fetch (same tradeoff the findings graph makes with LIMIT 5000).
        cursor = await db.execute(
            f"SELECT client_ip, url, base_url FROM findings {clause} LIMIT 100000",
            params,
        )
        counts: dict[str, int] = {}
        for r in await cursor.fetchall():
            if re.search(whitelist_regex, str(r["url"]), re.IGNORECASE) or re.search(
                whitelist_regex, str(r["base_url"]), re.IGNORECASE
            ):
                continue
            counts[r["client_ip"]] = counts.get(r["client_ip"], 0) + 1
        items = [
            {"client_ip": ip_, "count": c}
            for ip_, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
        ]
        return {"items": items}

    cursor = await db.execute(
        f"""
        SELECT client_ip, COUNT(*) AS count
        FROM findings
        {clause}
        GROUP BY client_ip
        ORDER BY count DESC, client_ip
        LIMIT ?
        """,
        (*params, limit),
    )
    items = [
        {"client_ip": r["client_ip"], "count": r["count"]}
        for r in await cursor.fetchall()
    ]
    return {"items": items}
```

- [ ] **Step 4: Add the indexes**

In `app/database.py`, immediately after the existing `idx_findings_base_url` block:

```python
    # Indexes for the per-client drill-down (client_ip filter + window scans).
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_findings_client_ip ON findings(client_ip)"
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_findings_log_timestamp ON findings(log_timestamp)"
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `timeout 90 .venv/bin/python -m pytest tests/test_client_breakdown.py -v`
Expected: all 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/findings.py app/database.py tests/test_client_breakdown.py
git commit -m "feat(api): top-clients endpoint + drill-down indexes"
```

---

## Task 2: Backend — `client/{ip}` breakdown endpoint

**Files:**
- Modify: `app/routes/findings.py` (add `client_breakdown` route, after `top_clients`)
- Test: `tests/test_client_breakdown.py` (extend)

**Interfaces:**
- Consumes: `_build_pattern_regex`, `_whitelist_sql_clauses` (both already exported from `app.services.monitor`)
- Produces: `GET /api/findings/client/{ip}?minutes=&search=&limit=` → `{"client_ip", "source": "findings", "total_accesses", "es_online": true, "urls": [{"url", "base_url", "count", "last_seen"}]}` — the persisted-findings half of the drill-down (Task 7 consumes this shape).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_client_breakdown.py`:

```python
async def test_client_breakdown_counts(client, db_path):
    await _seed_findings(db_path)
    res = client.get("/api/findings/client/1.1.1.1")
    assert res.status_code == 200
    data = res.json()
    assert data["client_ip"] == "1.1.1.1"
    assert data["source"] == "findings"
    assert data["es_online"] is True
    assert data["total_accesses"] == 3
    assert data["urls"] == [
        {
            "url": "http://a.example/1",
            "base_url": "a.example",
            "count": 2,
            "last_seen": "2026-08-01T00:00:01Z",
        },
        {
            "url": "http://a.example/2",
            "base_url": "a.example",
            "count": 1,
            "last_seen": "2026-08-01T00:00:02Z",
        },
    ]


async def test_client_breakdown_window(client, db_path):
    await _seed_findings(db_path)
    data = client.get("/api/findings/client/3.3.3.3?minutes=1440").json()
    assert data["total_accesses"] == 0
    assert data["urls"] == []
    # No window param = all time.
    data = client.get("/api/findings/client/3.3.3.3").json()
    assert data["total_accesses"] == 1


async def test_client_breakdown_search(client, db_path):
    await _seed_findings(db_path)
    data = client.get("/api/findings/client/1.1.1.1?search=/2").json()
    assert data["total_accesses"] == 1
    assert data["urls"] == [
        {
            "url": "http://a.example/2",
            "base_url": "a.example",
            "count": 1,
            "last_seen": "2026-08-01T00:00:02Z",
        }
    ]


async def test_client_breakdown_limit(client, db_path):
    await _seed_findings(db_path)
    data = client.get("/api/findings/client/1.1.1.1?limit=1").json()
    assert len(data["urls"]) == 1
    assert data["urls"][0]["url"] == "http://a.example/1"
    # The cap only trims the list, never the hub total.
    assert data["total_accesses"] == 3


async def test_client_breakdown_unknown_client(client, db_path):
    await _seed_findings(db_path)
    res = client.get("/api/findings/client/9.9.9.9")
    assert res.status_code == 200
    data = res.json()
    assert data["urls"] == []
    assert data["total_accesses"] == 0


async def test_client_breakdown_whitelist_glob_excluded(client, db_path):
    """Whitelisting one host drops only that host's URLs from the breakdown."""
    await _seed_findings(db_path)
    client.post(
        "/api/patterns/", json={"pattern": "*b.example*", "pattern_type": "whitelist"}
    )
    data = client.get("/api/findings/client/2.2.2.2").json()
    assert data["urls"] == [
        {
            "url": "http://c.example/4",
            "base_url": "c.example",
            "count": 2,
            "last_seen": "2026-08-01T00:00:05Z",
        }
    ]
    assert data["total_accesses"] == 2


async def test_client_breakdown_invalid_params(client, db_path):
    await _seed_findings(db_path)
    assert client.get("/api/findings/client/1.1.1.1?limit=0").status_code == 422
    assert client.get("/api/findings/client/1.1.1.1?limit=999").status_code == 422
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 90 .venv/bin/python -m pytest tests/test_client_breakdown.py -v`
Expected: FAIL — the new tests 404 (route missing).

- [ ] **Step 3: Implement the route**

In `app/routes/findings.py`, add after `top_clients`:

```python
@router.get("/client/{ip}")
async def client_breakdown(
    ip: str,
    db=Depends(get_db_conn),
    minutes: int | None = Query(None, ge=1, le=20160),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(12, ge=1, le=50),
):
    """Per-client URL breakdown with counts — data for the drill-down radial.

    The window, URL substring and top-N cap are applied in SQL together with
    the whitelist ``NOT LIKE`` clauses; the grouped rows still carry
    url/base_url, so the Python regex fallback re-filters them exactly like
    ``findings_graph`` (belt-and-braces for patterns that can't be expressed
    in SQL). ``total_accesses`` is the COUNT over the same WHERE — the cap
    only trims the URL list, never the hub total.
    """
    wl_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'whitelist'"
    )
    wl_rows = await wl_cursor.fetchall()
    whitelist_patterns = [r[0] for r in wl_rows]
    whitelist_regex = _build_pattern_regex(whitelist_patterns)
    sql_clauses = _whitelist_sql_clauses(whitelist_patterns)

    where = ["client_ip = ?", *sql_clauses]
    params: list = [ip]
    if minutes:
        where.append("log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
        params.append(f"-{minutes} minutes")
    if search:
        where.append("url LIKE ?")
        params.append(f"%{search}%")
    clause = f"WHERE {' AND '.join(where)}"

    cursor = await db.execute(
        f"""
        SELECT url, base_url, COUNT(*) AS count, MAX(log_timestamp) AS last_seen
        FROM findings
        {clause}
        GROUP BY url, base_url
        ORDER BY count DESC, url
        LIMIT ?
        """,
        (*params, limit),
    )
    rows = [dict(r) for r in await cursor.fetchall()]
    if whitelist_regex:
        rows = [
            r
            for r in rows
            if not (
                re.search(whitelist_regex, str(r["url"]), re.IGNORECASE)
                or re.search(whitelist_regex, str(r["base_url"]), re.IGNORECASE)
            )
        ]

    total_cursor = await db.execute(
        f"SELECT COUNT(*) AS total FROM findings {clause}", params
    )
    total = (await total_cursor.fetchone())["total"]
    return {
        "client_ip": ip,
        "source": "findings",
        "total_accesses": total,
        "es_online": True,
        "urls": rows,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 90 .venv/bin/python -m pytest tests/test_client_breakdown.py -v`
Expected: all 13 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/findings.py tests/test_client_breakdown.py
git commit -m "feat(api): per-client URL breakdown endpoint"
```

---

## Task 3: Backend — live-ES `query/client` endpoint

**Files:**
- Modify: `app/services/monitor.py` (`build_logs_query` — add a `client_ip` filter param; add `run_client_query` near `run_query`; `_client_query_cache_key` near `_query_cache_key`)
- Modify: `app/routes/query.py` (add `/client` route)
- Test: `tests/test_client_breakdown.py` (extend)

**Interfaces:**
- Consumes: `build_es_client`, `get_block_patterns`, `get_whitelist_patterns`, `_build_pattern_regex`, `apply_filters`, `_query_cache` / `_QUERY_TTL_S` (all already in `app/services/monitor.py`)
- Produces: `GET /api/query/client?ip=&minutes=&search=&limit=` → same shape as Task 2 with `"source": "es"` (Task 7 consumes this shape); `build_logs_query(..., client_ip=...)` reusable by future client-scoped queries.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_client_breakdown.py`:

```python
def test_query_client_es_offline(client):
    """Live-ES breakdown degrades gracefully when Elasticsearch is down."""
    res = client.get("/api/query/client?ip=1.1.1.1&minutes=60")
    assert res.status_code == 200
    data = res.json()
    assert data["client_ip"] == "1.1.1.1"
    assert data["source"] == "es"
    assert data["urls"] == []
    assert data["es_online"] is False


def test_query_client_validation(client):
    assert client.get("/api/query/client").status_code == 422  # ip required
    assert client.get("/api/query/client?ip=1.1.1.1&limit=0").status_code == 422
    assert client.get("/api/query/client?ip=1.1.1.1&limit=999").status_code == 422
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 90 .venv/bin/python -m pytest tests/test_client_breakdown.py::test_query_client_es_offline tests/test_client_breakdown.py::test_query_client_validation -v`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Extend `build_logs_query` with a `client_ip` filter**

In `app/services/monitor.py`, change the `build_logs_query` signature and body. Current body builds `must` then returns a dict whose `filter` is the range clause. New version:

```python
def build_logs_query(
    block_patterns: list[str],
    minutes: int,
    size: int,
    search: str | None = None,
    client_ip: str | None = None,
) -> dict:
    """ES query that flags URLs matching any block pattern within the window.

    ``search`` (optional) narrows the result set *at the ES level*: every
    whitespace-separated token must appear as a substring of the URL, client
    IP or server IP. Tokens are escaped so the operator can never break out
    of the query_string grammar. ``client_ip`` (optional) narrows to a single
    client via a ``term`` filter — used by the drill-down radial.
    """
    query_string = " OR ".join(
        f"url : {_escape_query_string(p)}" for p in block_patterns
    )
    must: list[dict] = [
        {"query_string": {"query": query_string, "analyze_wildcard": True}}
    ]
    terms = [t for t in re.split(r"\s+", search.strip()) if t] if search else []
    # Cap the number of ANDed wildcard clauses: each token becomes three
    # leading-wildcard subqueries (url/client_ip/server_ip), which are
    # scan-heavy on large indexes. 20 tokens = 60 wildcard clauses, far
    # below ES's default max_clause_count (1024).
    terms = terms[:20]
    if terms:
        clauses = [
            "("
            "url:*{t}* OR client_ip:*{t}* OR server_ip:*{t}*"
            ")".format(t=_escape_query_string(term))
            for term in terms
        ]
        must.append(
            {
                "query_string": {
                    "query": " AND ".join(clauses),
                    "analyze_wildcard": True,
                }
            }
        )
    filters: list[dict] = [
        {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
    ]
    if client_ip:
        filters.append({"term": {"client_ip": client_ip}})
    return {
        "size": size,
        "query": {"bool": {"filter": filters, "must": must}},
    }
```

- [ ] **Step 4: Add `_client_query_cache_key` and `run_client_query`**

In `app/services/monitor.py`, after `_invalidate_query_cache` (before `run_query`), add:

```python
def _client_query_cache_key(
    ip: str,
    minutes: int,
    search: str | None,
    limit: int,
    block_patterns: list[str],
    whitelist_patterns: list[str],
) -> str:
    """Stable cache key for a run_client_query invocation."""
    return "|".join(
        [
            "client",
            ip,
            str(minutes),
            search or "",
            str(limit),
            "|".join(block_patterns),
            "|".join(whitelist_patterns),
        ]
    )


async def run_client_query(
    ip: str,
    minutes: int = 60,
    search: str | None = None,
    limit: int = 12,
) -> dict:
    """Per-client URL breakdown aggregated from live ES (drill-down radial).

    Same response shape as the persisted-findings breakdown endpoint with
    ``source="es"``: the hub count plus per-URL counts. Whitelist exclusion
    mirrors ``run_query`` (``exclude_whitelist=True``, all actions kept).
    Elasticsearch failures degrade gracefully (``es_online: False``) — the
    endpoint never 500s. Identical duplicate ticks within the TTL reuse the
    cached payload instead of re-hitting ES.
    """
    settings = get_settings()

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
    finally:
        await db.close()

    result = {
        "client_ip": ip,
        "source": "es",
        "total_accesses": 0,
        "es_online": True,
        "urls": [],
    }

    cache_key = _client_query_cache_key(
        ip, minutes, search, limit, block_patterns, whitelist_patterns
    )
    hit = _query_cache.get(cache_key)
    if hit is not None and time.monotonic() - hit[0] < _QUERY_TTL_S:
        return dict(hit[1])

    try:
        if not block_patterns:
            return result

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(
            block_patterns,
            minutes,
            settings.es_query_size,
            search=search,
            client_ip=ip,
        )

        es = build_es_client(settings, timeout=30)
        try:
            res = await es.search(index=settings.elastic_index, body=query)
        except Exception:
            result["es_online"] = False
            return result
        finally:
            await es.close()

        hits = res["hits"]["hits"]
        if not hits:
            return result

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=True,
            actions=None,
        )
        if df.empty:
            return result

        result["total_accesses"] = int(len(df))
        urls = df["url"].astype(str)
        base_by_url = df.assign(base_url=df["base_url"].astype(str)).groupby("url")[
            "base_url"
        ].first()
        last_by_url = (
            df.assign(ts=df["@timestamp"].astype(str)).groupby("url")["ts"].max()
        )
        counts = urls.value_counts().head(limit)
        result["urls"] = [
            {
                "url": u,
                "base_url": str(base_by_url.get(u, "") or ""),
                "count": int(c),
                "last_seen": str(last_by_url.get(u, "") or ""),
            }
            for u, c in counts.items()
        ]
    finally:
        _query_cache[cache_key] = (time.monotonic(), result)
    return result
```

- [ ] **Step 5: Add the route**

In `app/routes/query.py`, after the `/run` route:

```python
@router.get("/client")
async def client_breakdown_live(
    ip: str = Query(..., min_length=1, max_length=64),
    minutes: int = Query(60, ge=1, le=20160),
    q: str | None = Query(None, max_length=200),
    limit: int = Query(12, ge=1, le=50),
):
    """Per-client URL breakdown aggregated from live ES.

    Same response shape as the persisted-findings breakdown endpoint
    (``source="es"``), for the Traffic page drill-down radial. ES failures
    degrade gracefully (``es_online: False``, empty urls).
    """
    from app.services.monitor import run_client_query

    return await run_client_query(ip, minutes=minutes, search=q or None, limit=limit)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `timeout 90 .venv/bin/python -m pytest tests/test_client_breakdown.py -v`
Expected: all 15 PASS.

- [ ] **Step 7: Backend lint + full suite**

Run: `timeout 90 .venv/bin/python -m ruff check app tests && timeout 150 .venv/bin/python -m pytest -q`
Expected: ruff clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/services/monitor.py app/routes/query.py tests/test_client_breakdown.py
git commit -m "feat(api): live-ES per-client URL breakdown endpoint"
```

---

## Task 4: Frontend — API types + calls

**Files:**
- Modify: `admin-ui/src/api.ts`

**Interfaces:**
- Consumes: the three backend endpoints from Tasks 1-3
- Produces: `TopClient`, `ClientUrlCount`, `ClientBreakdown` types + `getTopClients`, `getClientBreakdown`, `runClientQuery` (consumed by Tasks 6-7).

- [ ] **Step 1: Add the types and calls**

Append to `admin-ui/src/api.ts` (after the `FindingsGraph` block, before the Blacklist section):

```ts
/* ── Per-client URL drill-down (Traffic page) ─────────────────── */

export interface TopClient {
  client_ip: string
  count: number
}

export interface ClientUrlCount {
  url: string
  base_url: string
  count: number
  last_seen: string
}

export interface ClientBreakdown {
  client_ip: string
  source: "findings" | "es"
  total_accesses: number
  es_online: boolean
  urls: ClientUrlCount[]
}

export async function getTopClients(opts?: {
  search?: string
  limit?: number
}): Promise<{ items: TopClient[] }> {
  const qs = new URLSearchParams()
  if (opts?.search) qs.set("search", opts.search)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/findings/top-clients?${qs}`)
}

export async function getClientBreakdown(
  ip: string,
  opts?: { minutes?: number; search?: string; limit?: number },
): Promise<ClientBreakdown> {
  const qs = new URLSearchParams()
  if (opts?.minutes) qs.set("minutes", String(opts.minutes))
  if (opts?.search) qs.set("search", opts.search)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/findings/client/${encodeURIComponent(ip)}?${qs}`)
}

export async function runClientQuery(
  ip: string,
  opts?: { minutes?: number; search?: string; limit?: number },
): Promise<ClientBreakdown> {
  const qs = new URLSearchParams({ ip })
  if (opts?.minutes) qs.set("minutes", String(opts.minutes))
  if (opts?.search) qs.set("search", opts.search)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/query/client?${qs}`)
}
```

- [ ] **Step 2: Build**

Run: `cd admin-ui && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/api.ts
git commit -m "feat(ui): drill-down API types + calls"
```

---

## Task 5: Frontend — `RadialDiagram` component

**Files:**
- Modify: `admin-ui/src/components/SankeyDiagram.tsx` (export `ResolvedColors` + `resolveAllColors` — one-line change each)
- Create: `admin-ui/src/components/RadialDiagram.tsx`

**Interfaces:**
- Consumes: `resolveAllColors` from `SankeyDiagram.tsx` (same oklch→srgb machinery + theme-keyed cache), `ClientUrlCount` from `../api`, `useTheme` from `./Sidebar`
- Produces: `RadialDiagram` (props: `{ clientIp: string; totalAccesses: number; urls: ClientUrlCount[]; height?: number; onSelectUrl?: (url: string) => void; className?: string; ariaLabel?: string }`) — consumed by Task 7.

- [ ] **Step 1: Export the palette helpers from SankeyDiagram**

In `admin-ui/src/components/SankeyDiagram.tsx`:
- Change `interface ResolvedColors {` → `export interface ResolvedColors {`
- Change `function resolveAllColors(` → `export function resolveAllColors(`

- [ ] **Step 2: Write `RadialDiagram.tsx`**

```tsx
import { useEffect, useMemo, useRef } from "react"
import * as echarts from "echarts/core"
import { GraphChart, LinesChart } from "echarts/charts"
import { GridComponent, TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type { ECharts, EChartsOption, TooltipComponentFormatterCallbackParams } from "echarts"
import { useTheme } from "./Sidebar"
import { resolveAllColors, type ResolvedColors } from "./SankeyDiagram"
import type { ClientUrlCount } from "../api"

echarts.use([GraphChart, LinesChart, GridComponent, TooltipComponent, CanvasRenderer])

const MAX_LABEL = 40

/** Strip a URL down to its host (FQDN) for the satellite label. */
function shortHost(url: string): string {
  const afterScheme = url.split("://").pop() ?? url
  return afterScheme.split(/[/?#]/)[0] || url
}

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

interface RadialNode {
  id: string
  name: string
  url: string
  count: number
  x: number
  y: number
  symbolSize: number
}

/** Deterministic radial coordinates: hub at (50,50), satellites on a circle
 * of radius R in a hidden 0-100 × 0-100 cartesian grid, sorted by count desc
 * so the biggest URL sits at 12 o'clock. Fixed positions mean no force
 * simulation, no jitter, and no re-layout on identical data. */
function layout(urls: ClientUrlCount[]): { nodes: RadialNode[]; center: [number, number] } {
  const sorted = [...urls].sort((a, b) => b.count - a.count)
  const max = Math.max(1, ...sorted.map((u) => u.count))
  const center: [number, number] = [50, 50]
  const R = 40
  const nodes: RadialNode[] = sorted.map((u, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(1, sorted.length) - Math.PI / 2
    return {
      id: `url:${u.url}`,
      name: shortHost(u.url),
      url: u.url,
      count: u.count,
      x: center[0] + R * Math.cos(angle),
      y: center[1] + R * Math.sin(angle),
      symbolSize: 12 + 16 * (u.count / max),
    }
  })
  return { nodes, center }
}

function buildOption(params: {
  clientIp: string
  totalAccesses: number
  nodes: RadialNode[]
  center: [number, number]
  resolved: ResolvedColors
  reduced: boolean
}): EChartsOption {
  const { clientIp, totalAccesses, nodes, center, resolved, reduced } = params
  const { palette, paletteColors } = resolved
  const hubColor = paletteColors[0] // info
  const urlColor = paletteColors[2] // danger
  const maxCount = Math.max(1, ...nodes.map((n) => n.count))

  const graphData = [
    {
      id: "hub",
      name: clientIp,
      x: center[0],
      y: center[1],
      fixed: true,
      symbolSize: 52,
      itemStyle: { color: hubColor, borderColor: palette.border, borderWidth: 2 },
      label: {
        show: true,
        position: "bottom",
        distance: 8,
        color: palette.label,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 12,
        formatter: `${clientIp}\n${totalAccesses.toLocaleString()} accesses`,
      },
    },
    ...nodes.map((n) => ({
      id: n.id,
      name: n.name,
      url: n.url,
      x: n.x,
      y: n.y,
      fixed: true,
      symbolSize: n.symbolSize,
      itemStyle: { color: urlColor, borderColor: palette.border, borderWidth: 1 },
      label: {
        show: true,
        position: "outside",
        distance: 6,
        color: palette.label,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 10,
        formatter: () => formatLabel(n.name),
      },
    })),
  ]

  // Static connection lines — thickness + opacity scale with the count.
  const links = nodes.map((n) => ({
    source: "hub",
    target: n.id,
    value: n.count,
    lineStyle: {
      width: 1 + 4 * (n.count / maxCount),
      opacity: 0.4 + 0.5 * (n.count / maxCount),
      color: urlColor,
    },
  }))

  // Animated flow-trail overlay: invisible line, moving symbol only.
  const trailData = nodes.map((n) => ({
    coords: [center, [n.x, n.y]] as [number, number][],
  }))

  return {
    animation: !reduced,
    animationDuration: reduced ? 0 : 600,
    animationEasing: "cubicOut",
    animationDurationUpdate: reduced ? 0 : 400,
    animationEasingUpdate: "cubicOut",
    tooltip: {
      trigger: "item",
      triggerOn: "mousemove",
      backgroundColor: palette.card,
      borderColor: palette.border,
      textStyle: { color: palette.label, fontSize: 12 },
      formatter: (p: TooltipComponentFormatterCallbackParams) => {
        const params = Array.isArray(p) ? p[0] : p
        const data = params.data as
          | { url?: string; name?: string; value?: number }
          | undefined
        if (data?.url) return `${data.url}<br/>${Number(data.value ?? 0).toLocaleString()} accesses`
        return data?.name ?? ""
      },
    },
    xAxis: { min: 0, max: 100, show: false },
    yAxis: { min: 0, max: 100, show: false },
    series: [
      {
        type: "graph",
        coordinateSystem: "cartesian2d",
        layout: "none",
        data: graphData,
        links,
        roam: false,
        draggable: false,
        emphasis: { focus: "adjacency" },
        // State changes snap; only data-change animation runs (cheap hover).
        stateAnimation: { duration: 0 },
        lineStyle: { color: "gradient", curveness: 0.15 },
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: [0, 6],
        label: { show: false },
      },
      {
        type: "lines",
        coordinateSystem: "cartesian2d",
        z: 3,
        silent: true,
        data: trailData,
        effect: reduced
          ? { show: false }
          : {
              show: true,
              period: 3.5,
              trailLength: 0.35,
              symbol: "circle",
              symbolSize: 3.5,
              color: urlColor,
            },
        lineStyle: { opacity: 0, width: 0 },
      },
    ],
  }
}

export function RadialDiagram({
  clientIp,
  totalAccesses,
  urls,
  height = 540,
  onSelectUrl,
  className,
  ariaLabel,
}: {
  clientIp: string
  totalAccesses: number
  urls: ClientUrlCount[]
  height?: number
  onSelectUrl?: (url: string) => void
  className?: string
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const { theme } = useTheme()
  const reduced =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false)

  const resolved = resolveAllColors(theme, undefined)
  const { nodes, center } = useMemo(() => layout(urls), [urls])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart

    const onResize = () => chart.resize()
    const onWindowResize = () => onResize()
    window.addEventListener("resize", onWindowResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(el)

    return () => {
      window.removeEventListener("resize", onWindowResize)
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  const prev = useRef<{ clientIp: string; nodes: RadialNode[] } | null>(null)
  const prevPalette = useRef<ResolvedColors["palette"] | null>(null)

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const sameNodes = (a: RadialNode[], b: RadialNode[]) =>
      a.length === b.length &&
      a.every(
        (n, i) =>
          n.id === b[i].id &&
          n.count === b[i].count &&
          n.x === b[i].x &&
          n.y === b[i].y,
      )
    const contentChanged =
      prev.current === null ||
      prev.current.clientIp !== clientIp ||
      !sameNodes(prev.current.nodes, nodes)
    const paletteChanged =
      prevPalette.current === null ||
      prevPalette.current.label !== resolved.palette.label ||
      prevPalette.current.muted !== resolved.palette.muted ||
      prevPalette.current.card !== resolved.palette.card ||
      prevPalette.current.border !== resolved.palette.border

    if (!contentChanged && !paletteChanged) {
      // Parent re-render with identical data/palette — nothing to do.
      return
    }

    prev.current = { clientIp, nodes }
    prevPalette.current = resolved.palette

    chart.setOption(
      buildOption({ clientIp, totalAccesses, nodes, center, resolved, reduced }),
      contentChanged,
    )
    chart.resize()
  }, [clientIp, totalAccesses, nodes, center, resolved, reduced])

  // Click a URL node → let GraphPage filter the flows table.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onSelectUrl) return
    const onClick = (params: { data?: { url?: string } }) => {
      if (params.data?.url) onSelectUrl(params.data.url)
    }
    chart.on("click", onClick)
    return () => {
      chart.off("click", onClick)
    }
  }, [onSelectUrl])

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel ?? `URL access radial for ${clientIp}`}
      className={className}
      style={{ width: "100%", height }}
    />
  )
}
```

- [ ] **Step 3: Build**

Run: `cd admin-ui && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/SankeyDiagram.tsx admin-ui/src/components/RadialDiagram.tsx
git commit -m "feat(ui): radial diagram with animated client-to-URL trails"
```

---

## Task 6: Frontend — clickable ranked rows

**Files:**
- Modify: `admin-ui/src/components/ui.tsx` (`RankedTable` `:995-1055` — add optional `onRowClick`)
- Modify: `admin-ui/src/components/motion.tsx` (`StaggerItem` — pass through `tabIndex`, `onKeyDown`, `role`)

**Interfaces:**
- Consumes: existing `StaggerItem` from `motion.tsx`
- Produces: `RankedTable` gains optional `onRowClick?: (label: string) => void` — consumed by Task 7 so the Top client IPs table selects a client.

- [ ] **Step 1: Extend `StaggerItem` to pass interaction props**

In `admin-ui/src/components/motion.tsx`, replace the `StaggerItem` component:

```tsx
/** Child of <Stagger> — fades/slides in when its parent animates to "show". */
export function StaggerItem({
  children,
  as = "div",
  className,
  onClick,
  onKeyDown,
  tabIndex,
  role,
  title,
}: {
  children: ReactNode
  as?: StaggerTag
  className?: string
  onClick?: () => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  tabIndex?: number
  role?: string
  title?: string
}) {
  const Tag = motion[as]
  return (
    <Tag
      className={className}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      role={role}
      title={title}
      variants={staggerItemVariants}
    >
      {children}
    </Tag>
  )
}
```

- [ ] **Step 2: Add `onRowClick` to `RankedTable`**

In `admin-ui/src/components/ui.tsx`, replace the `RankedTable` signature + the `StaggerItem` row block:

```tsx
export function RankedTable({
  rows,
  className,
  onRowClick,
}: {
  rows: { label: string; count: number }[]
  className?: string
  /** Optional row-click handler (e.g. drill into a client). Adds a11y keyboard support. */
  onRowClick?: (label: string) => void
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No data in window</p>
    )
  }
  return (
    <div className={cn("overflow-hidden rounded-md border border-border", className)}>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
            <th className="w-9 px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Label</th>
            <th className="w-20 px-3 py-2 text-right font-medium">Count</th>
          </tr>
        </thead>
        <Stagger as="tbody" className="divide-y divide-border">
          {rows.map((r, i) => (
            <StaggerItem
              as="tr"
              key={r.label}
              className={cn(
                "transition-colors",
                onRowClick ? "cursor-pointer hover:bg-muted/40" : "hover:bg-muted/30",
              )}
              title={`${r.label} — ${r.count.toLocaleString()}`}
              onClick={onRowClick ? () => onRowClick(r.label) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        onRowClick(r.label)
                      }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? "button" : undefined}
            >
              <td
                className={cn(
                  "px-3 py-2 tabular-nums",
                  i < 3 ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {i + 1}
              </td>
              <td className="px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="block max-w-[240px] truncate font-mono">{r.label}</span>
                  <div
                    className="h-1.5 min-w-[32px] flex-1 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full bg-primary/70 transition-[width] duration-500"
                      style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {r.count.toLocaleString()}
              </td>
            </StaggerItem>
          ))}
        </Stagger>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS (0 errors; the pre-existing `only-export-components` warnings in `Sidebar.tsx` are tolerated).

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/ui.tsx admin-ui/src/components/motion.tsx
git commit -m "feat(ui): clickable ranked-table rows for client drill-down"
```

---

## Task 7: Frontend — GraphPage drill-down integration

**Files:**
- Modify: `admin-ui/src/components/GraphPage.tsx`

**Interfaces:**
- Consumes: `getTopClients`, `getClientBreakdown`, `runClientQuery`, `TopClient`, `ClientBreakdown`, `ClientUrlCount` (Task 4); `RadialDiagram` (Task 5); `RankedTable onRowClick` (Task 6); existing `GRAPH_UI` module handles, `ListActionCell`, `CopyUrlButton`, `ListBadge`, `formatDetected`, `hostOf`
- Produces: focused drill-down mode on the Traffic page.

- [ ] **Step 1: Update imports**

In `admin-ui/src/components/GraphPage.tsx`, replace the import block from `../api` and `./ui` and add `RadialDiagram` + icons:

```tsx
import {
  type ClientBreakdown,
  type ClientUrlCount,
  type FindingsGraph,
  type GraphFlow,
  type GraphNode,
  getBlacklistSet,
  getClientBreakdown,
  getFindingsGraph,
  getTopClients,
  listPatterns,
  type Pattern,
  runClientQuery,
  type TopClient,
} from "../api"
import {
  Button,
  CopyUrlButton,
  EmptyState,
  ListBadge,
  PageHeader,
  Panel,
  RankedTable,
  RefreshIntervalSelect,
  SearchInput,
  Select,
  Skeleton,
  StatCard,
} from "./ui"
```

Also add `X` to the lucide-react import and add the `RadialDiagram` import:

```tsx
import {
  CheckCircle2,
  Link2,
  Network,
  RefreshCcw,
  SearchX,
  Server,
  Users,
  X,
} from "lucide-react"
import { RadialDiagram } from "./RadialDiagram"
```

- [ ] **Step 2: Add module-scope constants + columns + rowId**

After the `LIMIT_OPTIONS` constant, add:

```tsx
const SOURCE_OPTIONS = [
  { value: "findings", label: "Persisted findings" },
  { value: "es", label: "Live ES" },
]

const WINDOW_OPTIONS = [
  { value: "1440", label: "24h" },
  { value: "10080", label: "7d" },
  { value: "43200", label: "30d" },
  { value: "all", label: "All time" },
]

const CAP_OPTIONS = [
  { value: "6", label: "Top 6" },
  { value: "12", label: "Top 12" },
  { value: "24", label: "Top 24" },
]
```

After the `GRAPH_FLOWS_COLUMNS` array, add module-scope columns for the per-client flows table (cells read live state through the existing `GRAPH_UI` handles, same convention as the aggregate table):

```tsx
/** Stable row identity for the per-client flows table. */
function clientUrlRowId(u: ClientUrlCount): string {
  return u.url
}

/* Module-scope columns for the focused per-client flows table — referentially
 * stable so DataTable never re-renders when GraphPage re-renders. */
const GRAPH_CLIENT_COLUMNS: DataTableColumn<ClientUrlCount>[] = [
  {
    id: "url",
    header: "URL",
    accessor: (u) => u.url,
    defaultSortDir: "asc",
    cell: (u) => (
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block max-w-[420px] truncate font-mono text-xs" title={u.url}>
            {u.url}
          </span>
          <CopyUrlButton value={u.url} label="URL" />
        </span>
        {GRAPH_UI.whitelistIndex[u.base_url] ? (
          <ListBadge tone="success" icon={CheckCircle2} title="Already in whitelist">
            whitelist
          </ListBadge>
        ) : GRAPH_UI.blacklistIndex[u.base_url] ? (
          <ListBadge tone="danger" icon={CheckCircle2} title="In blacklist">
            blacklist
          </ListBadge>
        ) : null}
      </div>
    ),
  },
  {
    id: "count",
    header: "Accesses",
    accessor: (u) => u.count,
    defaultSortDir: "desc",
    cell: (u) => <span className="tabular-nums">{u.count.toLocaleString()}</span>,
    align: "right",
    width: "w-24",
  },
  {
    id: "last_seen",
    header: "Last seen",
    accessor: (u) => u.last_seen,
    cell: (u) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatDetected(u.last_seen)}
      </span>
    ),
    width: "w-44",
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    cell: (u) => (
      <ListActionCell baseUrl={u.base_url} onBlacklisted={GRAPH_UI.onBlacklisted} />
    ),
    width: "w-12",
  },
]
```

- [ ] **Step 3: Add drill-down state + refs + fetchers**

Replace the component's state block (after the existing `blacklistIndex` state) with the existing states plus the new ones:

```tsx
  const [whitelistIndex, setWhitelistIndex] = useState<Record<string, true>>({})
  const [blacklistIndex, setBlacklistIndex] = useState<Record<string, true>>({})

  // ── Drill-down state ────────────────────────────────────────────
  const [selectedClient, setSelectedClient] = useState<string | null>(null)
  const [source, setSource] = useState<"findings" | "es">("findings")
  const [windowMinutes, setWindowMinutes] = useState("all")
  const [cap, setCap] = useState("12")
  const [urlSearch, setUrlSearch] = useState("")
  const [urlFilter, setUrlFilter] = useState<string | null>(null)
  const [breakdown, setBreakdown] = useState<ClientBreakdown | null>(null)
  const [breakdownLoading, setBreakdownLoading] = useState(false)
  const [breakdownError, setBreakdownError] = useState<string | null>(null)
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [pickerQuery, setPickerQuery] = useState("")
```

Keep the existing `GRAPH_UI` sync lines. Add a ref for the selected client (used by the auto-refresh tick so the interval closure stays fresh), right after `graphRef`:

```tsx
  const selectedClientRef = useRef<string | null>(null)
  selectedClientRef.current = selectedClient
```

Add the top-clients fetcher + breakdown fetcher after the existing `fetchGraph` callback:

```tsx
  const fetchTopClients = useCallback((query: string) => {
    let cancelled = false
    getTopClients({ search: query.trim() || undefined, limit: 50 })
      .then((data) => {
        if (!cancelled) setTopClients(data.items)
      })
      .catch(() => {
        if (!cancelled) setTopClients([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced picker search — refetch the candidate list as the user types.
  useEffect(() => {
    const id = window.setTimeout(() => fetchTopClients(pickerQuery), 250)
    return () => window.clearTimeout(id)
  }, [pickerQuery, fetchTopClients])

  const fetchBreakdown = useCallback(() => {
    const ip = selectedClientRef.current
    if (!ip) return
    let cancelled = false
    setBreakdownLoading(true)
    setBreakdownError(null)
    const opts = {
      minutes: windowMinutes === "all" ? undefined : Number(windowMinutes),
      search: urlSearch.trim() || undefined,
      limit: Number(cap),
    }
    const call =
      source === "findings"
        ? getClientBreakdown(ip, opts)
        : runClientQuery(ip, opts)
    call
      .then((b) => {
        if (!cancelled) setBreakdown(b)
      })
      .catch((e) => {
        if (!cancelled) {
          setBreakdownError((e as Error).message)
          setBreakdown(null)
        }
      })
      .finally(() => {
        if (!cancelled) setBreakdownLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source, windowMinutes, urlSearch, cap])

  useEffect(() => fetchBreakdown(), [fetchBreakdown])
```

Change the auto-refresh wiring: the existing `const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(fetchGraph, "graph", 0)` should become a single dispatcher that refreshes whichever view is active:

```tsx
  // Live updates: refetch whichever view is active (aggregate graph or the
  // focused per-client breakdown) on an interval.
  const refreshActive = useCallback(() => {
    if (selectedClientRef.current) fetchBreakdown()
    else fetchGraph()
  }, [fetchBreakdown, fetchGraph])
  const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refreshActive, "graph", 0)
```

Add the picker/clear handlers after the blacklist effect:

```tsx
  const selectClient = useCallback((ip: string) => {
    setSelectedClient(ip)
    setPickerQuery("")
    setUrlFilter(null)
  }, [])

  const clearClient = useCallback(() => {
    setSelectedClient(null)
    setUrlFilter(null)
  }, [])
```

- [ ] **Step 4: Render the drill-down picker + focused view**

Replace the whole `return (` block of `GraphPage` with the following (the aggregate sankey/ranked sections are preserved verbatim inside the `else` branch; the header Refresh button and `RefreshIntervalSelect` stay). Note the header `onClick={fetchGraph}` stays — it refreshes the aggregate; the focused view has its own refresh button:

```tsx
  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Traffic"
        description="Flow of flagged URLs being accessed by client IPs (from persisted findings)"
      >
        <Select
          value={limit}
          onChange={setLimit}
          options={LIMIT_OPTIONS}
          className="w-32"
          aria-label="Nodes per layer"
        />
        <RefreshIntervalSelect value={refreshSeconds} onChange={setRefreshSeconds} />
        <Button variant="outline" size="sm" onClick={fetchGraph} disabled={loading}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </PageHeader>

      {selectedClient ? (
        /* ── Focused drill-down mode ─────────────────────────────── */
        <>
          {/* Drill-down bar */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
                <span className="font-mono text-sm font-semibold">{selectedClient}</span>
                {breakdown && (
                  <span className="text-xs text-muted-foreground">
                    {breakdown.total_accesses.toLocaleString()} accesses
                  </span>
                )}
                <button
                  type="button"
                  onClick={clearClient}
                  aria-label="Clear client drill-down"
                  className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
              <Select
                value={source}
                onChange={(v) => setSource(v as "findings" | "es")}
                options={SOURCE_OPTIONS}
                className="w-40"
                aria-label="Data source"
              />
              <Select
                value={windowMinutes}
                onChange={setWindowMinutes}
                options={WINDOW_OPTIONS}
                className="w-28"
                aria-label="Time window"
              />
              <Select
                value={cap}
                onChange={setCap}
                options={CAP_OPTIONS}
                className="w-28"
                aria-label="Top URLs"
              />
              <SearchInput
                value={urlSearch}
                onChange={setUrlSearch}
                placeholder="Filter URL…"
                className="w-48"
                aria-label="Filter by URL substring"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={fetchBreakdown}
                disabled={breakdownLoading}
              >
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
            {breakdown && !breakdown.es_online && (
              <p className="mt-2 text-xs text-destructive">
                Live ES source unavailable — showing last known data.
              </p>
            )}
            {urlFilter && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Filtered to:</span>
                <span className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs">
                  {urlFilter}
                  <button
                    type="button"
                    onClick={() => setUrlFilter(null)}
                    aria-label="Clear URL filter"
                    className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
            )}
          </div>

          {/* Radial visualization */}
          <div className="cv-auto overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold tracking-tight">URL access radial</h3>
              <p className="text-xs text-muted-foreground">
                Hover a URL to highlight its connection; click to filter the table.
              </p>
            </div>
            {breakdownLoading && !breakdown ? (
              <div className="space-y-3 p-4" aria-busy="true">
                <Skeleton className="h-[540px] w-full rounded-lg" />
              </div>
            ) : breakdownError ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
                <SearchX className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm font-medium text-destructive">{breakdownError}</p>
                <Button variant="outline" size="sm" onClick={fetchBreakdown}>
                  Try again
                </Button>
              </div>
            ) : breakdown && breakdown.urls.length > 0 ? (
              <div className="p-4 sm:p-6">
                <RadialDiagram
                  clientIp={breakdown.client_ip}
                  totalAccesses={breakdown.total_accesses}
                  urls={breakdown.urls}
                  onSelectUrl={setUrlFilter}
                  ariaLabel={`URL access radial for ${breakdown.client_ip}`}
                />
              </div>
            ) : (
              <EmptyState
                icon={Network}
                title="No URLs for this client"
                description={
                  breakdown && !breakdown.es_online
                    ? "Live ES is unreachable — no data to graph."
                    : "No flagged URLs match the current filters in this window."
                }
              />
            )}
          </div>

          {/* Per-client flows table */}
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">Access flows</h3>
                <p className="text-xs text-muted-foreground">
                  URLs accessed by {selectedClient}
                  {urlFilter ? ` — filtered to ${urlFilter}` : ""}
                </p>
              </div>
            </div>
            {breakdownLoading && !breakdown ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-48 w-full rounded-lg" />
              </div>
            ) : breakdown && breakdown.urls.length > 0 ? (
              <DataTable
                columns={GRAPH_CLIENT_COLUMNS}
                data={
                  urlFilter
                    ? breakdown.urls.filter((u) => u.url === urlFilter)
                    : breakdown.urls
                }
                rowId={clientUrlRowId}
                internalPagination
                defaultSortBy="count"
                defaultSortDir="desc"
                ariaLabel="Per-client access flows"
              />
            ) : (
              <EmptyState
                icon={Network}
                title="No access flows"
                description="Per-client URL flows appear here once the radial has data."
              />
            )}
          </div>
        </>
      ) : (
        /* ── Aggregate mode (existing view + drill-down picker) ── */
        <>
          {/* Summary chips */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              icon={Network}
              label="Access flows"
              value={(graph?.links.length ?? 0).toLocaleString()}
              tone="info"
              hint="Client → server → URL edges"
            />
            <StatCard
              icon={Users}
              label="Client IPs"
              value={nodeKindCounts.ip.toLocaleString()}
              tone="default"
              hint="Unique clients in window"
            />
            <StatCard
              icon={Server}
              label="Server IPs"
              value={nodeKindCounts.server.toLocaleString()}
              tone="warning"
              hint="Unique servers in window"
            />
            <StatCard
              icon={Link2}
              label="Flagged URLs"
              value={nodeKindCounts.url.toLocaleString()}
              tone="danger"
              hint="URLs matching blocked patterns"
            />
          </div>

          {/* Drill-down picker */}
          <Panel title="Client drill-down" icon={Users}>
            <p className="mb-3 text-xs text-muted-foreground">
              Pick a client IP to see exactly which URLs it accessed, and how often.
            </p>
            <SearchInput
              value={pickerQuery}
              onChange={setPickerQuery}
              placeholder="Search client IP…"
              className="w-full"
              aria-label="Search client IP"
            />
            {pickerQuery.trim() && topClients.length > 0 && (
              <ul className="mt-2 max-h-56 divide-y divide-border overflow-auto rounded-md border border-border bg-popover">
                {topClients.slice(0, 8).map((t) => (
                  <li key={t.client_ip}>
                    <button
                      type="button"
                      onClick={() => selectClient(t.client_ip)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-mono">{t.client_ip}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {t.count.toLocaleString()} accesses
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Visualization: alluvial flow — cv-auto skips the (potentially
              large) sankey panel's paint until it's scrolled into view. */}
          <div className="cv-auto overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">Traffic flow</h3>
                <p className="text-xs text-muted-foreground">
                  Client IPs → server IPs → flagged URLs. Hover a node to highlight its connections.
                </p>
              </div>
              {graph && !graphEmpty && (
                <span className="text-xs text-muted-foreground">
                  {graph.links.length.toLocaleString()} access flow{graph.links.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {loading ? (
              <div className="space-y-3 p-4" aria-busy="true">
                <Skeleton className="h-64 w-full rounded-lg" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
                <SearchX className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm font-medium text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={fetchGraph}>
                  Try again
                </Button>
              </div>
            ) : graphEmpty ? (
              <EmptyState
                icon={Network}
                title="No traffic to graph"
                description="Findings appear here once the ES poll detects matching log entries. The graph maps which client IPs are hitting which flagged URLs."
                action={
                  <Button variant="outline" onClick={fetchGraph}>
                    Refresh
                  </Button>
                }
                className="border-0"
              />
            ) : sankey ? (
              <div className="p-4 sm:p-6">
                <SankeyDiagram
                  nodes={sankey.nodes}
                  links={sankey.links}
                  layerColors={{
                    0: "var(--color-info)",
                    1: "var(--color-warning)",
                    2: "var(--color-danger)",
                  }}
                  ariaLabel="Client to server to URL alluvial flow"
                />
              </div>
            ) : null}
          </div>

          {/* Top rankings — top 10, matching the Query page ranking panels */}
          {graph && graph.nodes.length > 0 && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Panel title="Top URLs" icon={Link2}>
                <RankedTable rows={topRanked.urls.slice(0, 10)} />
              </Panel>
              <Panel title="Top client IPs" icon={Users}>
                <RankedTable rows={topRanked.ips.slice(0, 10)} onRowClick={selectClient} />
              </Panel>
            </div>
          )}

          {/* Per-triple access flows table */}
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">Access flows</h3>
                <p className="text-xs text-muted-foreground">
                  Client → server → URL triples for the flagged URLs shown above
                </p>
              </div>
            </div>
            {loading ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-48 w-full rounded-lg" />
              </div>
            ) : graph && graph.flows.length > 0 ? (
              <DataTable
                columns={GRAPH_FLOWS_COLUMNS}
                data={graph.flows}
                rowId={flowsRowId}
                internalPagination
                defaultSortBy="count"
                defaultSortDir="desc"
                ariaLabel="Access flows"
              />
            ) : (
              <EmptyState
                icon={Network}
                title="No access flows"
                description="Per-triple flows appear here once the graph has traffic data."
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS (0 errors; the pre-existing `only-export-components` warnings are tolerated).

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/GraphPage.tsx
git commit -m "feat(ui): Traffic page per-client URL drill-down mode"
```

---

## Task 8: Final verification

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Full frontend build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 2: Full backend suite + lint**

Run: `timeout 150 .venv/bin/python -m pytest -q && timeout 90 .venv/bin/python -m ruff check app tests`
Expected: all tests pass, ruff clean.

- [ ] **Step 3: No-fake-completion scan**

Run: `git diff --name-only HEAD~8 HEAD | xargs grep -nE "TODO|FIXME|test\.skip|\.only|placeholder" 2>/dev/null | grep -v "input placeholder" || true`
Expected: zero hits in authored code (any `placeholder=` hits must be legitimate input `placeholder` props).

- [ ] **Step 4: Manual UX sanity**

With the backend running (`.venv/bin/python -m uvicorn app.main:app --port 8000` or the repo's run command) and `cd admin-ui && npm run dev`:

1. Traffic page → type part of a client IP in the picker → suggestions appear with counts → click one → the aggregate view is replaced by the radial + focused table.
2. Radial renders the hub (client IP + total) with visible lines to URL satellites and flowing trail dots; hovering a node highlights its edge and dims others; tooltip shows the full URL + count.
3. Click a URL node → the URL chip appears and the flows table narrows to that URL; clear the chip → table restores.
4. Change source to Live ES → radial re-queries (es_online banner when ES is down); change window/cap/substring → radial re-animates.
5. Clear the drill-down → aggregate sankey view returns.
6. With OS `prefers-reduced-motion` ON: no trail dots, no animation, everything instant; with it OFF: entrance pop-in + flowing trails.
7. Type in the picker → the aggregate table does not re-sort per keystroke.

- [ ] **Step 5: Report**

Summarize the three new endpoints (top-clients, client/{ip}, query/client), the RadialDiagram (deterministic circular layout, animated trail overlay, adjacency hover, click-to-filter), the drill-down bar filters, and verification results.
