"""Client IP Report — per-client analytics from findings (findings-only).

Findings-scoped sibling to analytics.py: every aggregation is
``WHERE client_ip = ?`` plus the optional window clause and the same
whitelist exclusion (SQL NOT LIKE + Python regex belt-and-braces).
No live ES path — the report is deterministic and exportable from the
persisted findings that also feed Findings/Analytics raw tables.

ADR 0001 applies verbatim: risk = ALLOW block-pattern hit not
whitelisted; enforcements = DENY/FLAG explicitly.

Endpoints:
  GET /api/client-report/{client_ip}?range=24h
  GET /api/client-report/{client_ip}/findings?range=&search=&limit=&offset=&sort_by=&sort_order=
  GET /api/client-report/{client_ip}/export.csv?range=
"""

import csv
import io
import json
import re
from collections import Counter
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from fastapi import HTTPException as FastAPIHTTPException
from fastapi.responses import PlainTextResponse

from app.database import get_db_conn

router = APIRouter(prefix="/api/client-report", tags=["client-report"])

SUPPORTED_RANGES = {"1h", "24h", "7d", "30d"}
DEFAULT_BYTES_PER_REQUEST = 8192


def _minutes_for_range(range_: str) -> int:
    return {"1h": 60, "24h": 1440, "7d": 10080, "30d": 43200}[range_]


def _validate_range(range_: str) -> str:
    if range_ not in SUPPORTED_RANGES:
        raise FastAPIHTTPException(422, f"range must be one of {sorted(SUPPORTED_RANGES)}")
    return range_


def _window_clause(minutes: int, params: list) -> str:
    if minutes > 0:
        params.append(f"-{minutes} minutes")
        return " AND log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
    return ""


async def _column_names(db) -> list[str]:
    cursor = await db.execute("PRAGMA table_info(findings)")
    return [row["name"] for row in await cursor.fetchall()]


def _has_column(columns: list[str], name: str) -> bool:
    return name in columns


def _parse_matched_patterns(raw) -> list:
    try:
        return json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        return []


def _primary_rule(matched_patterns: str | None) -> str:
    pats = _parse_matched_patterns(matched_patterns)
    if isinstance(pats, list) and pats:
        return str(pats[0])
    return "matched"


def _row_is_enforced(row: dict, has_action: bool) -> bool:
    action = (row.get("action") or "").strip().upper()
    if has_action and action:
        return action in ("DENY", "FLAG")
    return False


def _row_is_risk(row: dict, has_action: bool) -> bool:
    if _row_is_enforced(row, has_action):
        return False
    action = (row.get("action") or "").strip().upper()
    if has_action and action:
        return action == "ALLOW"
    return bool(_parse_matched_patterns(row.get("matched_patterns")))


def _domain_of_base(base_url: str) -> str:
    m = re.match(r"^(?:https?://)?([^/]+)", base_url or "")
    host = m.group(1) if m else (base_url or "unknown")
    host = re.sub(r":\d+$", "", host)
    return host or "unknown"


def _volume_for_bytes(rows: list[dict], has_duration: bool) -> int:
    total = 0
    for r in rows:
        dn = r.get("bytes_downloaded")
        up = r.get("bytes_uploaded")
        try:
            if dn not in (None, "") or up not in (None, ""):
                total += int(dn or 0) + int(up or 0)
                continue
        except (TypeError, ValueError):
            pass
        if has_duration:
            dur = r.get("duration_seconds") or 0
            try:
                total += max(1, int(dur)) * DEFAULT_BYTES_PER_REQUEST
            except (TypeError, ValueError):
                total += DEFAULT_BYTES_PER_REQUEST
        else:
            total += DEFAULT_BYTES_PER_REQUEST
    return total


def _fmt_peak(ts: str) -> str:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts
    weekday = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[dt.weekday()]
    return f"{weekday} {dt.strftime('%H:%M')} EST"


def _whitelist_fully_sql(patterns: list[str], sql_clauses: list[str]) -> bool:
    return len([p for p in map(str.strip, patterns) if p]) == len(sql_clauses)


def _validate_ip(client_ip: str) -> str:
    ip = client_ip.strip()
    if not ip:
        raise FastAPIHTTPException(422, "client_ip is required")
    if len(ip) > 64:
        raise FastAPIHTTPException(422, "client_ip too long (max 64)")
    return ip


# ── Data helpers ───────────────────────────────────────────────────────

ALLOWED_SORT = {"id", "log_timestamp", "url", "base_url", "action", "duration_seconds"}


async def _load_whitelist(db):
    from app.services.monitor import _build_pattern_regex, _whitelist_sql_clauses

    wl_cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type = 'whitelist'"
    )
    wl_rows = await wl_cursor.fetchall()
    patterns = [r[0] for r in wl_rows]
    regex = _build_pattern_regex(patterns)
    clauses = _whitelist_sql_clauses(patterns)
    return patterns, regex, clauses


async def _fetch_client_rows(db, client_ip: str, minutes: int, patterns, regex: str, clauses: list[str]):
    """Fetch all findings rows for the client+window, post-filtering
    whitelisted rows that couldn't be expressed in SQL."""
    where_parts = ["client_ip = ?"]
    params: list = [client_ip]
    for c in clauses:
        where_parts.append(c)
    where_parts.append(f"1=1{_window_clause(minutes, params)}")
    clause = f"WHERE {' AND '.join(where_parts)}"

    fully_sql = _whitelist_fully_sql(patterns, clauses)
    # When whitelist has non-SQL-expressible patterns, we must fetch and
    # re-filter in Python (url/base_url needed per row). Cap matches the
    # analytics findings paths.
    needs_py = bool(regex) and not fully_sql
    if needs_py:
        cursor = await db.execute(f"SELECT * FROM findings {clause} LIMIT 20000", params)
        rows = [dict(r) for r in await cursor.fetchall()]
        rows = [
            r for r in rows
            if not (
                re.search(regex, str(r.get("url") or ""), re.IGNORECASE)
                or re.search(regex, str(r.get("base_url") or ""), re.IGNORECASE)
            )
        ]
        return rows
    cursor = await db.execute(f"SELECT * FROM findings {clause} LIMIT 20000", params)
    rows = [dict(r) for r in await cursor.fetchall()]
    if regex:
        rows = [
            r for r in rows
            if not (
                re.search(regex, str(r.get("url") or ""), re.IGNORECASE)
                or re.search(regex, str(r.get("base_url") or ""), re.IGNORECASE)
            )
        ]
    return rows


def _build_report_payload(client_ip: str, range_: str, minutes: int, rows: list[dict], columns: list[str]) -> dict:
    has_duration = _has_column(columns, "duration_seconds")
    has_action = _has_column(columns, "action")
    has_data = len(rows) > 0

    total_requests = len(rows)
    total_risk = sum(1 for r in rows if _row_is_risk(r, has_action))
    total_enforcements = sum(1 for r in rows if _row_is_enforced(r, has_action))
    total_volume = _volume_for_bytes(rows, has_duration) if rows else 0
    distinct_urls = len({r.get("url") for r in rows}) if rows else 0
    distinct_domains = len({_domain_of_base(r.get("base_url") or "") for r in rows}) if rows else 0

    # Top domain / pattern (most frequent)
    top_domain = None
    top_pattern = None
    if rows:
        dom_counts: dict[str, int] = {}
        for r in rows:
            d = _domain_of_base(r.get("base_url") or "")
            dom_counts[d] = dom_counts.get(d, 0) + 1
        top_domain = max(dom_counts, key=dom_counts.get) if dom_counts else None

        pat_counts: dict[str, int] = {}
        for r in rows:
            for pat in _parse_matched_patterns(r.get("matched_patterns")) or []:
                pat_counts[str(pat)] = pat_counts.get(str(pat), 0) + 1
        if not pat_counts:
            # fallback to primary rule scan
            for r in rows:
                pr = _primary_rule(r.get("matched_patterns"))
                if pr != "matched":
                    pat_counts[pr] = pat_counts.get(pr, 0) + 1
        top_pattern = max(pat_counts, key=pat_counts.get) if pat_counts else None

    # Peak hour
    peak_hour = ""
    if rows:
        by_hour: dict[str, int] = {}
        by_hour_raw: dict[str, str] = {}
        for r in rows:
            ts = r.get("log_timestamp") or ""
            if len(ts) >= 13:
                k = ts[:13] + ":00:00"
                by_hour[k] = by_hour.get(k, 0) + 1
                by_hour_raw[k] = k
        if by_hour:
            peak_ts = max(by_hour, key=by_hour.get)
            peak_hour = _fmt_peak(peak_ts)

    # Daily buckets — bandwidth (inbound=bytes_downloaded, outbound=bytes_uploaded)
    bandwidth_points: list[dict] = []
    enforcement_points: list[dict] = []
    if rows:
        bw_buckets: dict[str, dict] = {}
        enf_buckets: dict[str, dict] = {}
        for r in rows:
            day = (r.get("log_timestamp") or "")[:10]
            if not day:
                continue
            b = bw_buckets.setdefault(day, {"bucket": day, "inbound": 0, "outbound": 0})
            dn = r.get("bytes_downloaded")
            up = r.get("bytes_uploaded")
            try:
                has_bytes = dn not in (None, "") or up not in (None, "")
                if has_bytes:
                    if dn not in (None, ""):
                        b["inbound"] += int(dn)
                    if up not in (None, ""):
                        b["outbound"] += int(up)
                else:
                    if has_duration:
                        dur = r.get("duration_seconds") or 0
                        try:
                            b["outbound"] += max(1, int(dur)) * DEFAULT_BYTES_PER_REQUEST
                        except (TypeError, ValueError):
                            b["outbound"] += DEFAULT_BYTES_PER_REQUEST
                    else:
                        b["outbound"] += DEFAULT_BYTES_PER_REQUEST
            except (TypeError, ValueError):
                b["outbound"] += DEFAULT_BYTES_PER_REQUEST

            e = enf_buckets.setdefault(day, {"bucket": day, "allow": 0, "deny": 0})
            if _row_is_enforced(r, has_action):
                e["deny"] += 1
            else:
                e["allow"] += 1
        bandwidth_points = sorted(bw_buckets.values(), key=lambda x: x["bucket"])
        enforcement_points = sorted(enf_buckets.values(), key=lambda x: x["bucket"])

    # Top aggregations
    top_domains: list[dict] = []
    top_urls: list[dict] = []
    top_patterns: list[dict] = []
    if rows:
        by_domain: dict[str, dict] = {}
        for r in rows:
            domain = _domain_of_base(r.get("base_url") or "")
            entry = by_domain.setdefault(domain, {"count": 0, "volume": 0})
            entry["count"] += 1
            dn = r.get("bytes_downloaded")
            up = r.get("bytes_uploaded")
            try:
                if dn not in (None, "") or up not in (None, ""):
                    entry["volume"] += int(dn or 0) + int(up or 0)
                    continue
            except (TypeError, ValueError):
                pass
            if has_duration:
                dur = r.get("duration_seconds") or 0
                try:
                    entry["volume"] += max(1, int(dur)) * DEFAULT_BYTES_PER_REQUEST
                except (TypeError, ValueError):
                    entry["volume"] += DEFAULT_BYTES_PER_REQUEST
            else:
                entry["volume"] += DEFAULT_BYTES_PER_REQUEST
        total_vol = sum(d["volume"] for d in by_domain.values()) or 1
        top_domains = [
            {"domain": d, "count": v["count"], "volume": v["volume"], "pct": round((v["volume"] / total_vol) * 100, 1)}
            for d, v in sorted(by_domain.items(), key=lambda kv: (-kv[1]["volume"], kv[0]))
        ][:10]

        # Top URLs (by full url, with base_url + last_seen)
        url_counts: dict[str, dict] = {}
        for r in rows:
            url = r.get("url") or ""
            e = url_counts.setdefault(url, {"count": 0, "base_url": r.get("base_url") or "", "last_seen": ""})
            e["count"] += 1
            ts = r.get("log_timestamp") or ""
            if ts > e["last_seen"]:
                e["last_seen"] = ts
                e["base_url"] = r.get("base_url") or e["base_url"]
        top_urls = [
            {"url": u, "base_url": v["base_url"], "count": v["count"], "last_seen": v["last_seen"]}
            for u, v in sorted(url_counts.items(), key=lambda kv: (-kv[1]["count"], kv[0]))
        ][:10]

        # Top patterns
        pat_counter: Counter = Counter()
        for r in rows:
            for pat in _parse_matched_patterns(r.get("matched_patterns")) or []:
                pat_counter[str(pat)] += 1
        if pat_counter:
            top_patterns = [{"pattern": p, "hits": c} for p, c in pat_counter.most_common(10)]
        else:
            # Derive from primary rule if matched_patterns is not populated
            pr_counter: Counter = Counter()
            for r in rows:
                pr = _primary_rule(r.get("matched_patterns"))
                pr_counter[pr] += 1
            if pr_counter:
                top_patterns = [{"pattern": p, "hits": c} for p, c in pr_counter.most_common(10) if p != "matched"]

    return {
        "client_ip": client_ip,
        "range": range_,
        "window_minutes": minutes,
        "has_data": has_data,
        "source": "findings",
        "es_online": False,
        "generated_at": datetime.now(UTC).isoformat(),
        "total_requests": total_requests,
        "total_risk": total_risk,
        "total_enforcements": total_enforcements,
        "total_volume": total_volume,
        "distinct_urls": distinct_urls,
        "distinct_domains": distinct_domains,
        "top_pattern": top_pattern,
        "top_domain": top_domain,
        "peak_hour": peak_hour,
        "bandwidth": {"points": bandwidth_points},
        "enforcements": {"points": enforcement_points},
        "top_domains": top_domains,
        "top_urls": top_urls,
        "top_patterns": top_patterns,
    }


# ── Routes ───────────────────────────────────────────────────────────────

@router.get("/{client_ip}")
async def client_report(
    client_ip: str,
    range: str = Query("24h", alias="range"),
    db=Depends(get_db_conn),
):
    _validate_range(range)
    ip = _validate_ip(client_ip)
    minutes = _minutes_for_range(range)
    columns = await _column_names(db)
    patterns, regex, clauses = await _load_whitelist(db)
    rows = await _fetch_client_rows(db, ip, minutes, patterns, regex, clauses)
    return _build_report_payload(ip, range, minutes, rows, columns)


@router.get("/{client_ip}/findings")
async def client_report_findings(
    client_ip: str,
    range: str = Query("24h", alias="range"),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("log_timestamp"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
    db=Depends(get_db_conn),
):
    _validate_range(range)
    ip = _validate_ip(client_ip)
    minutes = _minutes_for_range(range)
    if sort_by not in ALLOWED_SORT:
        sort_by = "log_timestamp"
    direction = "ASC" if sort_order == "asc" else "DESC"

    patterns, regex, clauses = await _load_whitelist(db)
    # Fetch full window rows, whitelist-filtered
    rows = await _fetch_client_rows(db, ip, minutes, patterns, regex, clauses)
    # search filter (client-side; small set — bounded by LIMIT 20000 above)
    if search:
        q = search.strip().lower()
        rows = [r for r in rows if q in str(r.get("url") or "").lower() or q in str(r.get("base_url") or "").lower() or q in str(r.get("client_ip") or "").lower()]
    # sort
    reverse = sort_order == "desc"
    rows.sort(key=lambda r: str(r.get(sort_by) or ""), reverse=reverse)
    total = len(rows)
    page = rows[offset: offset + limit]
    return {"items": page, "total": total}


@router.get("/{client_ip}/export.csv")
async def client_report_export_csv(
    client_ip: str,
    range: str = Query("24h", alias="range"),
    db=Depends(get_db_conn),
):
    _validate_range(range)
    ip = _validate_ip(client_ip)
    minutes = _minutes_for_range(range)
    columns = await _column_names(db)
    has_duration = _has_column(columns, "duration_seconds")
    patterns, regex, clauses = await _load_whitelist(db)
    rows = await _fetch_client_rows(db, ip, minutes, patterns, regex, clauses)
    payload = _build_report_payload(ip, range, minutes, rows, columns)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Client Report — uNetWatch"])
    w.writerow(["client_ip", payload["client_ip"]])
    w.writerow(["range", payload["range"]])
    w.writerow(["generated_at", payload["generated_at"]])
    w.writerow(["source", payload["source"]])
    w.writerow([])
    w.writerow(["Metric", "Value"])
    w.writerow(["Total requests", payload["total_requests"]])
    w.writerow(["Risks (ALLOW)", payload["total_risk"]])
    w.writerow(["Enforcements (DENY)", payload["total_enforcements"]])
    w.writerow(["Total volume (bytes)", payload["total_volume"]])
    w.writerow(["Distinct URLs", payload["distinct_urls"]])
    w.writerow(["Distinct domains", payload["distinct_domains"]])
    w.writerow(["Top pattern", payload["top_pattern"] or ""])
    w.writerow(["Top domain", payload["top_domain"] or ""])
    w.writerow(["Peak hour", payload["peak_hour"] or ""])
    w.writerow([])
    w.writerow(["Daily Bandwidth (bytes)"])
    w.writerow(["bucket", "inbound", "outbound"])
    for p in payload["bandwidth"]["points"]:
        w.writerow([p["bucket"], p["inbound"], p["outbound"]])
    w.writerow([])
    w.writerow(["Daily Enforcements"])
    w.writerow(["bucket", "allow", "deny"])
    for p in payload["enforcements"]["points"]:
        w.writerow([p["bucket"], p["allow"], p["deny"]])
    w.writerow([])
    w.writerow(["Top Domains"])
    w.writerow(["domain", "count", "volume_bytes", "pct"])
    for td in payload["top_domains"]:
        w.writerow([td["domain"], td["count"], td["volume"], td["pct"]])
    w.writerow([])
    w.writerow(["Top Patterns"])
    w.writerow(["pattern", "hits"])
    for tp in payload["top_patterns"]:
        w.writerow([tp["pattern"], tp["hits"]])
    w.writerow([])
    w.writerow(["Top URLs"])
    w.writerow(["url", "base_url", "count", "last_seen"])
    for tu in payload["top_urls"]:
        w.writerow([tu["url"], tu["base_url"], tu["count"], tu["last_seen"]])
    w.writerow([])
    w.writerow(["Raw Findings"])
    w.writerow(["log_timestamp", "client_ip", "server_ip", "url", "base_url", "action", "category", "bytes_down", "bytes_up", "duration_seconds", "rule"])
    for r in rows:
        w.writerow([
            r.get("log_timestamp") or "",
            r.get("client_ip") or "",
            r.get("server_ip") or "",
            r.get("url") or "",
            r.get("base_url") or "",
            r.get("action") or "",
            r.get("category") or "",
            r.get("bytes_downloaded") or 0,
            r.get("bytes_uploaded") or 0,
            r.get("duration_seconds") or 0,
            (r.get("rule_name") or r.get("rule_info") or ""),
        ])
    csv_text = buf.getvalue()
    headers = {"Content-Disposition": f"attachment; filename=client-{ip}-{range}-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.csv"}
    return PlainTextResponse(csv_text, media_type="text/csv", headers=headers)
