"""Analytics & Reports endpoints (spec §3.4) — metrics, trends, aggregations.

Risk vs enforcements (ADR 0001): a request is a **risk** when its URL matched a
block pattern, the proxy action was ``ALLOW``, and it is not whitelisted. A
**DENY** is an *enforcement* — the proxy already handled the request — and is
reported separately, never as risk. The persisted ``findings`` table now holds
both ALLOW and DENY rows (the poll stores through
``apply_filters(actions=("ALLOW", "DENY"))``), so enforcement history survives
ES window roll-over; live ES is still preferred when available.

Every endpoint accepts the same three query params the Analytics page passes
(``range``, ``compare``, ``hostGroup``) and degrades honestly:

- ``summary`` prefers live ES (real risk/enforcement split); falls back to the
  findings table, where risk and enforcements are both counted from the
  persisted ``action`` column (enforcements = DENY/FLAG rows).
- ``enforcements`` and ``top-enforced`` prefer live ES but fall back to the
  findings table, which now holds DENY rows too — both sources can report real
  enforcement counts; the fallback sets ``es_online: False`` but no longer
  forces ``enforcements = 0``.
- Volume is the SUM of the persisted ``bytes_downloaded``/``bytes_uploaded``
  counters only. Where the feed carries no byte counter the volume is reported
  as **unavailable** (``totalVolume: null`` with ``bandwidthNeverMeasured:
  true``) — never estimated from ``duration_seconds`` or a request count
  (CONTEXT.md, *No synthesized measurements*).

Response shapes (all camelCase — consumed by ``api.ts`` helpers verbatim):

    GET /api/analytics/summary?range=7d&compare=previous&hostGroup=all
        { has_data, totalVolume: int | null, bandwidthNeverMeasured,
          totalRisk, totalBlacklistedRisk, totalEnforcements,
          enforcementsNeverMeasured, topBandwidthHost, peakTrafficTime,
          range, compare, hostGroup, es_online,
          previous: { totalVolume: int | null, totalEnforcements } | null,
          volumeDeltaPct, enforcementsDeltaPct }

    GET /api/analytics/bandwidth?range=7d&compare=previous&hostGroup=all
        { points: [{ bucket, inbound, outbound }], range, hostGroup, es_online }

    GET /api/analytics/enforcements?range=7d&compare=previous&hostGroup=all
        { points: [{ bucket, allow, deny }], range, hostGroup, es_online }

    GET /api/analytics/top-domains?range=7d&compare=previous&hostGroup=all
        { items: [{ domain, count, volume, pct: number | null }],
          range, hostGroup, es_online }

    GET /api/analytics/top-enforced?range=7d&compare=previous&hostGroup=all
        { items: [{ domain, enforcements, primaryRule }], range, hostGroup, es_online }

    GET /api/analytics/top-clients?range=7d&compare=previous&hostGroup=all
        { items: [{ client_ip, count, last_seen }], range, compare, hostGroup, es_online }

``compare`` and ``hostGroup`` are accepted and echoed but do not change the
aggregation (documented honest no-op — see each endpoint docstring).

Calendar days and clock labels follow the operator's zone: every ``bucket``
date and every peak-time label is converted from the UTC feed into
``Settings.display_tz`` (env ``DISPLAY_TZ``, default ``UTC``) via
``app/services/timeutil.py``. Invalid zones degrade to UTC with one warning.
The ``bucket`` field stays a ``YYYY-MM-DD`` string — only its value changes,
and only when a non-UTC zone is configured.
"""

import json
import re


from fastapi import APIRouter, Depends, Query
from fastapi import HTTPException as FastAPIHTTPException

from app.database import get_db_conn
from app.services.result_processor import (
    _parse_matched_patterns,
    _row_is_blocked,
    _row_is_enforced,
    _row_is_risk,
)
from app.services.timeutil import format_peak_iso, local_day, local_hour_bucket

# ADR 0001 row semantics are canonical in ``app/services/result_processor.py``.
# ``_row_is_enforced`` / ``_row_is_risk`` / ``_row_is_blocked``
# (``_row_is_blocked`` is the back-compat alias for the enforcement test) are
# imported above and re-exported so this module keeps answering those names for
# any older caller — the rule itself is not restated here.
__all__ = ["_row_is_blocked", "_row_is_enforced", "_row_is_risk"]

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

# ── Window helpers ─────────────────────────────────────────────────────────

# Canonical ranges the Analytics page offers; anything else is rejected 422.
# 1h added so the Analytics presets match the app-wide FilterContext ranges.
SUPPORTED_RANGES = {"1h", "24h", "3d", "7d", "30d", "90d", "1y"}

# NOTE: there is deliberately no per-request byte constant here. Volume is the
# SUM of the persisted ``bytes_downloaded``/``bytes_uploaded`` columns or an
# explicit "not recorded" — never a per-request or per-duration estimate
# (CONTEXT.md, *No synthesized measurements*).

def _minutes_for_range(range_: str) -> int:
    return {
        "1h": 60, "24h": 1440, "3d": 4320, "7d": 10080,
        "30d": 43200, "90d": 129600, "1y": 525600,
    }[range_]


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


def _primary_rule(matched_patterns: str | None) -> str:
    """First matched pattern, or ``""`` when there is no rule information.

    The proxy's documents have no ``matched_patterns`` field at all (the
    backend default-fills it with ``""``), so an empty result is the norm —
    never a literal like ``"matched"``, which reads as a rule name downstream.
    """
    pats = _parse_matched_patterns(matched_patterns)
    if isinstance(pats, list) and pats:
        return str(pats[0])
    return ""


def _domain_of_base(base_url: str) -> str:
    """Best-effort hostname: strip scheme/port/path, keep the authority."""
    m = re.match(r"^(?:https?://)?([^/]+)", base_url or "")
    host = m.group(1) if m else (base_url or "unknown")
    # Strip trailing port and leading www. so 'a.example' and 'a.example:443'
    # aggregate into the same bucket.
    return host or "unknown"


def _persisted_bytes(value) -> int | None:
    """The persisted byte figure for one row, or ``None`` when not recorded.

    ``None`` and ``""`` are NOT-RECORDED (absent), and are deliberately
    distinct from a stored ``0``: the flat ``bytes_downloaded`` column
    collapses the raw line's ``-`` sentinel to ``0``, so a ``0`` must never be
    *shown* as a confident measured zero — but it is still a persisted value
    and must not be replaced by an estimate.
    """
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _volume_for_bytes(rows: list[dict]) -> int | None:
    """SUM the persisted byte counters — never a proxy, or ``None``.

    Returns the summed ``bytes_downloaded`` + ``bytes_uploaded`` when at least
    one row carried a byte counter, and ``None`` when no row did. There is no
    duration or per-request fallback: a fabricated total that happened to
    preserve the ranking order would still be a fabricated absolute figure, so
    an unknown volume is reported as unavailable rather than estimated
    (CONTEXT.md, *No synthesized measurements*). Callers surface ``None`` as
    an explicit unavailable marker.
    """
    total = 0
    seen = False
    for r in rows:
        dn = _persisted_bytes(r.get("bytes_downloaded"))
        up = _persisted_bytes(r.get("bytes_uploaded"))
        if dn is None and up is None:
            continue
        seen = True
        total += (dn or 0) + (up or 0)
    return total if seen else None


def _fmt_peak(ts: str) -> str:
    """Format an ISO bucket as ``'Tue 14:00 +07:00'`` in the operator's zone.

    The label is derived from the configured zone (``DISPLAY_TZ``),
    never hardcoded; unparseable input is returned verbatim.
    """
    return format_peak_iso(ts)


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

    # ``None`` until a byte counter is seen: an unknown volume is reported as
    # unavailable, never estimated from a duration or a request count.
    total_volume: int | None = None
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

        total_volume = _volume_for_bytes(rows)
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
        # NOTE: ``top_host`` stays "" here. "Top bandwidth host" cannot be
        # answered from this fallback: it would have to be ranked by the
        # synthesized volume this module no longer invents. ES answers it from
        # the real feed (see ``_es_summary``/``_es_top_domains``).
        # Peak hour = the operator-local hour with the most rows (best-effort;
        # the UI shows the weekday + hour + zone label verbatim).
        by_hour: dict[str, int] = {}
        for r in rows:
            hour = local_hour_bucket(r.get("log_timestamp") or "")
            if hour:
                by_hour[hour] = by_hour.get(hour, 0) + 1
        if by_hour:
            peak_ts = max(by_hour, key=by_hour.get)

    return {
        "totalVolume": total_volume,
        "totalRisk": total_risk,
        "totalBlacklistedRisk": total_blacklisted_risk,
        "totalEnforcements": total_enforcements,
        "topBandwidthHost": top_host,
        "bandwidthNeverMeasured": total_volume is None,
        "peakTrafficTime": _fmt_peak(peak_ts) if peak_ts else "",
    }


async def _previous_period_summary(db, minutes: int) -> dict | None:
    """Summarize the fixed period immediately before the window.

    The previous window is the comparable slice before the current one:
    1h → prior day, 3d → prior 3 days, 24h / 7d → prior 7 days,
    30d and longer → prior 30 days. Bounds are evaluated by SQLite (UTC) via
    ``strftime`` modifiers so the filter is consistent with ``_window_clause``.
    """
    if minutes <= 0:
        return None
    # Comparable prior window: 1h → 1 day, 3d → 3 days, 24h and 7d → 7 days,
    # 30d and longer → 30 days.
    if minutes == 60:
        offset_days = 1
    elif minutes == 4320:
        offset_days = 3
    elif minutes in (1440, 10080):
        offset_days = 7
    else:
        offset_days = 30
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
    has_action = _has_column(columns, "action")
    total_volume = _volume_for_bytes(rows)
    total_enforcements = sum(1 for r in rows if _row_is_enforced(r, has_action))
    return {"totalVolume": total_volume, "totalEnforcements": total_enforcements}


def _pct_delta(current: int | None, previous: int | None) -> float | None:
    """Percent change, or ``None`` when it is undefined.

    ``None`` on either side means "not recorded" (see ``_volume_for_bytes``),
    and a non-positive baseline has no defined percent change — neither may
    produce a number, and neither may divide by zero.
    """
    if current is None or previous is None or previous <= 0:
        return None
    return round(((current - previous) / previous) * 100, 1)


async def _findings_bandwidth(db, minutes: int) -> list[dict]:
    """Daily buckets summing the real persisted byte counters.

    Rows with no byte counter contribute nothing — the day is present with a
    real (possibly 0) sum, never a per-request estimate.
    """
    params: list = []
    where = _window_clause(minutes, params)
    cursor = await db.execute(
        f"SELECT * FROM findings WHERE 1=1{where} LIMIT 20000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]

    buckets: dict[str, dict] = {}
    for r in rows:
        day = local_day(r.get("log_timestamp") or "")
        if not day:
            continue
        b = buckets.setdefault(day, {"bucket": day, "inbound": 0, "outbound": 0})
        # Real bytes from the flat feed: download → inbound, upload → outbound.
        dn = _persisted_bytes(r.get("bytes_downloaded"))
        up = _persisted_bytes(r.get("bytes_uploaded"))
        if dn is not None:
            b["inbound"] += dn
        if up is not None:
            b["outbound"] += up
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
        day = local_day(r.get("log_timestamp") or "")
        if not day:
            continue
        b = buckets.setdefault(day, {"bucket": day, "allow": 0, "deny": 0})
        if _row_is_enforced(r, has_action):
            b["deny"] += 1
        else:
            b["allow"] += 1
    return list(buckets.values())


async def _findings_top_domains(db, minutes: int, limit: int) -> list[dict]:
    """Terms aggregation on base_url by summed real bytes, with % of total.

    ``volume`` is the summed persisted byte counter per domain; a domain whose
    rows carry no byte counter sums to a real ``0`` and is sorted last. The
    window ``pct`` is ``null`` while the window total is 0 — a 0/0 share is
    undefined, not 0%.
    """
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
        # Real bytes only; no byte counter contributes nothing (never estimated).
        dn = _persisted_bytes(r.get("bytes_downloaded"))
        up = _persisted_bytes(r.get("bytes_uploaded"))
        entry["volume"] += (dn or 0) + (up or 0)

    total = sum(d["volume"] for d in by_domain.values())
    items = [
        {
            "domain": domain,
            "count": entry["count"],
            "volume": entry["volume"],
            "pct": round((entry["volume"] / total) * 100, 1) if total else None,
        }
        for domain, entry in sorted(by_domain.items(), key=lambda kv: (-kv[1]["volume"], kv[0]))
    ]
    return items[:limit]


async def _findings_top_enforced(db, minutes: int, limit: int) -> list[dict]:
    """Top enforced domains from the findings table (ADR 0001).

    Only explicit DENY/FLAG rows count. The persisted table now holds DENY rows
    (the poll stores ALLOW and DENY), so this offline fallback reports real
    enforcement counts; callers still prefer live ES when it is available.
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


async def _findings_top_clients(db, minutes: int, limit: int) -> list[dict]:
    """Top client_ips in the findings table in-window by request count."""
    params: list = []
    where = _window_clause(minutes, params)
    cursor = await db.execute(
        "SELECT client_ip, COUNT(*) AS count, MAX(log_timestamp) AS last_seen"
        f" FROM findings WHERE client_ip != ''{where}"
        " GROUP BY client_ip ORDER BY count DESC, client_ip LIMIT ?",
        [*params, limit],
    )
    return [dict(r) for r in await cursor.fetchall()]


# ── ES-backed aggregation (honest best-effort when the rich fields exist) ──


async def _es_summary(minutes: int) -> dict | None:
    """Best-effort ES aggregation for the summary card.

    Returns None when ES is offline, no block patterns are configured, or the
    search itself fails, so the caller falls back to the findings table.
    A reachable-but-empty window is NOT one of those cases and does not return
    None: it returns a payload whose enforcement figure is the proxy's real
    count (see the action query below), not a measured-looking 0.
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
        # Two searches, because a reach and an enforcement are different
        # questions over different row populations and one query cannot answer
        # both (the same split as `_aggregate_host` in app/routes/hosts.py):
        #   * the pattern query answers "what ALLOWed a block pattern?" — the
        #     pattern clause is the point of it.
        #   * the action query answers "what did the proxy DENY/FLAG?" — a
        #     DENY is recorded against the destination the proxy refused, whose
        #     URL need not contain any block pattern (a bare host, an IP, the
        #     SNI). Deriving the count from the pattern frame returned zero on
        #     ordinary traffic, so `totalEnforcements` (the headline card, the
        #     CSV column and the compat `totalBlocked` alias) read a confident 0.
        pattern_query = build_logs_query(
            block_patterns, minutes, settings.es_query_size
        )
        # Count-only: no documents are needed to answer the enforcement
        # question, so `size: 0` (`fields` left unset — an empty `_source`
        # projection would be a no-op next to `size: 0`) keeps it cheap, and
        # `track_total_hits` is opted back in because a count-only search
        # returns a capped total otherwise.
        enforcement_query = build_logs_query(
            block_patterns, minutes, 0, actions=["DENY", "FLAG"]
        )
        enforcement_query["track_total_hits"] = True

        async with es_client(settings, timeout=settings.es_timeout_seconds) as es:
            res = await es.search(index=settings.elastic_index, body=pattern_query)
            enf_res = await es.search(
                index=settings.elastic_index, body=enforcement_query
            )

        # The proxy's own count of DENY/FLAG rows in the window — a measurement
        # over the enforcement population, independent of the pattern clause.
        # Read defensively: if ES cannot answer it (a stub, or an index that
        # predates the field) the count is unavailable, not 0.
        enforcement_hits = enf_res.get("hits", {}) if isinstance(enf_res, dict) else {}
        enforcement_total = enforcement_hits.get("total")
        total_enforcements: int | None
        if isinstance(enforcement_total, dict):
            total_enforcements = int(enforcement_total.get("value", 0))
        else:
            total_enforcements = None

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            # No REACH matched a block pattern in the window. That is NOT
            # "nothing happened": the proxy may still have DENIED requests —
            # and `total_enforcements` above, from the action query, is that
            # real count. The empty window is reported honestly: the risk
            # series has no value (real 0) while the enforcement figure carries
            # a marker so it is never read as a confident measurement.
            return {
                "totalVolume": None,
                "totalRisk": 0,
                "totalBlacklistedRisk": 0,
                "totalEnforcements": total_enforcements,
                "topBandwidthHost": "",
                "bandwidthNeverMeasured": True,
                "enforcementsNeverMeasured": total_enforcements is None,
                "peakTrafficTime": "",
            }

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            actions=None,
        )
        if df.empty:
            # The pattern frame arrived but every row was filtered out (blank
            # URL / whitelisted). Enforcements are unaffected by that filter —
            # they were never in this frame to begin with — so the action-query
            # count stands and the marker mirrors the branch above.
            return {
                "totalVolume": None,
                "totalRisk": 0,
                "totalBlacklistedRisk": 0,
                "totalEnforcements": total_enforcements,
                "topBandwidthHost": "",
                "bandwidthNeverMeasured": True,
                "enforcementsNeverMeasured": total_enforcements is None,
                "peakTrafficTime": "",
            }

        # Real bytes summed from the flat logstash-proxy feed. A missing byte
        # field is NOT a zero: with neither field recorded we cannot say what
        # the volume was, so the total stays None (explicit unavailable) rather
        # than being estimated from duration_seconds or the request count.
        # `apply_filters` default-fills an ABSENT byte column with "" (a string,
        # not a number), so the parse coerces with `to_numeric` and keeps only
        # recorded values: `.astype(int)` on those "" values would raise and
        # collapse this whole summary (enforcements included) onto the findings
        # fallback — the very silent loss this change removes. A persisted 0
        # stays a real, measured 0.
        byte_cols = [
            pd.to_numeric(df[col], errors="coerce")
            for col in ("bytes_downloaded", "bytes_uploaded")
            if col in df.columns
        ]
        if byte_cols and any(col.notna().any() for col in byte_cols):
            total_volume = int(sum(col.sum() for col in byte_cols))
        else:
            total_volume = None

        # ADR 0001: risk = ALLOW pattern-matches; enforcements = DENY/FLAG
        # (the proxy already handled those). Risk is what needs action.
        blacklist_domains = blacklist_urls | blacklist_ips
        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            total_risk = int(actions.isin(["ALLOW"]).sum())
            # A blacklisted destination the proxy still ALLOWed is the highest
            # risk — an explicit operator flag the proxy failed to enforce.
            risk_rows = df[actions.isin(["ALLOW"])]
            total_blacklisted_risk = int(
                risk_rows["base_url"].astype(str).isin(blacklist_domains).sum()
            )
        else:
            # Legacy/COLLAPSED docs carry no `action` field at all, so this
            # frame cannot separate a risk from an enforcement — every
            # block-pattern hit is graded a risk by construction. Reachability
            # on real data: the action field is part of the extended findings
            # schema and the proxy feed carries it; this branch fires only on a
            # pre-`action` frame. `total_enforcements` keeps the action query's
            # real count (NOT a hardcoded 0): a DENY is an `action`, and the
            # absence of the field from THIS frame says nothing about whether
            # the proxy denied anyone in the window.
            total_risk = len(df)
            total_blacklisted_risk = int(
                df["base_url"].astype(str).isin(blacklist_domains).sum()
            )

        by_host = df["client_ip"].astype(str).value_counts()
        top_host = str(by_host.index[0]) if len(by_host) else ""

        # Peak hour in the operator's zone — counting on the raw UTC hour
        # string would label the peak with the wrong hour AND the wrong day
        # for any row that crosses local midnight.
        by_hour: dict[str, int] = {}
        for value in df["@timestamp"].astype(str):
            hour = local_hour_bucket(value)
            if hour:
                by_hour[hour] = by_hour.get(hour, 0) + 1
        peak_hour = max(by_hour, key=by_hour.get) if by_hour else ""
        return {
            "totalVolume": total_volume,
            "totalRisk": total_risk,
            "totalBlacklistedRisk": total_blacklisted_risk,
            "totalEnforcements": total_enforcements,
            "topBandwidthHost": top_host,
            "bandwidthNeverMeasured": total_volume is None,
            "enforcementsNeverMeasured": total_enforcements is None,
            "peakTrafficTime": _fmt_peak(peak_hour) if peak_hour else "",
        }
    except Exception:
        return None


async def _es_enforcements(minutes: int) -> list[dict] | None:
    """Daily ALLOW-vs-DENY buckets from live ES.

    Returns None when ES is offline, no block patterns are configured, or the
    reach search itself fails. It does NOT return None for a
    reachable-but-empty pattern frame: on that path the DENY series is still
    measurable (the action query is the source of every deny count below), so
    returning a value there keeps the caller from silently skipping the
    persisted ledger on the one window where the DENY question matters most.

    The ALLOW series means ``action == "ALLOW"`` specifically — the client got
    through a block pattern (ADR 0001). It is *not* an ``else`` bucket: a row
    whose action is empty or unknown is neither an allow nor a deny and is
    counted in neither series (see the loop below).
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
        # Two searches over two row populations (the fix pattern from
        # `_aggregate_host` in app/routes/hosts.py):
        #   * the pattern query is the ALLOW series — a REACH is a block-pattern
        #     match, so the pattern clause is the point of it. It never returns
        #     a patternless DENY, which is why it cannot answer the DENY series.
        #   * the action query answers "what did the proxy DENY/FLAG?" — a DENY
        #     is recorded against the destination the proxy refused, whose URL
        #     need not contain a block pattern. Broadening the single pattern
        #     query instead would change what BOTH series mean, so the two are
        #     kept separate.
        pattern_query = build_logs_query(
            block_patterns, minutes, settings.es_query_size
        )
        action_query = build_logs_query(
            block_patterns, minutes, settings.es_query_size, actions=["DENY", "FLAG"]
        )

        async with es_client(settings, timeout=settings.es_timeout_seconds) as es:
            res = await es.search(index=settings.elastic_index, body=pattern_query)
            deny_res = await es.search(
                index=settings.elastic_index, body=action_query
            )

        hits = res.get("hits", {}).get("hits", [])
        deny_hits = deny_res.get("hits", {}).get("hits", [])
        # The ALLOW series comes from the pattern frame, filtered for whitelist
        # and blank URLs exactly as before.
        df = (
            apply_filters(
                pd.DataFrame([h["_source"] for h in hits]),
                whitelist_regex,
                actions=None,
            )
            if hits
            else pd.DataFrame()
        )

        # The enforcement frame is NOT run through `apply_filters`: a DENY whose
        # URL matched a whitelist entry is still an enforcement the proxy
        # recorded, and dropping it would re-hide rows this fix exists to show.
        df_deny = (
            pd.DataFrame([h["_source"] for h in deny_hits])
            if deny_hits
            else pd.DataFrame()
        )

        buckets: dict[str, dict[str, int]] = {}

        # `allow` is exactly action == "ALLOW" — the client got through a block
        # pattern (ADR 0001). It is deliberately NOT an `else`: an empty or
        # unknown action is not an ALLOW, and counting it as one is half of the
        # two-way miscount this fixes. Such a row lands in NEITHER series.
        if "action" in df.columns and not df.empty:
            allow_actions = (
                df["action"].fillna("").astype(str).str.strip().str.upper()
            )
            allow_df = df[allow_actions == "ALLOW"]
        else:
            # No action field in the frame, or the frame is empty: there is no
            # row we can honestly call an ALLOW.
            allow_df = pd.DataFrame()

        for idx in allow_df.index:
            day = local_day(str(allow_df.at[idx, "@timestamp"]))
            if not day:
                continue
            b = buckets.setdefault(day, {"bucket": day, "allow": 0, "deny": 0})
            b["allow"] += 1

        # The DENY series comes from the action query, which by construction
        # returns exactly the DENY/FLAG rows — including those whose URL matches
        # no block pattern. That is the entire reason this second query exists.
        if "action" in df_deny.columns and not df_deny.empty:
            deny_actions = (
                df_deny["action"].fillna("").astype(str).str.strip().str.upper()
            )
            deny_df = df_deny[deny_actions.isin(["DENY", "FLAG"])]
            for idx in deny_df.index:
                day = local_day(str(deny_df.at[idx, "@timestamp"]))
                if not day:
                    continue
                b = buckets.setdefault(day, {"bucket": day, "allow": 0, "deny": 0})
                b["deny"] += 1

        # Both questions were actually asked. A genuinely empty window (no ALLOW
        # reached a block pattern AND the proxy issued no DENY) is `[]`, and the
        # caller may honestly call that live ES: the DENY part was measured, not
        # assumed — unlike pre-fix, where `[]` came from a pattern query that had
        # never looked for a DENY at all.
        return list(buckets.values())
    except Exception:
        return None


async def _es_top_enforced(minutes: int, limit: int) -> list[dict] | None:
    """Top enforced target domains from live ES (ADR 0001).

    Groups the proxy's own DENY/FLAG rows by domain and counts them. Returns
    None when ES is offline, no block patterns are configured, or the search
    fails, so the caller can fall back to the findings table; a
    reachable-but-empty window returns ``[]`` (an honestly measured "nothing
    was enforced") rather than ``None``.
    """
    from app.services.es_fields import get_mode

    if get_mode() == "UNKNOWN":
        return None
    try:
        import pandas as pd  # noqa: I001

        from app.config import get_settings
        from app.database import get_db
        from app.services.es_client import es_client
        from app.services.monitor import build_logs_query, get_block_patterns

        settings = get_settings()
        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
        finally:
            await db.close()
        if not block_patterns:
            return None

        # The enforcement frame IS the proxy's action population: an
        # `actions=["DENY","FLAG"]` query omits the block-pattern clause
        # entirely (see `build_logs_query`). This is the whole correctness
        # point — a DENY is recorded against the destination the proxy
        # refused, whose URL need not contain any block pattern (a bare host,
        # an IP, the SNI), so the previous pattern-filtered query returned
        # those rows only when the refused URL happened to match a pattern.
        # With no matching row it returned `[]`, indistinguishable from "no
        # enforcements occurred". Grouping the action frame alone is
        # sufficient here: unlike the reaches/ALLOW series there is no second
        # row population this endpoint reports, so no pattern query is needed.
        query = build_logs_query(
            block_patterns, minutes, settings.es_query_size, actions=["DENY", "FLAG"]
        )

        async with es_client(settings, timeout=settings.es_timeout_seconds) as es:
            res = await es.search(index=settings.elastic_index, body=query)

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            return []

        # NOT run through `apply_filters`: it drops whitelisted and blank-URL
        # rows, and a DENY whose URL matched a whitelist entry is still an
        # enforcement the proxy recorded. Dropping it would re-hide rows this
        # fix exists to show. The action query already restricts the frame to
        # DENY/FLAG, so the per-row action test below is a defensive re-check,
        # not the filter that produces the set.
        df = pd.DataFrame([h["_source"] for h in hits])
        if df.empty:
            return []

        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            enforced = df[actions.isin(["DENY", "FLAG"])]
        else:
            enforced = df.head(0)  # no action column → no enforcements

        if enforced.empty:
            return []

        # `primaryRule` reads the PROXY's own rule identity, not
        # `matched_patterns`: the latter is computed by uNetWatch from its own
        # block patterns and only exists on a pattern match, so a patternless
        # DENY — the very rows this endpoint now returns — would always read
        # empty. `rule_name` is the proxy's human-facing rule name and is the
        # primary source; `rule_info` (comma-separated opaque rule codes,
        # e.g. "RN190,SNI,BS") is the fallback, reduced to its first code.
        # `""` means no rule is attributable on any row of the domain — an
        # explicit "not attributable", never a literal that reads as a name.
        def _first_rule(rule_name, rule_info) -> str:
            if isinstance(rule_name, str) and rule_name.strip():
                return rule_name.strip()
            if isinstance(rule_info, str) and rule_info.strip():
                first = rule_info.split(",", 1)[0].strip()
                if first:
                    return first
            return ""

        by_domain: dict[str, dict] = {}
        for r in enforced.to_dict("records"):
            domain = _domain_of_base(str(r.get("base_url") or ""))
            entry = by_domain.setdefault(
                domain,
                {
                    "domain": domain,
                    "count": 0,
                    "enforcements": 0,
                    "primaryRule": _first_rule(
                        r.get("rule_name"), r.get("rule_info")
                    ),
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

    ``totalVolume`` is the summed persisted bytes, or ``null`` with
    ``bandwidthNeverMeasured: true`` when no byte counter was recorded for the
    window — an unknown volume is reported as unavailable, never estimated.
    ``volumeDeltaPct`` is ``null`` whenever either window's volume is unknown
    (it never divides by an absent total).
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
    # A null volume OR a null enforcement count is "not recorded", not zero —
    # neither may decide has_data, and neither may raise a comparison here.
    has_data = (
        (agg.get("totalVolume") or 0) > 0
        or agg["totalRisk"] > 0
        or (agg.get("totalEnforcements") or 0) > 0
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

    Aggregates the persisted findings by the operator-local day (see
    ``Settings.display_tz``), summing bytes. Direction is
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

    Prefers live ES but falls back to the findings table, which holds DENY rows
    too (added when the poll stores through ``apply_filters(actions=("ALLOW",
    "DENY"))``). The fallback runs when ES is offline, when no block patterns
    are configured, and when the search fails — every path that returns None.
    A reachable-but-empty ES window does NOT take the fallback: ``_es_enforcements``
    measured the DENY series with a second, action-filtered query on that path,
    so an empty result is a real measurement and ``source`` reports ``"es"``.
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
    """Top enforced target domains — action query, primary proxy rule.

    The live path groups the proxy's own DENY/FLAG rows (an `actions=["DENY",
    "FLAG"]` query, so a DENY recorded against a non-pattern URL is included),
    and its ``primaryRule`` is the proxy's own rule identity (``rule_name`` /
    ``rule_info``). Prefers live ES but falls back to the findings table, which
    now holds DENY rows too, so the offline fallback reports real enforcement
    counts (that fallback still attributes a rule from ``matched_patterns``).
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


@router.get("/top-clients")
async def top_clients(
    range_: str = Query("7d", alias="range"),
    compare: str = Query("none", max_length=32),
    host_group: str = Query("all", alias="hostGroup", max_length=64),
    db=Depends(get_db_conn),
    limit: int = Query(10, ge=1, le=100),
):
    """Top client_ips in the findings table in-window, by request count.

    ``compare`` and ``hostGroup`` are accepted and echoed but do not change
    the aggregation (honest no-op, like the sibling endpoints).
    """
    _validate_range(range_)
    minutes = _minutes_for_range(range_)
    items = await _findings_top_clients(db, minutes, limit)
    return {
        "items": items,
        "range": range_,
        "compare": compare,
        "hostGroup": host_group,
        "es_online": False,
    }
