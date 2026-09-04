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
    """
    if total <= 0:
        score = 12
        level = "LOW"
    else:
        share = risk_requests / total
        if share > 0.5:
            score = min(95, 72 + round((share - 0.5) * 40))
            level = "HIGH"
        elif share > 0.2:
            score = round(45 + ((share - 0.2) / 0.3) * 25)
            level = "MEDIUM"
        else:
            score = round(12 + (share / 0.2) * 32)
            level = "LOW"
    if blacklisted_risk > 0:
        return {"riskScore": max(92, score), "riskLevel": "HIGH"}
    return {"riskScore": score, "riskLevel": level}


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
    minutes: int = Query(1440, ge=0, le=43200),
    timeRange: str = Query("24h", max_length=8),
):
    """Host profile for one client IP (Host Inspector page).

    ``minutes`` drives the ES window (defaults to the 24h FilterContext default).
    Returns a flat ``HostProfile``-shaped payload:
    ``{ hostname, primaryIp, ip, risk: { riskScore, riskLevel, totalRequests,
    riskRequests, enforcements, enforcementsPct, bandwidth } }``
    """
    settings = get_settings()

    # Prefer the explicit minutes param; map the FilterContext timeRange label
    # when no minutes is passed.
    if minutes == 1440 and timeRange:
        minutes = {"1h": 60, "24h": 1440, "7d": 10080, "30d": 43200}.get(timeRange, 1440)

    agg = await _aggregate_host(ip, minutes)
    es_online = bool(agg and agg["es_online"])
    total = (agg or {}).get("totalRequests", 0)
    risk_requests = (agg or {}).get("riskRequests", 0)
    enforcements = (agg or {}).get("enforcements", 0)
    blacklisted_requests = (agg or {}).get("blacklistedRequests", 0)

    risk = _risk_from_shares(total, risk_requests, blacklisted_requests)
    enforcements_pct = (enforcements / total) * 100 if total > 0 else 0

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
            "bandwidth": _synthesize_bandwidth(total),
        },
    }
