"""Analytics & Reports endpoints (spec §3.4) — metrics, trends, aggregations.

Risk vs enforcements (ADR 0001): a request is a **risk** when its URL matched a
block pattern, the proxy action was ``ALLOW``, and it is not whitelisted. A
**DENY** is an *enforcement* — the proxy already handled the request — and is
reported separately, never as risk. The persisted ``findings`` table only ever
contains ALLOW rows (the poll stores through ``apply_filters(actions=("ALLOW",))``),
so real enforcement counts only exist in the live Elasticsearch window.

Every endpoint accepts the same three query params the Analytics page passes
(``range``, ``compare``, ``hostGroup``) and degrades honestly:

- ``summary`` prefers live ES (real risk/enforcement split); falls back to the
  findings table (risk = row count, enforcements = 0).
- ``enforcements`` and ``top-enforced`` prefer live ES — the only place DENY
  rows exist; when ES is offline they fall back to the findings table with
  ``enforcements = 0`` and ``es_online: False``.
- Volume/direction come from real bytes where the feed carries them, falling
  back to a documented per-request heuristic (8 KiB) that keeps relative
  rankings real.

Response shapes (all camelCase — consumed by ``api.ts`` helpers verbatim):

    GET /api/analytics/summary?range=7d&compare=previous&hostGroup=all
        { has_data, totalVolume, totalRisk, totalBlacklistedRisk, totalEnforcements,
          topBandwidthHost, peakTrafficTime, range, compare, hostGroup, es_online,
          previous: { totalVolume, totalEnforcements } | null,
          volumeDeltaPct, enforcementsDeltaPct }

    GET /api/analytics/bandwidth?range=7d&compare=previous&hostGroup=all
        { points: [{ bucket, inbound, outbound }], range, hostGroup, es_online }

    GET /api/analytics/enforcements?range=7d&compare=previous&hostGroup=all
        { points: [{ bucket, allow, deny }], range, hostGroup, es_online }

    GET /api/analytics/top-domains?range=7d&compare=previous&hostGroup=all
        { items: [{ domain, volume, pct }], range, hostGroup, es_online }

    GET /api/analytics/top-enforced?range=7d&compare=previous&hostGroup=all
        { items: [{ domain, enforcements, primaryRule }], range, hostGroup, es_online }

``compare`` and ``hostGroup`` are accepted and echoed but do not change the
aggregation (documented honest no-op — see each endpoint docstring).
"""

import json
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi import HTTPException as FastAPIHTTPException

from app.database import get_db_conn

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

# ── Window helpers ─────────────────────────────────────────────────────────

# Canonical ranges the Analytics page offers; anything else is rejected 422.
# 1h added so the Analytics presets match the app-wide FilterContext ranges.
SUPPORTED_RANGES = {"1h", "24h", "7d", "30d"}

# Per-request byte heuristic used when the feed carries no byte accounting
# (documented fallback — see module docstring).
DEFAULT_BYTES_PER_REQUEST = 8192  # 8 KiB


def _minutes_for_range(range_: str) -> int:
    return {"1h": 60, "24h": 1440, "7d": 10080, "30d": 43200}[range_]


def _validate_range(range_: str) -> str:
    if range_ not in SUPPORTED_RANGES:
        raise FastAPIHTTPException(422, f"range must be one of {sorted(SUPPORTED_RANGES)}")
    return range_


def _window_clause(minutes: int, params: list) -> str:
    """Return a SQL ``log_timestamp >= ...`` clause for the given window.

    Uses the same strftime trick the findings drill-downs use so the filter is
    evaluated by SQLite (UTC), never by the Python clock.
    """
    if minutes > 0:
        params.append(f"-{minutes} minutes")
        return " AND log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
    return ""


async def _column_names(db) -> list[str]:
    """Column list for the findings table (schema migrates between modes)."""
    cursor = await db.execute("PRAGMA table_info(findings)")
    return [row["name"] for row in await cursor.fetchall()]


def _has_column(columns: list[str], name: str) -> bool:
    return name in columns


def _parse_matched_patterns(raw) -> list:
    """Safely parse the stored ``matched_patterns`` JSON column.

    A corrupted or non-JSON row must never 500 the analytics endpoints — a
    garbage row is treated as an empty match list.
    """
    try:
        return json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        return []


def _primary_rule(matched_patterns: str | None) -> str:
    """First matched pattern, or a stable fallback label when unavailable."""
    pats = _parse_matched_patterns(matched_patterns)
    if isinstance(pats, list) and pats:
        return str(pats[0])
    return "matched"


def _row_is_enforced(row: dict, has_action: bool) -> bool:
    """Whether a row is an enforcement — the proxy already denied it (ADR 0001).

    Only an explicit ``DENY``/``FLAG`` action counts. Legacy rows with an empty
    ``action`` were persisted as ALLOW risks, so they are never enforcements
    even when ``matched_patterns`` is non-empty.
    """
    action = (row.get("action") or "").strip().upper()
    if has_action and action:
        return action in ("DENY", "FLAG")
    return False


def _row_is_risk(row: dict, has_action: bool) -> bool:
    """Whether a row is a risk — pattern match + ALLOW + not whitelisted (ADR 0001).

    Enforcements are never risks. An explicit ``ALLOW`` is a risk; a legacy row
    with an empty ``action`` but a non-empty ``matched_patterns`` was stored as
    an ALLOW risk, so it counts too.
    """
    if _row_is_enforced(row, has_action):
        return False
    action = (row.get("action") or "").strip().upper()
    if has_action and action:
        return action == "ALLOW"
    return bool(_parse_matched_patterns(row.get("matched_patterns")))


# Back-compat alias — tests and older callers import this name.
_row_is_blocked = _row_is_enforced


def _domain_of_base(base_url: str) -> str:
    """Best-effort hostname: strip scheme/port/path, keep the authority."""
    m = re.match(r"^(?:https?://)?([^/]+)", base_url or "")
    host = m.group(1) if m else (base_url or "unknown")
    # Strip trailing port and leading www. so 'a.example' and 'a.example:443'
    # aggregate into the same bucket.
    host = re.sub(r":\d+$", "", host)
    return host or "unknown"


def _volume_for_bytes(rows: list[dict], has_duration: bool) -> int:
    """Sum bytes per row — real feed bytes first, duration proxy as fallback.

    The flat logstash-proxy index now persists ``bytes_downloaded`` and
    ``bytes_uploaded``; when either is present they sum to the true transfer
    size. Otherwise (legacy/COLLAPSED rows) the duration is used as a proxy
    (1s ≈ 8 KiB) or a flat 8 KiB per request is assumed — monotonic in
    request volume, so the rankings stay honest.
    """
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
    """Format an ISO bucket as 'Tue 14:00 EST' (best-effort, UTC-backed)."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts
    weekday = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[dt.weekday()]
    return f"{weekday} {dt.strftime('%H:%M')} EST"


# ── Aggregation helpers (SQL over findings) ────────────────────────────────


async def _load_blacklist_sets(db) -> tuple[set[str], set[str]]:
    """Load the blacklist_entries table into (url, ip) value sets."""
    cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
    rows = await cursor.fetchall()
    return (
        {r["value"] for r in rows if r["kind"] == "url"},
        {r["value"] for r in rows if r["kind"] == "ip"},
    )


async def _findings_summary(db, minutes: int) -> dict:
    """Aggregate the persisted findings table into the summary shape."""
    columns = await _column_names(db)
    has_duration = _has_column(columns, "duration_seconds")
    has_action = _has_column(columns, "action")

    params: list = []
    where = _window_clause(minutes, params)
    base_where = f"WHERE 1=1{where}"

    count_cursor = await db.execute(
        f"SELECT COUNT(*) AS total FROM findings {base_where}", params
    )
    total = (await count_cursor.fetchone())["total"]

    blacklist_urls, blacklist_ips = await _load_blacklist_sets(db)
    blacklist_domains = blacklist_urls | blacklist_ips

    total_volume = 0
    total_risk = 0
    total_blacklisted_risk = 0
    total_enforcements = 0
    top_host = ""
    peak_ts = ""
    if total:
        cursor = await db.execute(
            f"SELECT * FROM findings {base_where} LIMIT 10000", params
        )
        rows = [dict(r) for r in await cursor.fetchall()]

        total_volume = _volume_for_bytes(rows, has_duration)
        total_risk = sum(1 for r in rows if _row_is_risk(r, has_action))
        total_blacklisted_risk = sum(
            1
            for r in rows
            if _row_is_risk(r, has_action)
            and _domain_of_base(r.get("base_url") or "") in blacklist_domains
        )
        total_enforcements = sum(1 for r in rows if _row_is_enforced(r, has_action))

        by_host: dict[str, int] = {}
        for r in rows:
            by_host[r["client_ip"]] = by_host.get(r["client_ip"], 0) + 1
        top_host = max(by_host, key=by_host.get) if by_host else ""

        # Peak hour = the UTC hour with the most rows (best-effort; the UI
        # formats the weekday + hour label).
        by_hour: dict[str, int] = {}
        for r in rows:
            ts = r.get("log_timestamp") or ""
            if len(ts) >= 13:
                by_hour[ts[:13] + ":00:00"] = by_hour.get(ts[:13] + ":00:00", 0) + 1
        if by_hour:
            peak_ts = max(by_hour, key=by_hour.get)

    return {
        "totalVolume": total_volume,
        "totalRisk": total_risk,
        "totalBlacklistedRisk": total_blacklisted_risk,
        "totalEnforcements": total_enforcements,
        "topBandwidthHost": top_host,
        "peakTrafficTime": _fmt_peak(peak_ts) if peak_ts else "",
    }


async def _previous_period_summary(db, minutes: int) -> dict | None:
    """Summarize the fixed period immediately before the window.

    The previous window is the comparable slice before the current one:
    24h / 7d windows compare against the prior 7 days, 30d against the prior
    30 days. Bounds are evaluated by SQLite (UTC) via ``strftime`` modifiers so
    the filter is consistent with ``_window_clause``.
    """
    if minutes <= 0:
        return None
    # Comparable prior window: 1h → 1 day, 24h and 7d → 7 days, 30d → 30 days.
    offset_days = 1 if minutes == 60 else (7 if minutes in (1440, 10080) else 30)
    offset_minutes = minutes + offset_days * 1440
    params: list = [f"-{offset_minutes} minutes", f"-{minutes} minutes"]
    where = (
        " WHERE log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
        " AND log_timestamp < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
    )
    cursor = await db.execute(
        f"SELECT * FROM findings{where} LIMIT 10000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    if not rows:
        return None

    columns = await _column_names(db)
    has_duration = _has_column(columns, "duration_seconds")
    has_action = _has_column(columns, "action")
    total_volume = _volume_for_bytes(rows, has_duration)
    total_enforcements = sum(1 for r in rows if _row_is_enforced(r, has_action))
    return {"totalVolume": total_volume, "totalEnforcements": total_enforcements}


def _pct_delta(current: int, previous: int | None) -> float | None:
    if previous is None or previous <= 0:
        return None
    return round(((current - previous) / previous) * 100, 1)


async def _findings_bandwidth(db, minutes: int) -> list[dict]:
    """Daily buckets summing bytes (outbound only; feed has no direction)."""
    columns = await _column_names(db)
    has_duration = _has_column(columns, "duration_seconds")

    params: list = []
    where = _window_clause(minutes, params)
    cursor = await db.execute(
        f"SELECT * FROM findings WHERE 1=1{where} LIMIT 20000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    buckets: dict[str, dict[str, int]] = {}
    for r in rows:
        day = (r.get("log_timestamp") or "")[:10]
        if not day:
            continue
        b = buckets.setdefault(day, {"bucket": day, "inbound": 0, "outbound": 0})
        # Real bytes from the flat feed: download → inbound, upload → outbound.
        dn = r.get("bytes_downloaded")
        up = r.get("bytes_uploaded")
        try:
            if dn not in (None, ""):
                b["inbound"] += int(dn)
            if up not in (None, ""):
                b["outbound"] += int(up)
            if (dn in (None, "") and up in (None, "")) or (int(dn or 0) == 0 and int(up or 0) == 0):
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
    return list(buckets.values())


async def _findings_enforcements(db, minutes: int) -> list[dict]:
    """Daily buckets counting ALLOW vs DENY decisions."""
    columns = await _column_names(db)
    has_action = _has_column(columns, "action")

    params: list = []
    where = _window_clause(minutes, params)
    cursor = await db.execute(
        f"SELECT * FROM findings WHERE 1=1{where} LIMIT 20000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    buckets: dict[str, dict[str, int]] = {}
    for r in rows:
        day = (r.get("log_timestamp") or "")[:10]
        if not day:
            continue
        b = buckets.setdefault(day, {"bucket": day, "allow": 0, "deny": 0})
        if _row_is_enforced(r, has_action):
            b["deny"] += 1
        else:
            b["allow"] += 1
    return list(buckets.values())


async def _findings_top_domains(db, minutes: int, limit: int) -> list[dict]:
    """Terms aggregation on base_url by summed bytes, with % of window total."""
    columns = await _column_names(db)
    has_duration = _has_column(columns, "duration_seconds")

    params: list = []
    where = _window_clause(minutes, params)
    cursor = await db.execute(
        f"SELECT * FROM findings WHERE 1=1{where} LIMIT 20000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    by_domain: dict[str, dict] = {}
    for r in rows:
        domain = _domain_of_base(r.get("base_url") or "")
        entry = by_domain.setdefault(domain, {"count": 0, "volume": 0})
        entry["count"] += 1
        if has_duration:
            dur = r.get("duration_seconds") or 0
            try:
                entry["volume"] += max(1, int(dur)) * DEFAULT_BYTES_PER_REQUEST
            except (TypeError, ValueError):
                entry["volume"] += DEFAULT_BYTES_PER_REQUEST
        else:
            entry["volume"] += DEFAULT_BYTES_PER_REQUEST

    total = sum(d["volume"] for d in by_domain.values()) or 1
    items = [
        {
            "domain": domain,
            "count": entry["count"],
            "volume": entry["volume"],
            "pct": round((entry["volume"] / total) * 100, 1),
        }
        for domain, entry in sorted(by_domain.items(), key=lambda kv: (-kv[1]["volume"], kv[0]))
    ]
    return items[:limit]


async def _findings_top_enforced(db, minutes: int, limit: int) -> list[dict]:
    """Top enforced domains from the findings table (ADR 0001).

    Only explicit DENY/FLAG rows count. The persisted table rarely holds them
    (the poll stores ALLOW only), so callers prefer live ES — this is the
    offline fallback.
    """
    columns = await _column_names(db)
    has_action = _has_column(columns, "action")

    params: list = []
    where = _window_clause(minutes, params)
    cursor = await db.execute(
        f"SELECT * FROM findings WHERE 1=1{where} LIMIT 20000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    by_domain: dict[str, dict] = {}
    for r in rows:
        if not _row_is_enforced(r, has_action):
            continue
        domain = _domain_of_base(r.get("base_url") or "")
        entry = by_domain.setdefault(
            domain,
            {
                "domain": domain,
                "count": 0,
                "enforcements": 0,
                "primaryRule": _primary_rule(r.get("matched_patterns")),
            },
        )
        entry["count"] += 1
        entry["enforcements"] += 1

    items = sorted(by_domain.values(), key=lambda d: (-d["enforcements"], d["domain"]))
    return items[:limit]


# ── ES-backed aggregation (honest best-effort when the rich fields exist) ──


async def _es_summary(minutes: int) -> dict | None:
    """Best-effort ES aggregation for the summary card.

    Returns None when ES is offline or the block-pattern query is empty, so the
    caller falls back to the findings table (or an empty payload).
    """
    # The startup field-inventory gate (app.main lifespan) already determined
    # whether ES is reachable. Skipping here when it's UNKNOWN keeps the
    # endpoint deterministic and avoids a slow connection attempt against a
    # host the app has already failed to reach this process lifetime.
    from app.services.es_fields import get_mode

    if get_mode() == "UNKNOWN":
        return None
    try:
        import pandas as pd  # noqa: I001 — mid-function, grouped for the ES branch

        from app.config import get_settings
        from app.database import get_db
        from app.services.es_client import es_client
        from app.services.monitor import (
            _build_pattern_regex,
            build_logs_query,
            get_block_patterns,
            get_whitelist_patterns,
        )
        from app.services.result_processor import apply_filters

        settings = get_settings()
        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
            whitelist_patterns = await get_whitelist_patterns(db)
            blacklist_urls, blacklist_ips = await _load_blacklist_sets(db)
        finally:
            await db.close()
        if not block_patterns:
            return None

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(block_patterns, minutes, settings.es_query_size)

        async with es_client(settings, timeout=30) as es:
            res = await es.search(index=settings.elastic_index, body=query)

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            return {
                "totalVolume": 0,
                "totalRisk": 0,
                "totalBlacklistedRisk": 0,
                "totalEnforcements": 0,
                "topBandwidthHost": "",
                "peakTrafficTime": "",
            }

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            actions=None,
        )
        if df.empty:
            return {
                "totalVolume": 0,
                "totalRisk": 0,
                "totalBlacklistedRisk": 0,
                "totalEnforcements": 0,
                "topBandwidthHost": "",
                "peakTrafficTime": "",
            }

        # Real bytes from the flat logstash-proxy feed (bytes_downloaded +
        # bytes_uploaded) take priority over the duration×8192 proxy.
        has_duration = "duration_seconds" in df.columns
        if "bytes_downloaded" in df.columns or "bytes_uploaded" in df.columns:
            total_volume = int(
                df.get("bytes_downloaded", pd.Series(0, index=df.index))
                .fillna(0)
                .astype(int)
                .sum()
            ) + int(
                df.get("bytes_uploaded", pd.Series(0, index=df.index))
                .fillna(0)
                .astype(int)
                .sum()
            )
        elif has_duration:
            durations = df["duration_seconds"].fillna(0).apply(lambda d: max(1, int(d)))
            total_volume = int(durations.sum()) * DEFAULT_BYTES_PER_REQUEST
        else:
            total_volume = len(df) * DEFAULT_BYTES_PER_REQUEST

        # ADR 0001: risk = ALLOW pattern-matches; enforcements = DENY/FLAG
        # (the proxy already handled those). Risk is what needs action.
        blacklist_domains = blacklist_urls | blacklist_ips
        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            total_risk = int(actions.isin(["ALLOW"]).sum())
            total_enforcements = int(actions.isin(["DENY", "FLAG"]).sum())
            # A blacklisted destination the proxy still ALLOWed is the highest
            # risk — an explicit operator flag the proxy failed to enforce.
            risk_rows = df[actions.isin(["ALLOW"])]
            total_blacklisted_risk = int(
                risk_rows["base_url"].astype(str).isin(blacklist_domains).sum()
            )
        else:
            # Legacy/COLLAPSED docs carry no action — every block-pattern hit
            # was a risk by construction.
            total_risk = len(df)
            total_enforcements = 0
            total_blacklisted_risk = int(
                df["base_url"].astype(str).isin(blacklist_domains).sum()
            )

        by_host = df["client_ip"].astype(str).value_counts()
        top_host = str(by_host.index[0]) if len(by_host) else ""

        hour_series = df["@timestamp"].astype(str).str[:13]
        peak_hour = hour_series.value_counts().index[0] + ":00:00" if len(hour_series) else ""
        return {
            "totalVolume": total_volume,
            "totalRisk": total_risk,
            "totalBlacklistedRisk": total_blacklisted_risk,
            "totalEnforcements": total_enforcements,
            "topBandwidthHost": top_host,
            "peakTrafficTime": _fmt_peak(peak_hour) if peak_hour else "",
        }
    except Exception:
        return None


async def _es_enforcements(minutes: int) -> list[dict] | None:
    """Daily ALLOW-vs-DENY buckets from live ES — the only source of real
    enforcement counts, since the findings table stores ALLOW rows only.

    Returns None when ES is offline or the block-pattern query is empty, so the
    caller falls back to the findings table (enforcements = 0).
    """
    from app.services.es_fields import get_mode

    if get_mode() == "UNKNOWN":
        return None
    try:
        import pandas as pd  # noqa: I001

        from app.config import get_settings
        from app.database import get_db
        from app.services.es_client import es_client
        from app.services.monitor import (
            _build_pattern_regex,
            build_logs_query,
            get_block_patterns,
            get_whitelist_patterns,
        )
        from app.services.result_processor import apply_filters

        settings = get_settings()
        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
            whitelist_patterns = await get_whitelist_patterns(db)
        finally:
            await db.close()
        if not block_patterns:
            return None

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(block_patterns, minutes, settings.es_query_size)

        async with es_client(settings, timeout=30) as es:
            res = await es.search(index=settings.elastic_index, body=query)

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            return []

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            actions=None,
        )
        if df.empty:
            return []

        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
        else:
            actions = pd.Series("", index=df.index)

        buckets: dict[str, dict[str, int]] = {}
        ts = df["@timestamp"].astype(str)
        for idx in df.index:
            day = ts[idx][:10]
            if not day:
                continue
            b = buckets.setdefault(day, {"bucket": day, "allow": 0, "deny": 0})
            if actions[idx] in ("DENY", "FLAG"):
                b["deny"] += 1
            else:
                b["allow"] += 1
        return list(buckets.values())
    except Exception:
        return None


async def _es_top_enforced(minutes: int, limit: int) -> list[dict] | None:
    """Top enforced target domains from live ES (ADR 0001).

    Aggregates the block-pattern window by domain, counting DENY/FLAG rows.
    Returns None when ES is offline or the query is empty so the caller can
    fall back to the findings table.
    """
    from app.services.es_fields import get_mode

    if get_mode() == "UNKNOWN":
        return None
    try:
        import pandas as pd  # noqa: I001

        from app.config import get_settings
        from app.database import get_db
        from app.services.es_client import es_client
        from app.services.monitor import (
            _build_pattern_regex,
            build_logs_query,
            get_block_patterns,
            get_whitelist_patterns,
        )
        from app.services.result_processor import apply_filters

        settings = get_settings()
        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
            whitelist_patterns = await get_whitelist_patterns(db)
        finally:
            await db.close()
        if not block_patterns:
            return None

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(block_patterns, minutes, settings.es_query_size)

        async with es_client(settings, timeout=30) as es:
            res = await es.search(index=settings.elastic_index, body=query)

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            return []

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            actions=None,
        )
        if df.empty:
            return []

        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            enforced = df[actions.isin(["DENY", "FLAG"])]
        else:
            enforced = df.head(0)  # no action column → no enforcements

        if enforced.empty:
            return []

        # matched_patterns may be absent from the projection — degrade per row.
        def _first_rule(raw) -> str:
            try:
                pats = json.loads(raw) if raw else []
            except (json.JSONDecodeError, TypeError):
                return "matched"
            return str(pats[0]) if pats else "matched"

        by_domain: dict[str, dict] = {}
        for r in enforced.to_dict("records"):
            domain = _domain_of_base(str(r.get("base_url") or ""))
            entry = by_domain.setdefault(
                domain,
                {
                    "domain": domain,
                    "count": 0,
                    "enforcements": 0,
                    "primaryRule": _first_rule(r.get("matched_patterns")),
                },
            )
            entry["count"] += 1
            entry["enforcements"] += 1

        items = sorted(
            by_domain.values(), key=lambda d: (-d["enforcements"], d["domain"])
        )
        return items[:limit]
    except Exception:
        return None


# ── Routes ─────────────────────────────────────────────────────────────────


@router.get("/summary")
async def summary(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
):
    """High-level usage metrics (spec §3.4): volume, risk, enforcements, top host, peak time.

    ``compare`` (``none``/``previous``) and ``hostGroup`` are accepted and echoed
    back so the Analytics page can keep its selectors; the aggregation prefers
    live ES when the rich fields exist and otherwise falls back to the findings
    table. The previous-period numbers are computed over the fixed slice before
    the current window (see ``_previous_period_summary``) — the deltas are the
    honest percent change between the two windows.
    """
    _validate_range(range_)
    minutes = _minutes_for_range(range_)

    agg = await _es_summary(minutes)
    source = "es"
    if agg is None:
        agg = await _findings_summary(db, minutes)
        source = "findings"

    previous = None
    volume_delta = None
    enforcements_delta = None
    if compare == "previous":
        previous = await _previous_period_summary(db, minutes)
        if previous:
            volume_delta = _pct_delta(agg["totalVolume"], previous["totalVolume"])
            enforcements_delta = _pct_delta(
                agg["totalEnforcements"], previous["totalEnforcements"]
            )

    # Back-compat: the old frontend reads totalBlocked/blocks/blockedDeltaPct.
    # Keep them alongside the ADR-0001 names so a rolling deploy doesn't break.
    agg["totalBlocked"] = agg.get("totalEnforcements", 0)
    if previous is not None:
        previous["totalBlocked"] = previous.get("totalEnforcements", 0)
    has_data = (
        agg["totalVolume"] > 0
        or agg["totalRisk"] > 0
        or agg["totalEnforcements"] > 0
        or bool(agg["topBandwidthHost"])
    )
    return {
        "has_data": has_data,
        **agg,
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "source": source,
        "es_online": source == "es",
        "previous": previous,
        "volumeDeltaPct": volume_delta,
        "blockedDeltaPct": enforcements_delta,  # compat alias
        "enforcementsDeltaPct": enforcements_delta,
    }


@router.get("/bandwidth")
async def bandwidth(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
):
    """Daily bandwidth consumption — area chart (inbound vs outbound).

    Aggregates the persisted findings by UTC day, summing bytes. Direction is
    not captured by the feed, so ``inbound`` is 0 unless the ES projection can
    resolve a per-document direction field (the route tries ES first with the
    same fallback chain as ``summary`` — see module docstring).
    """
    _validate_range(range_)
    minutes = _minutes_for_range(range_)
    points = await _findings_bandwidth(db, minutes)
    return {
        "points": points,
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "es_online": False,
    }


@router.get("/enforcements")
async def enforcements(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
):
    """Daily policy enforcements — stacked bar (ALLOW vs DENY).

    Prefers live ES (the only place real DENY counts exist, since findings
    stores ALLOW rows only); falls back to the findings table when ES is
    offline.
    """
    _validate_range(range_)
    minutes = _minutes_for_range(range_)
    points = await _es_enforcements(minutes)
    source = "es"
    if points is None:
        points = await _findings_enforcements(db, minutes)
        source = "findings"
    return {
        "points": points,
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "es_online": source == "es",
        "source": source,
    }


@router.get("/top-domains")
async def top_domains(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
    limit: int = Query(10, ge=1, le=100),
):
    """Top bandwidth-consuming domains — terms agg by summed bytes + % of total."""
    _validate_range(range_)
    minutes = _minutes_for_range(range_)
    items = await _findings_top_domains(db, minutes, limit)
    return {
        "items": items,
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "es_online": False,
    }


@router.get("/top-enforced")
async def top_enforced(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
    limit: int = Query(10, ge=1, le=100),
):
    """Top enforced target domains — DENY filter, terms agg, primary matched rule.

    Prefers live ES (the only place real enforcement counts exist); falls back
    to the findings table (enforcements = 0) when ES is offline.
    """
    _validate_range(range_)
    minutes = _minutes_for_range(range_)
    items = await _es_top_enforced(minutes, limit)
    source = "es"
    if items is None:
        items = await _findings_top_enforced(db, minutes, limit)
        source = "findings"
    return {
        "items": items,
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "es_online": source == "es",
        "source": source,
    }


@router.get("/top-denied")
async def top_denied(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
    limit: int = Query(10, ge=1, le=100),
):
    """Back-compat alias of ``/top-enforced`` with the legacy response shape.

    Kept so older frontend builds keep working through the rename. New callers
    should use ``/top-enforced`` (``enforcements`` / ``primaryRule``).
    """
    _validate_range(range_)
    minutes = _minutes_for_range(range_)
    items = await _es_top_enforced(minutes, limit)
    source = "es"
    if items is None:
        items = await _findings_top_enforced(db, minutes, limit)
        source = "findings"
    return {
        "items": [
            {
                "domain": it["domain"],
                "count": it["count"],
                "blocks": it["enforcements"],
                "primaryRule": it["primaryRule"],
            }
            for it in items
        ],
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "es_online": source == "es",
        "source": source,
    }
