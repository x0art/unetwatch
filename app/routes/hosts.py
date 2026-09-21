"""Host Inspector backend — GET /api/hosts/{ip}.

Aggregates the live Elasticsearch block-pattern window for a single client IP
into the flat ``HostProfile`` shape the Host Inspector page renders. Risk is
framed per ADR 0001: ``riskRequests`` are ALLOW pattern-matches (need action),
``enforcements`` are DENY/FLAG (the proxy already handled them). No MAC / dept /
user identity is surfaced — a host is an IP + optional hostname.

Elasticsearch failures degrade honestly: the endpoint never 500s, it returns
``es_online: false`` and a zeroed profile so the page still renders.
"""

from fastapi import APIRouter, Query

from app.config import get_settings

router = APIRouter(prefix="/api/hosts", tags=["hosts"])

# ── Graded host risk model (2026-09-21) ─────────────────────────────────────
#
# The previous model escalated EVERY host that reached even one blacklisted
# destination to a FLAT ``max(92, share_score)`` — one stray hit and five
# hundred hits produced the same "HIGH 92/100", which an operator cannot
# triage with. The owner's decision: the score must be GRADED and DYNAMIC.
#
# Scale: 0–100. The floor is 0 (no signals ⇒ 0 evidence) and the ceiling is
# 100 (clamped). A host with no reaches and no attempts is 0, not a magic 12.
#
# Every constant below is a NAMED value with its meaning stated. ⚠ PROVISIONAL:
# measured against the production DB on 2026-09-21 it held 2 findings rows, 1
# distinct base_url and 0 blacklist entries — UNMEASURABLE. These thresholds
# are a defensible default, NOT a measurement; recalibrate against the real
# distribution once volume exists (see docs/superpowers/specs/2026-09-21-*).
#
# No synthesized inputs: the model consumes only persisted/measured fields
# (action, base_url, @timestamp) per CONTEXT.md §"No synthesized measurements".
# It does NOT use duration_seconds × N byte proxies, and does NOT read
# bytes_downloaded on DENY rows (structurally 0 — spec §j / logline.py).

# Scale bounds.
RISK_SCALE_MIN = 0
RISK_SCALE_MAX = 100
# Empty-window baseline: a host with no traffic has zero evidence, so 0.
NO_TRAFFIC_SCORE = 0

# REACH (ALLOW) components — the strong signal.
# A single confirmed reach already scores this: the client GOT THROUGH.
REACH_BASE = 20
# Each reach beyond the first adds this much — volume must grade the score.
REACH_PER_HIT_WEIGHT = 3
# Reaches past this count add nothing more to the volume term: a plateau so a
# runaway host does not climb without bound on volume alone.
REACH_HIT_SATURATION = 20
# Each DISTINCT prohibited destination reached adds this — breadth ranks ABOVE
# repeats of a single destination.
DISTINCT_DEST_WEIGHT = 7
# Distinct destinations at or above this count are treated as maximally broad.
DISTINCT_DEST_SATURATION = 5
# Added when the newest reach is recent — the operator acts on current behaviour.
RECENCY_BONUS = 10
# "Current" horizon in minutes (6× the 10-minute default poll interval).
RECENCY_WINDOW_MIN = 60

# ATTEMPT (DENY) component — intent evidence. Subordinate to any reach.
ATTEMPT_WEIGHT = 2
# Cap so an ATTEMPT-only host can never outrank a REACH host. Must stay below
# the minimum possible reach score (REACH_BASE + REACH_PER_HIT_WEIGHT = 23,
# with no breadth/recency), so a reach always dominates intent evidence alone.
ATTEMPT_CAP = 20

# Level cut-offs.
LEVEL_HIGH_MIN = 70
LEVEL_MEDIUM_MIN = 45


def _clamp(value: int, low: int = RISK_SCALE_MIN, high: int = RISK_SCALE_MAX) -> int:
    """Clamp a score into the stated scale bounds."""
    return max(low, min(high, value))


def _level_for(score: int) -> str:
    """Map a graded 0–100 score to its level (HIGH / MEDIUM / LOW)."""
    if score >= LEVEL_HIGH_MIN:
        return "HIGH"
    if score >= LEVEL_MEDIUM_MIN:
        return "MEDIUM"
    return "LOW"


def _risk_from_shares(
    total: int,
    risk_requests: int,
    blacklisted_risk: int = 0,
    *,
    blacklisted_distinct: int = 0,
    enforcements: int = 0,
    newest_reach_age_minutes: int | None = None,
) -> dict:
    """Map the window's counts to a GRADED risk score + level (ADR 0001).

    All arguments are persisted/measured counts — nothing is synthesized:

    - ``total`` — block-pattern matches in the window.
    - ``risk_requests`` — REACH events: ALLOW pattern-matches the client got.
    - ``blacklisted_risk`` — REACH events to an operator-blacklisted destination.
    - ``blacklisted_distinct`` — how many DISTINCT blacklisted destinations were
      reached (``base_url`` multiplicity — breadth, not volume).
    - ``enforcements`` — ATTEMPT events: DENY/FLAG the proxy blocked. Subordinate
      evidence of intent; contributes but always ranks below a reach.
    - ``newest_reach_age_minutes`` — age of the most recent REACH, or ``None``
      when there was no reach (the real timestamp age, never a proxy).

    The returned dict carries a ``riskReason`` alongside the score so a caller
    can never render the score without its justification (see
    ``_unavailable_risk_reason`` for the ES-unavailable case, which this pure
    helper has no way to see):

    ``{"rule", "level", "score", "floored", "inputs", "text"}``

    - ``rule`` names WHICH branch fired: ``graded_reach``, ``graded_attempt_only``
      or ``no_traffic``.
    - ``floored`` is retained for wire compatibility and is now ALWAYS ``False``
      — the flat floor is deleted, so nothing can set it true.
    - ``inputs`` are the exact counts the branches consumed.
    - ``text`` is the operator-facing sentence, stated in ADR 0001 vocabulary
      ("risk (ALLOW matches)", "enforcements (DENY)").
    """
    reaches = max(0, risk_requests)
    attempts = max(0, enforcements)
    reached_distinct = max(0, blacklisted_distinct)

    if total <= 0:
        reason = {
            "rule": "no_traffic",
            "level": "LOW",
            "score": NO_TRAFFIC_SCORE,
            "floored": False,
            "inputs": {
                "totalRequests": total,
                "riskRequests": reaches,
                "blacklistedRequests": max(0, blacklisted_risk),
                "blacklistedDistinct": reached_distinct,
                "enforcements": attempts,
                "reachCount": reaches,
                "attemptCount": attempts,
                "newestReachAgeMinutes": newest_reach_age_minutes,
            },
            "text": (
                "No traffic in the window — score is the model's empty-window "
                "baseline of 0, not a measurement."
            ),
        }
        return {
            "riskScore": NO_TRAFFIC_SCORE,
            "riskLevel": "LOW",
            "riskReason": reason,
        }

    # ── Volume term: more reaches grade higher, plateauing at saturation. ──
    volume_reaches = min(reaches, REACH_HIT_SATURATION)
    reach_volume = REACH_BASE + REACH_PER_HIT_WEIGHT * volume_reaches

    # ── Breadth term: more DISTINCT destinations outrank repeats of one. ──
    breadth = DISTINCT_DEST_WEIGHT * min(reached_distinct, DISTINCT_DEST_SATURATION)

    # ── Recency: current behaviour is what the operator acts on. ──
    recent = (
        newest_reach_age_minutes is not None
        and newest_reach_age_minutes <= RECENCY_WINDOW_MIN
    )
    recency = RECENCY_BONUS if recent else 0

    # ── ATTEMPT term: bounded so it can never outrank a reach. ──
    attempt_term = min(ATTEMPT_CAP, ATTEMPT_WEIGHT * attempts)

    if reaches > 0:
        score = _clamp(reach_volume + breadth + recency + attempt_term)
        level = _level_for(score)
        distinct_txt = (
            f"{reached_distinct} distinct blacklisted destination(s)"
            if reached_distinct
            else "no blacklisted destinations"
        )
        age_txt = (
            "no reach"
            if newest_reach_age_minutes is None
            else f"newest reach {newest_reach_age_minutes} min ago"
        )
        reason = {
            "rule": "graded_reach",
            "level": level,
            "score": score,
            "floored": False,
            "inputs": {
                "totalRequests": total,
                "riskRequests": reaches,
                "blacklistedRequests": max(0, blacklisted_risk),
                "blacklistedDistinct": reached_distinct,
                "enforcements": attempts,
                "reachCount": reaches,
                "attemptCount": attempts,
                "newestReachAgeMinutes": newest_reach_age_minutes,
                "riskShare": round(reaches / total, 4),
            },
            "text": (
                f"Graded from {reaches} reach(es) (ALLOW, the client got "
                f"through) over {total} request(s), {distinct_txt}, {age_txt}, "
                f"and {attempts} enforcement(s) (DENY) → {level} {score}/100."
            ),
        }
        return {"riskScore": score, "riskLevel": level, "riskReason": reason}

    # No reach: the only signal is ATTEMPT evidence, which is capped LOW.
    score = _clamp(attempt_term)
    level = _level_for(score)
    reason = {
        "rule": "graded_attempt_only",
        "level": level,
        "score": score,
        "floored": False,
        "inputs": {
            "totalRequests": total,
            "riskRequests": 0,
            "blacklistedRequests": 0,
            "blacklistedDistinct": 0,
            "enforcements": attempts,
            "reachCount": 0,
            "attemptCount": attempts,
            "newestReachAgeMinutes": None,
            "riskShare": 0.0,
        },
        "text": (
            f"No reach (nothing got through) but {attempts} enforcement(s) "
            f"(DENY) — intent evidence only, capped at {ATTEMPT_CAP} so an "
            f"attempt-only host always ranks below any host that reached a "
            f"prohibited destination → {level} {score}/100."
        ),
    }
    return {"riskScore": score, "riskLevel": level, "riskReason": reason}


# The two figures in section 02 come from DIFFERENT sources with different
# windows; label both so the report never implies they share one.
LIVE_WINDOW_SOURCE = "live Elasticsearch (block-pattern window)"
PERSISTED_SOURCE = "persisted findings (SQLite)"

def _normalize_minutes(minutes: int) -> int:
    """Map an accepted ``timeRange`` label to minutes (already-resolved
    ``minutes`` pass through). Mirrors the mapping in ``host_profile``."""
    return {
        "1h": 60, "24h": 1440, "3d": 4320, "7d": 10080,
        "30d": 43200, "90d": 129600, "1y": 525600,
    }.get(minutes, minutes)


def _window_label(minutes: int) -> str:
    if minutes <= 0:
        return "all time"
    if minutes % 1440 == 0:
        return f"{minutes // 1440}d"
    if minutes % 60 == 0:
        return f"{minutes // 60}h"
    return f"{minutes}m"


def _unavailable_risk_reason() -> dict:
    """The ES-unavailable state — deliberately carries NO score.

    A host the system could not measure must never render a plausible LOW
    (the old behaviour defaulted every count to 0, and ``0 -> LOW 12`` made an
    un-looked-at host indistinguishable from a clean one). The frontend
    branches on ``state == "unavailable"`` and renders this instead of a
    number.
    """
    return {
        "state": "unavailable",
        "reason": "es_offline_or_field_mode_unknown",
        "text": (
            "Elasticsearch unavailable — risk not computed. The field "
            "inventory is unresolved or the ES query failed, so no risk "
            "figure can be stated for this host. Do not read the counts below "
            "as zero activity."
        ),
    }


async def _host_byte_totals(ip: str, minutes: int) -> tuple[int | None, int | None]:
    """SUM the persisted byte counters for one host over the window.

    Returns ``(download, upload)`` summed over the host's persisted findings,
    or ``(None, None)`` when the host has no persisted rows (nothing to
    measure — a genuine ``None``, never a fabricated ``0``).

    Honesty caveat (docs/specs/... §j.5, app/services/logline.py:3-6): the
    flat ``bytes_downloaded`` column collapses the raw line's ``-``
    NOT-RECORDED sentinel to ``0``, so a summed ``0`` cannot be distinguished
    from "genuinely zero" using the persisted columns alone. The caller
    therefore renders the total as measured bytes; a ``0`` sum is the
    sum of the persisted values, not a claim that traffic was measured zero.
    """
    from app.database import get_db

    db = await get_db()
    try:
        clause = "WHERE client_ip = ?"
        params: list = [ip]
        if minutes:
            clause += " AND log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
            params.append(f"-{minutes} minutes")
        cursor = await db.execute(
            f"SELECT COALESCE(SUM(CAST(bytes_downloaded AS INTEGER)), 0), "
            f"COALESCE(SUM(CAST(bytes_uploaded AS INTEGER)), 0), "
            f"COUNT(*) FROM findings {clause}",
            params,
        )
        row = await cursor.fetchone()
    finally:
        await db.close()
    if not row or not row[2]:
        return None, None
    return int(row[0] or 0), int(row[1] or 0)


async def _aggregate_host(ip: str, minutes: int) -> dict | None:
    """Run the block-pattern window filtered to ``ip`` and aggregate the profile.

    Returns None when ES is offline or no block patterns are configured, so the
    route can fall back to a zeroed profile.
    """
    try:
        import pandas as pd  # noqa: I001

        from app.database import get_db
        from app.services.es_client import es_client
        from app.services.es_fields import get_mode
        from app.services.monitor import (
            _build_pattern_regex,
            build_logs_query,
            get_block_patterns,
            get_whitelist_patterns,
        )
        from app.services.result_processor import apply_filters

        if get_mode() == "UNKNOWN":
            return None

        settings = get_settings()
        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
            whitelist_patterns = await get_whitelist_patterns(db)
            bl_cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
            bl_rows = await bl_cursor.fetchall()
        finally:
            await db.close()
        if not block_patterns:
            return None
        blacklist_urls = {r["value"] for r in bl_rows if r["kind"] == "url"}
        blacklist_ips = {r["value"] for r in bl_rows if r["kind"] == "ip"}
        blacklist_domains = blacklist_urls | blacklist_ips

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(
            block_patterns, minutes, settings.es_query_size, client_ip=ip
        )

        async with es_client(settings, timeout=30) as es:
            res = await es.search(index=settings.elastic_index, body=query)

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            return {
                "totalRequests": 0,
                "riskRequests": 0,
                "enforcements": 0,
                "blacklistedRequests": 0,
                "blacklistedDistinct": 0,
                "newestReachAgeMinutes": None,
                "es_online": True,
            }

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            actions=None,
        )
        total = int(len(df))
        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            reach_mask = actions.isin(["ALLOW", ""])
            risk_requests = int(reach_mask.sum())
            enforcements = int(actions.isin(["DENY", "FLAG"]).sum())
            blacklisted_mask = df["base_url"].astype(str).isin(blacklist_domains)
            blacklisted_requests = int((blacklisted_mask & reach_mask).sum())
        else:
            # Legacy rows carry no action — every block-pattern hit was an
            # ALLOW risk by construction.
            reach_mask = pd.Series(True, index=df.index)
            risk_requests = total
            enforcements = 0
            blacklisted_mask = df["base_url"].astype(str).isin(blacklist_domains)
            blacklisted_requests = int(blacklisted_mask.sum())

        # Breadth: how many DISTINCT blacklisted destinations were REACHed.
        # `base_url` is a persisted field (not a proxy) — this is a real
        # measurement of how many targets the host actually touched.
        reach_base_urls = df.loc[blacklisted_mask & reach_mask, "base_url"]
        blacklisted_distinct = int(reach_base_urls.astype(str).nunique())

        # Recency: age (minutes) of the most recent REACH in the window. Uses
        # the persisted @timestamp, never a synthesized figure. `None` when
        # there was no reach — an explicit unavailable state, never a fake 0.
        newest_reach_age_minutes: int | None = None
        if risk_requests > 0 and "@timestamp" in df.columns:
            reach_ts = pd.to_datetime(
                df.loc[reach_mask, "@timestamp"], errors="coerce", utc=True
            ).dropna()
            if not reach_ts.empty:
                newest = reach_ts.max()
                age = (pd.Timestamp.now(tz="UTC") - newest).total_seconds() / 60.0
                newest_reach_age_minutes = int(max(0, age))

        return {
            "totalRequests": total,
            "riskRequests": risk_requests,
            "enforcements": enforcements,
            "blacklistedRequests": blacklisted_requests,
            "blacklistedDistinct": blacklisted_distinct,
            "newestReachAgeMinutes": newest_reach_age_minutes,
            "es_online": True,
        }
    except Exception:
        return None


@router.get("/{ip}")
async def host_profile(
    ip: str,
    minutes: int = Query(1440, ge=0, le=525600),
    timeRange: str = Query("24h", max_length=8),
):
    """Host profile for one client IP (Host Inspector page).

    ``minutes`` drives the ES window (defaults to the 24h FilterContext default).
    Returns a flat ``HostProfile``-shaped payload:
    ``{ hostname, primaryIp, ip, es_online, risk: { riskScore, riskLevel,
    totalRequests, riskRequests, enforcements, enforcementsPct, bandwidth,
    riskReason, sources } }``.

    Additive contract (2026-09-21): the risk sub-dict carries ``riskReason``
    (WHICH rule produced the level, and its inputs) and ``sources`` (which
    store each figure came from, and over what window). The score itself is now
    GRADED (see ``_risk_from_shares``) rather than a flat blacklist floor.
    Existing keys are unchanged.
    """
    settings = get_settings()

    # Prefer the explicit minutes param; map the FilterContext timeRange label
    # when no minutes is passed.
    if minutes == 1440 and timeRange:
        minutes = {
            "1h": 60, "24h": 1440, "3d": 4320, "7d": 10080,
            "30d": 43200, "90d": 129600, "1y": 525600,
        }.get(timeRange, 1440)

    agg = await _aggregate_host(ip, minutes)
    es_online = bool(agg and agg["es_online"])
    risk_available = agg is not None
    total = (agg or {}).get("totalRequests", 0)
    risk_requests = (agg or {}).get("riskRequests", 0)
    blacklisted_requests = (agg or {}).get("blacklistedRequests", 0)
    blacklisted_distinct = (agg or {}).get("blacklistedDistinct", 0)
    newest_reach_age_minutes = (agg or {}).get("newestReachAgeMinutes")
    enforcements = (agg or {}).get("enforcements", 0)
    enforcements_pct = (enforcements / total) * 100 if total > 0 else 0

    # Real byte totals from persisted findings — an ES-independent path, so
    # the figure survives an Elasticsearch outage. `bandwidthNeverMeasured`
    # marks "nothing to sum": the total is never invented, and a measured 0 is
    # never conflated with an absence of data.
    bandwidth_download, bandwidth_upload = await _host_byte_totals(ip, minutes)
    bandwidth_never_measured = bandwidth_download is None
    if risk_available:
        risk = _risk_from_shares(
            total,
            risk_requests,
            blacklisted_requests,
            blacklisted_distinct=blacklisted_distinct,
            enforcements=enforcements,
            newest_reach_age_minutes=newest_reach_age_minutes,
        )
        risk_reason = risk["riskReason"]
    else:
        # ES unreachable / field mode UNKNOWN: the score itself is unknown.
        # Keep riskScore/riskLevel for backwards-compatibility (they default to
        # the old values) but mark the reason unavailable so the UI renders the
        # unavailable state instead of a plausible LOW.
        risk = _risk_from_shares(0, 0, 0)
        risk_reason = _unavailable_risk_reason()

    window = _window_label(_normalize_minutes(minutes))
    sources = {
        # Which store produced the risk numbers on screen, and over what window.
        # Section 02 of the report must state both — the score is LIVE and the
        # detail tables are PERSISTED, and the two can disagree.
        "risk": {
            "source": LIVE_WINDOW_SOURCE if risk_available else None,
            "window": window,
            "available": risk_available,
            "persisted_detail": PERSISTED_SOURCE,
            "persisted_detail_window": "all time",
        },
    }

    return {
        "hostname": f"Host-{ip.split('.').pop() if ip.split('.') else ip[:4]}",
        "primaryIp": ip,
        "ip": ip,
        "es_online": es_online,
        "risk": {
            "riskScore": risk["riskScore"],
            "riskLevel": risk["riskLevel"],
            "totalRequests": total,
            "riskRequests": risk_requests,
            "enforcements": enforcements,
            "blacklistedRequests": blacklisted_requests,
            # Distinct blacklisted destinations REACHed (breadth) — a persisted
            # `base_url` count, additive to the payload.
            "blacklistedDistinct": blacklisted_distinct,
            "enforcementsPct": round(enforcements_pct, 1),
            # Real byte totals from persisted findings — `null` when nothing
            # was persisted, with bandwidthNeverMeasured marking that state.
            "bandwidthDownload": bandwidth_download,
            "bandwidthUpload": bandwidth_upload,
            "bandwidthNeverMeasured": bandwidth_never_measured,
            # No synthesized display string; kept as a null legacy key.
            "bandwidth": None,
            "riskScoreAvailable": risk_available,
            "riskReason": risk_reason,
            "sources": sources,
        },
    }
