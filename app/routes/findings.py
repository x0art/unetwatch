import re

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from app.database import get_db_conn
from app.services.monitor import _build_pattern_regex

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
    """
    cursor = await db.execute(
        """
        SELECT client_ip, server_ip, url, base_url, COUNT(*) AS count,
               MAX(log_timestamp) AS last_seen
        FROM findings
        WHERE client_ip != '' AND url != ''
        GROUP BY client_ip, server_ip, url, base_url
        """
    )
    wl_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'whitelist'"
    )
    wl_rows = await wl_cursor.fetchall()
    # Same glob semantics as the monitor: `*`/`?` act as wildcards, everything
    # else is matched literally (case-insensitive).
    whitelist_regex = _build_pattern_regex([r[0] for r in wl_rows])
    if whitelist_regex:
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
