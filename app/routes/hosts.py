"""Host Inspector backend — GET /api/hosts/{ip}.

Aggregates the live Elasticsearch block-pattern window for a single client IP
into the flat ``HostProfile`` shape the Host Inspector page renders. Risk is
framed per ADR 0001: ``riskRequests`` are ALLOW pattern-matches (need action),
``enforcements`` are DENY/FLAG (the proxy already handled them). No MAC / dept /
user identity is surfaced — a host is an IP + optional hostname.

Elasticsearch failures degrade honestly: the endpoint never 500s, it returns
``es_online: false`` and a zeroed profile so the page still renders.
"""

from datetime import UTC, datetime

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

    # The empty-window gate. `total` is the block-pattern frame, which is
    # blind to DENY rows recorded against a non-pattern URL — so a host the
    # proxy denied repeatedly can have `total == 0` while `enforcements > 0`.
    # That host HAS a recorded disposition and must not be reported as the
    # model's empty-window baseline ("no traffic ... not a measurement"); the
    # attempt-only branch below is the honest reading. The gate therefore
    # fires only when there is genuinely NO evidence on either population.
    # No constant or weight changes: the terms that produce the score are
    # untouched, and `enforcements` still feeds the model as before.
    if total <= 0 and attempts <= 0:
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


def _both_stores_unavailable_reason() -> dict:
    """The both-stores-empty state — deliberately carries NO score.

    The live ES window yielded nothing usable (ES unreachable, the field
    inventory unresolved, or no block patterns configured) AND the persisted
    findings table holds no row for this host in the window either. There is
    nothing to grade, so the honest answer is an explicit unavailable state,
    never the empty-window 0 baseline (a host we never observed must not read
    the same as a host we observed to be clean).
    """
    return {
        "state": "unavailable",
        "reason": "no_live_window_and_no_persisted_findings",
        "text": (
            "No risk figure could be computed — Elasticsearch is unavailable "
            "or unresolved (no block patterns configured) AND the persisted "
            "findings table holds no row for this host in the window. Neither "
            "store produced a measurement. Do not read the counts below as "
            "zero activity."
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


# ── Persisted-findings fallback (2026-09-21) ───────────────────────────────
#
# The live ES path above is the PREFERRED source, but it is not always there:
# ES is unreachable, the field inventory is UNKNOWN, or the operator has not
# configured a block pattern yet. When that happens the route below used to
# hand the client an "unavailable" state and nothing else — and the client
# then computed its OWN risk score from a findings query, using a second copy
# of this model's 14 constants and hardcoding the breadth and enforcement
# terms to 0. Two implementations of one graded model silently disagreed.
#
# The fallback closes that seam by grading the PERSISTED findings table here,
# in the owner of the model. The shape of the query follows
# ``app/routes/analytics.py`` / ``app/routes/client_report.py``: a
# ``WHERE client_ip = ?`` scope plus the shared window clause, and the
# ADR 0001 row semantics expressed by ``_row_is_risk`` / ``_row_is_enforced``.
# The helpers are imported, never re-implemented, so there is exactly one
# statement of what "a risk" and "an enforcement" mean.
#
# What this path does NOT carry, and refuses to invent:
#  - It does not use ``duration_seconds`` (or any other column) as a volume
#    proxy: the live path's ``total`` is an ES hit count, and nothing in the
#    persisted table measures that. ``total`` is therefore the persisted row
#    count, and ``riskRequests`` is the subset of it that passed
#    ``_row_is_risk`` — so the reason states ``total``/``reaches`` in the same
#    "all persisted block-pattern evidence" sense the live path means.
#  - It does not read byte counters for the risk inputs (``bytes_*`` collapse
#    the ``-`` NOT-RECORDED sentinel to 0 and are structurally 0 on DENY rows);
#    the byte totals the route reports still come from ``_host_byte_totals``.
#  - It does not claim the live ES window. ``sources.risk.source`` names this
#    store so the report can never present a persisted score as a live one.

# The findings table is created by ``database.py.init_db`` without the rich
# proxy columns and gets them via ALTER; a query must probe for the ones it
# reads. '' means the column is absent — never a value.
_FINDINGS_SQL_COLUMNS = ("action", "base_url", "log_timestamp")


async def _fetch_findings_rows(db, ip: str, minutes: int) -> list[dict]:
    """Every persisted findings row for one host, scoped to the window.

    ``SELECT *`` (like the analytics/client-report paths) so a database that
    predates a column still yields a row dict for the row-semantics helpers.
    The window clause is evaluated by SQLite (UTC), never by the Python clock.
    """
    clause = "WHERE client_ip = ?"
    params: list = [ip]
    if minutes > 0:
        clause += " AND log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
        params.append(f"-{minutes} minutes")
    cursor = await db.execute(f"SELECT * FROM findings {clause}", params)
    return [dict(row) for row in await cursor.fetchall()]


# ── Domain-level reach measurement (2026-09-25) ─────────────────────────────
#
# With the block-pattern clause widened to `url OR base_url`, the reach frame
# now also contains the sibling-path rows of a flagged domain
# (`https://x.example/a`, `/b`, `/c`…), which URL-only matching missed. The
# operator reads that frame as "how much did this host hit THIS destination",
# so the aggregate reports the domain-level view explicitly rather than
# leaving the UI to re-derive it from the URL-only rows it used to see.
#
# `DOMAIN_REACH_LIMIT` caps the per-domain list. It is a DISPLAY cap, not a
# measurement cap: `domainMatchCount` counts every matching row in the frame,
# the list simply names the busiest ten destinations (the tail lives in the
# table, which shows the rows themselves).
DOMAIN_REACH_LIMIT = 10


def _domain_reach_breakdown(df, predicate) -> tuple[list[dict], int]:
    """The domain-level reach view of a frame: per-domain counts + row count.

    ``predicate(row) -> bool`` is the shared block-pattern test
    (`query_builder.build_pattern_match_predicate`) — the SAME rule the ES
    clause applies, evaluated over the frame we already hold, so this adds no
    round-trip and no store. Rows are the block-pattern hits of that frame; a
    row counts toward its DOMAIN (``result_processor.extract_domain``), so one
    flagged domain reached through many sibling paths contributes every path.

    Returns ``(domains, domain_match_count)`` where ``domains`` is sorted by
    hit count DESC (then domain ASC, so equal counts are deterministic) and
    capped to `DOMAIN_REACH_LIMIT`. An empty frame yields ``([], 0)`` — an
    empty list, never a fabricated entry.
    """
    from app.services.result_processor import extract_domain
    counts: dict[str, int] = {}
    for row in df.to_dict("records"):
        if predicate(row):
            domain = extract_domain(row)
            counts[domain] = counts.get(domain, 0) + 1
    domains = [
        {"domain": domain, "count": count}
        for domain, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return domains[:DOMAIN_REACH_LIMIT], sum(counts.values())


async def _load_block_patterns() -> list[str]:
    """The configured block patterns — ONE reader for both aggregate paths.

    The live path already opens a DB session for its patterns and blacklist;
    the persisted path opens one here. Sharing the reader keeps the two paths'
    definition of "a block pattern" identical (more important now that the
    match is URL-or-domain on both).
    """
    from app.database import get_db
    from app.services.monitor import get_block_patterns

    db = await get_db()
    try:
        return await get_block_patterns(db)
    finally:
        await db.close()


async def _aggregate_host_from_findings(ip: str, minutes: int) -> dict | None:
    """Grade the PERSISTED findings table for one host — the fallback source.

    Returns the same graded-input shape ``_aggregate_host`` returns, with
    ``es_online: False`` and a ``persisted`` marker, or ``None`` when the host
    has no persisted row in the window (nothing to grade — an explicit
    unavailable, never a fabricated 0).

    Every input is a persisted field: ``action`` (via ADR 0001 row semantics)
    decides reach vs attempt, ``base_url`` membership in ``blacklist_entries``
    decides breadth, and ``log_timestamp`` decides recency. No proxy formula,
    no defaulted count.
    """
    from app.database import get_db
    from app.routes.analytics import (
        _column_names,
        _has_column,
        _parse_matched_patterns,
        _row_is_enforced,
        _row_is_risk,
    )
    from app.services.monitor import build_pattern_match_predicate
    from app.services.result_processor import extract_domain

    db = await get_db()
    try:
        rows = await _fetch_findings_rows(db, ip, minutes)
        if not rows:
            return None
        columns = await _column_names(db)
        kind_cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
        blacklist_rows = await kind_cursor.fetchall()
    finally:
        await db.close()
    has_action = _has_column(columns, "action")
    blacklist_domains = {r["value"] for r in blacklist_rows if r["value"]}

    # Domain-level reach — the SAME definitions the live path reports, so the
    # two stores hand the UI one shape (their numbers may legitimately differ;
    # see the ``totalRequests`` note below). A persisted row's domain comes
    # from its ``base_url`` column with the SAME shared helper the live path
    # uses (`extract_domain` → `_domain_of_base`), which falls back to parsing
    # the stored ``url``'s authority when ``base_url`` is empty. The SAME
    # shared matcher decides the hit, so the ES clause and this annotation
    # cannot drift.
    block_patterns = await _load_block_patterns()
    match = build_pattern_match_predicate(block_patterns)
    domain_match_count = sum(1 for r in rows if match(r))
    domains: dict[str, int] = {}
    for r in rows:
        if match(r):
            domains[extract_domain(r)] = domains.get(extract_domain(r), 0) + 1
    flagged_domains = [
        {"domain": domain, "count": count}
        for domain, count in sorted(domains.items(), key=lambda kv: (-kv[1], kv[0]))
    ][:DOMAIN_REACH_LIMIT]

    reach_rows = [r for r in rows if _row_is_risk(r, has_action)]
    attempt_rows = [r for r in rows if _row_is_enforced(r, has_action)]

    # Breadth: DISTINCT blacklisted destinations actually REACHED, by the
    # persisted ``base_url`` — real membership from the operator's blacklist,
    # not the hardcoded 0 the deleted client mirror used on this path.
    blacklisted_reaches = [
        r for r in reach_rows if (r.get("base_url") or "") in blacklist_domains
    ]
    blacklisted_distinct = len(
        {r.get("base_url") for r in blacklisted_reaches if r.get("base_url")}
    )

    # Recency: age (minutes) of the newest persisted REACH. LEGACY rows were
    # stored before ``action`` existed at all — an empty action plus a non-empty
    # ``matched_patterns`` is an ALLOW risk (ADR 0001), so those count. A row
    # with an explicit ``action`` and no ``matched_patterns`` is a DENY-only
    # persistence state: whether it was an ALLOW match is NOT RECORDED, and an
    # unrecorded timestamp must never be promoted into a recency that would
    # ADD points to the score. It is excluded from the recency input only.
    newest_reach_age_minutes: int | None = None
    reach_timestamps = [
        r.get("log_timestamp") or ""
        for r in reach_rows
        if (r.get("action") or "").strip() == ""
        or _parse_matched_patterns(r.get("matched_patterns"))
    ]
    valid_timestamps = []
    for ts in reach_timestamps:
        try:
            parsed = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        valid_timestamps.append(parsed)
    if valid_timestamps:
        newest = max(valid_timestamps)
        age = (datetime.now(UTC) - newest).total_seconds() / 60.0
        newest_reach_age_minutes = int(max(0, age))

    return {
        # An ENFORCEMENT is the same thing on both sources: a row whose
        # persisted ``action`` is DENY/FLAG (via ``_row_is_enforced`` — the
        # canonical ADR 0001 row semantics, shared with analytics). The live
        # path measures that same predicate over ES with an action-filtered
        # query; this path measures it over the persisted table. The
        # DEFINITION is identical even though the two stores hold different
        # evidence — the live window is not deduplicated and current, the
        # findings table is deduped by (client_ip, url, log_timestamp) and
        # accumulated by the poll — so the counts may legitimately differ and
        # ``sources.risk.source`` names which store answered. What must never
        # differ is what counts as an enforcement. An enforcement does NOT
        # require a block-pattern match on either path: the proxy records a
        # DENY against the destination it refused, which need not be a URL any
        # pattern names.
        #
        # ``totalRequests`` here is the count of RECORDED FINDINGS for this
        # host in the window — a deduplicated, filtered population. This is
        # NOT the live path's ``total`` (block-pattern hits in the ES window,
        # whitelist-filtered only): findings are deduped by
        # (client_ip, url, log_timestamp) and, in whitelist-excluding modes, a
        # further-filtered subset, recorded over time by the poll rather than
        # measured once over the window. Both are real persisted/measured
        # counts; they are different quantities, and the model's emptiness
        # gate only needs ``> 0``.
        "totalRequests": len(rows),
        "riskRequests": len(reach_rows),
        "enforcements": len(attempt_rows),
        "blacklistedRequests": len(blacklisted_reaches),
        "blacklistedDistinct": blacklisted_distinct,
        # Domain-level reach: the rows whose DOMAIN matches a block pattern
        # (>= the URL-only count), and the distinct flagged domains with their
        # hit counts. Same definitions and shape as the live path.
        "domainMatchCount": domain_match_count,
        "flaggedDomains": flagged_domains,
        "newestReachAgeMinutes": newest_reach_age_minutes,
        "es_online": False,
        "persisted": True,
    }


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
            build_pattern_match_predicate,
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
        # Two searches, because a reach and an enforcement are different
        # questions about different row populations and ONE query cannot
        # answer both:
        #   * REACH  (totalRequests / riskRequests / blacklisted* / recency)
        #     is a block-pattern match — the pattern clause is the point.
        #   * ENFORCEMENT (enforcements) is an `action` the proxy recorded.
        #     The proxy logs a DENY against the destination it refused, whose
        #     URL need not contain any block pattern (a bare host, an IP, the
        #     SNI). Asking for DENYs through the pattern-filtered query
        #     therefore returned zero rows and the figure read 0 on ordinary
        #     traffic, which is the defect this split fixes.
        # Both searches share the one `es_client` session below.
        reach_query = build_logs_query(
            block_patterns, minutes, settings.es_query_size, client_ip=ip
        )
        # Count-only: no documents are needed, just the total. `_source` off
        # and `size: 0` keep the second round-trip cheap.
        enforcement_query = build_logs_query(
            block_patterns,
            minutes,
            0,
            client_ip=ip,
            fields=[],
            actions=["DENY", "FLAG"],
        )
        enforcement_query["track_total_hits"] = True

        async with es_client(settings, timeout=30) as es:
            res = await es.search(index=settings.elastic_index, body=reach_query)
            enf_res = await es.search(
                index=settings.elastic_index, body=enforcement_query
            )

        # The proxy's own count of DENY/FLAG rows for this host in the window —
        # a measurement over the enforcement population, independent of whether
        # any of those rows matched a block pattern.
        enforcements = int(
            enf_res.get("hits", {}).get("total", {}).get("value", 0)
        )

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            # No REACH traffic matched a block pattern in the window. That is
            # NOT the same as "nothing happened": the host may still have been
            # DENIED repeatedly, and `enforcements` above is that real count.
            # Returning it here keeps a host with 3 proxy DENYs and 0 reaches
            # reporting 3 enforcements / 0 reaches instead of a bare 0 that
            # reads as a measurement of no activity at all.
            return {
                "totalRequests": 0,
                "riskRequests": 0,
                "enforcements": enforcements,
                "blacklistedRequests": 0,
                "blacklistedDistinct": 0,
                # No reach traffic → no flagged domain, an EMPTY list (not a
                # fabricated entry) and a domain-level count of 0.
                "domainMatchCount": 0,
                "flaggedDomains": [],
                "newestReachAgeMinutes": None,
                "es_online": True,
            }

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            actions=None,
        )
        total = int(len(df))
        # Reach shares come from the PATTERN frame. `enforcements` does NOT:
        # it is the proxy's action count measured above, over a population this
        # frame cannot see (and must not pretend to). Deriving it here from
        # `actions.isin(["DENY", "FLAG"])` was the defect — it counted only the
        # DENYs that happened to match a block pattern.
        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            reach_mask = actions.isin(["ALLOW", ""])
            risk_requests = int(reach_mask.sum())
            blacklisted_mask = df["base_url"].astype(str).isin(blacklist_domains)
            blacklisted_requests = int((blacklisted_mask & reach_mask).sum())
        else:
            # Legacy rows carry no action — every block-pattern hit was an
            # ALLOW risk by construction.
            reach_mask = pd.Series(True, index=df.index)
            risk_requests = total
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

        # Domain-level reach, over the frame already in hand (no third ES
        # round-trip): which domains the block pattern flagged, and how many
        # rows each. Widening the clause ships sibling-path rows for a flagged
        # domain, so this count is >= the url-only count and `total` above
        # already equals the widened frame — the UI count and the table agree.
        # A `url`-only row still contributes: `extract_domain` parses its URL.
        flagged_domains, domain_match_count = _domain_reach_breakdown(
            df, build_pattern_match_predicate(block_patterns)
        )

        return {
            "totalRequests": total,
            "riskRequests": risk_requests,
            "enforcements": enforcements,
            "blacklistedRequests": blacklisted_requests,
            "blacklistedDistinct": blacklisted_distinct,
            "domainMatchCount": domain_match_count,
            "flaggedDomains": flagged_domains,
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

    Single-sourced fallback (2026-09-21): when the live ES window yields
    nothing, the route grades the PERSISTED findings table instead of handing
    the client an unavailable state to fill in itself. ``sources.risk.source``
    names whichever store answered; ``es_online`` stays false on the fallback
    (it reports ES liveness, not score availability). Only when BOTH stores are
    empty is the explicit unavailable state returned.
    """
    settings = get_settings()

    # Prefer the explicit minutes param; map the FilterContext timeRange label
    # when no minutes is passed.
    if minutes == 1440 and timeRange:
        minutes = {
            "1h": 60, "24h": 1440, "3d": 4320, "7d": 10080,
            "30d": 43200, "90d": 129600, "1y": 525600,
        }.get(timeRange, 1440)

    live_agg = await _aggregate_host(ip, minutes)

    # Fallback: grade the persisted findings table when the live path yielded
    # nothing. The model is unchanged — only WHERE its inputs come from — so a
    # host whose ES window is unavailable still gets the SAME graded answer the
    # live path would have produced from the same evidence. `_risk_from_shares`
    # is called in both branches and nowhere else.
    agg = live_agg
    if agg is None:
        agg = await _aggregate_host_from_findings(ip, minutes)

    risk_available = agg is not None
    from_persisted = bool(agg and agg.get("persisted"))
    # ES liveness is reported independently of score availability: the fallback
    # answered, but Elasticsearch itself is still down.
    es_online = bool(live_agg and live_agg["es_online"])
    total = (agg or {}).get("totalRequests", 0)
    risk_requests = (agg or {}).get("riskRequests", 0)
    blacklisted_requests = (agg or {}).get("blacklistedRequests", 0)
    blacklisted_distinct = (agg or {}).get("blacklistedDistinct", 0)
    newest_reach_age_minutes = (agg or {}).get("newestReachAgeMinutes")
    enforcements = (agg or {}).get("enforcements", 0)
    # Domain-level reach, measured over the same frame `total` counts. The UI
    # count and the table cannot disagree because `total` IS the widened frame
    # and `domainMatchCount` is that frame's block-pattern subset.
    domain_match_count = (agg or {}).get("domainMatchCount", 0)
    flagged_domains = (agg or {}).get("flaggedDomains", [])

    # The share is the enforcement fraction of a DENOMINATOR that includes
    # them: block-pattern hits (totalRequests) plus the enforcements the
    # pattern query cannot see. Dividing by `total` alone would read 3
    # enforcements over 0 reaches as 0%, and could exceed 100% when the
    # pattern frame is the smaller of the two populations. A DENY-only host
    # therefore shows 100% enforcements — the honest reading of "every
    # decision recorded for this host was a block".
    _decision_population = total + enforcements
    enforcements_pct = (
        (enforcements / _decision_population) * 100
        if _decision_population > 0
        else 0
    )
    # Real byte totals from persisted findings — an ES-independent path, so
    # the figure survives an Elasticsearch outage. `bandwidthNeverMeasured`
    # marks "nothing to sum": the total is never invented, and a measured 0 is
    # never conflated with an absence of data.
    bandwidth_download, bandwidth_upload = await _host_byte_totals(ip, minutes)
    bandwidth_never_measured = bandwidth_download is None
    if risk_available:
        # `total` is the real block-pattern frame — a measured count, never a
        # synthesized population. The empty-window gate inside the model knows
        # that a DENY-only host is not "no traffic" (see `_risk_from_shares`),
        # so the enforcement evidence reaches the attempt-only branch without
        # inflating any reported input.
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
        # Both stores came back empty: the score itself is unknown. Keep
        # riskScore/riskLevel for backwards-compatibility (they default to the
        # old values) but mark the reason unavailable so the UI renders the
        # unavailable state instead of a plausible LOW.
        risk = _risk_from_shares(0, 0, 0)
        risk_reason = _both_stores_unavailable_reason()

    window = _window_label(_normalize_minutes(minutes))
    if from_persisted:
        risk_source = PERSISTED_SOURCE
    elif risk_available:
        risk_source = LIVE_WINDOW_SOURCE
    else:
        risk_source = None
    sources = {
        # Which store produced the risk numbers on screen, and over what window.
        # Section 02 of the report must state both — the two stores hold
        # different evidence and can disagree, so the score must never be
        # presented under the other store's name.
        "risk": {
            "source": risk_source,
            "window": window,
            "available": risk_available,
            "persisted_detail": PERSISTED_SOURCE,
            "persisted_detail_window": _window_label(_normalize_minutes(minutes))
            if from_persisted
            else "all time",
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
            # Domain-level reach: rows whose DOMAIN matches a block pattern
            # (>= the url-only count, since the pattern clause now matches
            # `url OR base_url`) and the distinct flagged domains with their
            # hit counts, busiest first, capped. Empty list when the host
            # reached nothing — never a fabricated entry.
            "domainMatchCount": domain_match_count,
            "flaggedDomains": flagged_domains,
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
