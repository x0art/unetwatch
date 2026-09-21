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

# Deny-rate brackets for the risk level (share of the window that was enforced).
# A host whose traffic is mostly enforced is low-risk; mostly-ALLOW matches are
# high-risk because the proxy did NOT stop them.


def _risk_from_shares(
    total: int, risk_requests: int, blacklisted_risk: int = 0
) -> dict:
    """Map total/risk counts to a risk score + level (ADR 0001).

    ``blacklisted_risk`` counts ALLOWed requests to blacklisted destinations —
    an operator explicitly flagged the target and the proxy still let it
    through, the highest-risk signal. Any such request escalates to HIGH.

    The returned dict carries a ``riskReason`` alongside the score so a caller
    can never render the score without its justification (see
    ``_unavailable_risk_reason`` for the ES-unavailable case, which this pure
    helper has no way to see):

    ``{"rule", "level", "score", "floored", "inputs", "text"}``

    - ``rule`` names WHICH branch fired, so a floored 92 is distinguishable
      from a measured 92 (``blacklisted_destination_floor`` vs a share
      bracket) — the operator's actual case.
    - ``floored`` is True only when the hardcoded 92 floor raised the score.
    - ``inputs`` are the exact counts the branch consumed.
    - ``text`` is the operator-facing sentence, stated in ADR 0001 vocabulary
      ("risk (ALLOW matches)", "enforcements (DENY)").
    """
    if total <= 0:
        score = 12
        level = "LOW"
        reason = {
            "rule": "no_traffic",
            "level": level,
            "score": score,
            "floored": False,
            "inputs": {
                "totalRequests": total,
                "riskRequests": risk_requests,
                "blacklistedRequests": blacklisted_risk,
            },
            "text": (
                "No traffic in the window — score is the model's empty-window "
                "baseline, not a measurement."
            ),
        }
        return {"riskScore": score, "riskLevel": level, "riskReason": reason}
    share = risk_requests / total
    if share > 0.5:
        score = min(95, 72 + round((share - 0.5) * 40))
        level = "HIGH"
        rule = "share_above_0.5"
    elif share > 0.2:
        score = round(45 + ((share - 0.2) / 0.3) * 25)
        level = "MEDIUM"
        rule = "share_above_0.2"
    else:
        score = round(12 + (share / 0.2) * 32)
        level = "LOW"
        rule = "share_at_or_below_0.2"
    reason = {
        "rule": rule,
        "level": level,
        "score": score,
        "floored": False,
        "inputs": {
            "totalRequests": total,
            "riskRequests": risk_requests,
            "blacklistedRequests": blacklisted_risk,
            "riskShare": round(share, 4),
        },
        "text": (
            f"{risk_requests} of {total} requests were risk (ALLOW matches) "
            f"— {share:.1%} share → {level} bracket ({rule})."
        ),
    }
    if blacklisted_risk > 0:
        floored = max(92, score)
        # The floor fires whenever a blacklisted destination was ALLOWed. It is
        # a FLAT 92, not a graded measurement — say so, and keep the bracket
        # the share alone would have produced so the two are comparable.
        return {
            "riskScore": floored,
            "riskLevel": "HIGH",
            "riskReason": {
                "rule": "blacklisted_destination_floor",
                "level": "HIGH",
                "score": floored,
                "floored": True,
                "inputs": {
                    "totalRequests": total,
                    "riskRequests": risk_requests,
                    "blacklistedRequests": blacklisted_risk,
                    "riskShare": round(share, 4),
                },
                "text": (
                    f"Escalated to HIGH by the blacklisted-destination rule: "
                    f"{blacklisted_risk} risk (ALLOW) request(s) reached a "
                    f"destination on the blacklist. Score is the flat "
                    f"{floored} floor, not a graded measurement "
                    f"(share-only bracket would be {level} {score})."
                ),
            },
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


def _synthesize_bandwidth(total_requests: int) -> str:
    """Byte accounting not yet on the host profile — scale a placeholder."""
    if total_requests <= 0:
        return "—"
    if total_requests < 1000:
        return f"{(total_requests * 0.12):.1f} MB"
    return f"{(total_requests / 1024):.1f} GB"


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
            risk_requests = int(actions.isin(["ALLOW", ""]).sum())
            enforcements = int(actions.isin(["DENY", "FLAG"]).sum())
            blacklisted_requests = int(
                (
                    df["base_url"].astype(str).isin(blacklist_domains)
                    & actions.isin(["ALLOW", ""])
                ).sum()
            )
        else:
            # Legacy rows carry no action — every block-pattern hit was an
            # ALLOW risk by construction.
            risk_requests = total
            enforcements = 0
            blacklisted_requests = int(
                df["base_url"].astype(str).isin(blacklist_domains).sum()
            )
        return {
            "totalRequests": total,
            "riskRequests": risk_requests,
            "enforcements": enforcements,
            "blacklistedRequests": blacklisted_requests,
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
    store each figure came from, and over what window). Existing keys are
    unchanged.
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
    risk_available = agg is not None
    es_online = bool(agg and agg["es_online"])
    total = (agg or {}).get("totalRequests", 0)
    risk_requests = (agg or {}).get("riskRequests", 0)
    blacklisted_requests = (agg or {}).get("blacklistedRequests", 0)
    enforcements = (agg or {}).get("enforcements", 0)
    enforcements_pct = (enforcements / total) * 100 if total > 0 else 0

    if risk_available:
        risk = _risk_from_shares(total, risk_requests, blacklisted_requests)
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
            "enforcementsPct": round(enforcements_pct, 1),
            "riskScoreAvailable": risk_available,
            "riskReason": risk_reason,
            "sources": sources,
            "bandwidth": _synthesize_bandwidth(total),
        },
    }
