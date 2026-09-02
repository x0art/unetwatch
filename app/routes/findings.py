import re

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from app.database import get_db_conn
from app.services.monitor import _build_pattern_regex, _whitelist_sql_clauses

router = APIRouter(prefix="/api/findings", tags=["findings"])


@router.get("/graph")
async def findings_graph(
    db=Depends(get_db_conn),
    limit: int = Query(30, ge=1, le=200),
):
    """Return IP → server → URL flow data derived from persisted findings.

    Nodes are client IPs, server IPs and flagged URLs; links are the
    aggregated access relationships (client → server → URL). `limit` caps
    the number of top client IPs and top URLs included per layer so the
    graph stays readable.

    Findings whose URL or base_url matches an active whitelist pattern are
    excluded so the graph never shows whitelisted destinations (defends
    against legacy findings captured before the user whitelisted a URL).
    Simple glob patterns (`*`/`?` only) are pushed into the SQL ``NOT LIKE``
    clauses so the scan is filtered before rows are materialized; anything
    not SQL-expressible still goes through the pure-Python ``re.search``
    fallback below. The grouped query is bounded with a LIMIT so a large
    findings table can't build an unbounded result set.
    """
    wl_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'whitelist'"
    )
    wl_rows = await wl_cursor.fetchall()
    whitelist_patterns = [r[0] for r in wl_rows]
    # Same glob semantics as the monitor: `*`/`?` act as wildcards, everything
    # else is matched literally (case-insensitive).
    whitelist_regex = _build_pattern_regex(whitelist_patterns)
    sql_clauses = _whitelist_sql_clauses(whitelist_patterns)

    where = ["client_ip != '' AND url != ''", *sql_clauses]
    cursor = await db.execute(
        f"""
        SELECT client_ip, server_ip, url, base_url, COUNT(*) AS count,
               MAX(log_timestamp) AS last_seen
        FROM findings
        WHERE {' AND '.join(where)}
        GROUP BY client_ip, server_ip, url, base_url
        LIMIT 5000
        """
    )
    if whitelist_regex:
        # Pure-Python fallback catches patterns that couldn't be expressed in
        # SQL (regex meta chars, whitespace, `%`) plus any row that slipped
        # through the LIKE clauses.
        rows = [
            r
            for r in await cursor.fetchall()
            if not (
                re.search(whitelist_regex, str(r["url"]), re.IGNORECASE)
                or re.search(whitelist_regex, str(r["base_url"]), re.IGNORECASE)
            )
        ]
    else:
        rows = await cursor.fetchall()

    ip_total: dict[str, int] = {}
    url_total: dict[str, int] = {}
    server_total: dict[str, int] = {}
    for r in rows:
        ip_total[r["client_ip"]] = ip_total.get(r["client_ip"], 0) + r["count"]
        url_total[r["url"]] = url_total.get(r["url"], 0) + r["count"]
        if r["server_ip"]:
            server_total[r["server_ip"]] = (
                server_total.get(r["server_ip"], 0) + r["count"]
            )

    top_ips = [
        ip for ip, _ in sorted(
            ip_total.items(), key=lambda kv: (-kv[1], kv[0])
        )[:limit]
    ]
    top_urls = [
        url for url, _ in sorted(
            url_total.items(), key=lambda kv: (-kv[1], kv[0])
        )[:limit]
    ]

    # Links are only created between nodes that made the per-layer cut, so
    # every node in the response is guaranteed at least one edge (no
    # disconnected "dangling" server nodes).
    ip_server: dict[tuple[str, str], int] = {}
    server_url: dict[tuple[str, str], int] = {}
    ip_url: dict[tuple[str, str], int] = {}
    servers: set[str] = set()
    for r in rows:
        ip, server, url = r["client_ip"], r["server_ip"], r["url"]
        if ip not in top_ips or url not in top_urls:
            continue
        if server:
            key = (ip, server)
            ip_server[key] = ip_server.get(key, 0) + r["count"]
            key2 = (server, url)
            server_url[key2] = server_url.get(key2, 0) + r["count"]
            servers.add(server)
        else:
            key = (ip, url)
            ip_url[key] = ip_url.get(key, 0) + r["count"]

    nodes = (
        [
            {"id": f"ip:{ip}", "label": ip, "kind": "ip", "count": ip_total[ip]}
            for ip in top_ips
        ]
        + [
            {
                "id": f"server:{s}",
                "label": s,
                "kind": "server",
                "count": server_total[s],
            }
            for s in sorted(servers)
        ]
        + [
            {
                "id": f"url:{u}",
                "label": u,
                "kind": "url",
                "count": url_total[u],
            }
            for u in top_urls
        ]
    )
    links = (
        [
            {"source": f"ip:{a}", "target": f"server:{b}", "count": c}
            for (a, b), c in ip_server.items()
        ]
        + [
            {"source": f"server:{a}", "target": f"url:{b}", "count": c}
            for (a, b), c in server_url.items()
        ]
        + [
            {"source": f"ip:{a}", "target": f"url:{b}", "count": c}
            for (a, b), c in ip_url.items()
        ]
    )
    # Per-triple flows for the Traffic page table — same top-N cut as the
    # graph nodes so the table always matches what the visualization shows.
    flows = [
        {
            "client_ip": r["client_ip"],
            "server_ip": r["server_ip"] or "",
            "url": r["url"],
            "base_url": r["base_url"],
            "count": r["count"],
            "last_seen": r["last_seen"],
        }
        for r in rows
        if r["client_ip"] in top_ips and r["url"] in top_urls
    ]
    flows.sort(key=lambda f: -f["count"])
    return {"nodes": nodes, "links": links, "flows": flows}


def _whitelist_fully_sql(patterns: list[str], sql_clauses: list[str]) -> bool:
    """True when every non-empty whitelist pattern produced a SQL clause.

    ``_whitelist_sql_clauses`` only emits clauses for patterns composed of
    literals + ``*``/``?``. If any pattern fell through (regex meta chars,
    whitespace, no wildcards at all) the caller must use the row-level Python
    fallback, since a grouped-by-client_ip query loses the url/base_url the
    regex needs.
    """
    return len([p for p in map(str.strip, patterns) if p]) == len(sql_clauses)


@router.get("/url/{url:path}")
async def url_breakdown(
    url: str,
    db=Depends(get_db_conn),
    minutes: int | None = Query(None, ge=0, le=43200),
    limit: int = Query(50, ge=1, le=200),
):
    """Per-URL client IP breakdown — reverse of client_breakdown.

    Returns all client IPs that accessed the given URL (or base_url),
    with counts and last-seen timestamps. Used by the Traffic page's
    URL drill-down mode.
    """
    wl_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'whitelist'"
    )
    wl_rows = await wl_cursor.fetchall()
    whitelist_patterns = [r[0] for r in wl_rows]
    whitelist_regex = _build_pattern_regex(whitelist_patterns)
    sql_clauses = _whitelist_sql_clauses(whitelist_patterns)

    # Match on both the exact URL and the base_url (host) so clicking a
    # host-level node in the graph finds all IPs that hit any path on it.
    where = ["(url = ? OR base_url = ?)", *sql_clauses]
    params: list = [url, url]
    if minutes:
        where.append("log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
        params.append(f"-{minutes} minutes")
    clause = f"WHERE {' AND '.join(where)}"

    needs_python_fallback = bool(whitelist_regex) and not _whitelist_fully_sql(
        whitelist_patterns, sql_clauses
    )
    if needs_python_fallback:
        cursor = await db.execute(
            f"""
            SELECT client_ip, COUNT(*) AS count, MAX(log_timestamp) AS last_seen
            FROM findings
            {clause}
            GROUP BY client_ip
            ORDER BY count DESC, client_ip
            """,
            params,
        )
        rows = [
            dict(r)
            for r in await cursor.fetchall()
            if not (
                re.search(whitelist_regex, url, re.IGNORECASE)
            )
        ]
        return {
            "url": url,
            "source": "findings",
            "total_accesses": sum(r["count"] for r in rows),
            "es_online": True,
            "clients": rows[:limit],
        }

    cursor = await db.execute(
        f"""
        SELECT client_ip, COUNT(*) AS count, MAX(log_timestamp) AS last_seen
        FROM findings
        {clause}
        GROUP BY client_ip
        ORDER BY count DESC, client_ip
        LIMIT ?
        """,
        (*params, limit),
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    total_cursor = await db.execute(
        f"SELECT COUNT(*) AS total FROM findings {clause}", params
    )
    total = (await total_cursor.fetchone())["total"]
    return {
        "url": url,
        "source": "findings",
        "total_accesses": total,
        "es_online": True,
        "clients": rows,
    }


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


@router.get("/client/{ip}")
async def client_breakdown(
    ip: str,
    db=Depends(get_db_conn),
    minutes: int | None = Query(None, ge=0, le=43200),
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

    # When any whitelist pattern fell through to the Python fallback, the
    # grouped rows are the only place the regex can be applied — the total
    # must be summed from the filtered groups (a COUNT over the SQL WHERE
    # would silently include whitelisted rows).
    needs_python_fallback = bool(whitelist_regex) and not _whitelist_fully_sql(
        whitelist_patterns, sql_clauses
    )
    if needs_python_fallback:
        cursor = await db.execute(
            f"""
            SELECT url, base_url, COUNT(*) AS count, MAX(log_timestamp) AS last_seen
            FROM findings
            {clause}
            GROUP BY url, base_url
            ORDER BY count DESC, url
            """,
            params,
        )
        rows = [
            dict(r)
            for r in await cursor.fetchall()
            if not (
                re.search(whitelist_regex, str(r["url"]), re.IGNORECASE)
                or re.search(whitelist_regex, str(r["base_url"]), re.IGNORECASE)
            )
        ]
        return {
            "client_ip": ip,
            "source": "findings",
            "total_accesses": sum(r["count"] for r in rows),
            "es_online": True,
            "urls": rows[:limit],
        }

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
        # Belt-and-braces for rows that slipped through the LIKE clauses.
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


@router.delete("/", status_code=204)
async def clear_findings(db=Depends(get_db_conn)):
    """Delete every persisted finding (admin reset of the findings table)."""
    await db.execute("DELETE FROM findings")
    await db.commit()


@router.post("/bulk-delete")
async def bulk_delete_findings(
    ids: list[int] = Body(..., embed=True),
    db=Depends(get_db_conn),
):
    """Delete the given findings by id, returning how many rows were removed."""
    if not ids:
        raise HTTPException(422, "At least one id is required")
    placeholders = ",".join("?" * len(ids))
    cursor = await db.execute(
        f"DELETE FROM findings WHERE id IN ({placeholders})", ids
    )
    await db.commit()
    return {"deleted": cursor.rowcount}


@router.delete("/{finding_id}", status_code=204)
async def delete_finding(finding_id: int, db=Depends(get_db_conn)):
    """Delete a single finding by id."""
    cursor = await db.execute("DELETE FROM findings WHERE id = ?", (finding_id,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(404, "Finding not found")


@router.get("/")
async def list_findings(
    db=Depends(get_db_conn),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List persisted findings, newest first, with total count for pagination."""
    where = []
    params: list = []
    if search:
        where.append(
            "(client_ip LIKE ? OR server_ip LIKE ? OR url LIKE ? OR base_url LIKE ?)"
        )
        params.extend([f"%{search}%"] * 4)

    clause = f"WHERE {' AND '.join(where)}" if where else ""

    count_cursor = await db.execute(
        f"SELECT COUNT(*) as total FROM findings {clause}", params
    )
    total = (await count_cursor.fetchone())["total"]

    cursor = await db.execute(
        f"SELECT * FROM findings {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return {"items": [dict(r) for r in rows], "total": total}
