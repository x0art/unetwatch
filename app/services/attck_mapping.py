"""MITRE ATT&CK mapping service.

Maps client-IP hosts and URLs to ATT&CK techniques by running the same
block-pattern ES query that drives the rest of the app, then applying a
fixed set of heuristics over the resulting dataframes.

Designed as a thin bridge between the monitoring stack and the ATT&CK
visualisation — it never 500s; every exception falls through to an
``es_online=False`` sentinel payload.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from app.config import get_settings
from app.database import get_db
from app.services.es_client import es_client
from app.services.monitor import (
    build_logs_query,
    get_block_patterns,
    get_whitelist_patterns,
    _build_pattern_regex,
)
from app.services.query_builder import QUERY_SOURCE_FIELDS
from app.services.result_processor import apply_filters, build_timeline


# ── Heuristic catalog (technique_id → metadata) ────────────────────────────

_HOST_HEURISTICS: dict[str, dict[str, object]] = {
    "T1071.001": {
        "name": "Application Layer Protocol: Web Protocols",
        "severity": "auto",  # HIGH / MEDIUM based on thresholds
        "description": "Excessive requests to diverse domains suggest HTTP(S) traffic used as a command-and-control channel.",
    },
    "T1090.003": {
        "name": "Proxy: Multi-hop Proxy",
        "severity": "MEDIUM",
        "description": "Traffic routed through CDN/proxy infrastructure may indicate network isolation or evasion.",
    },
    "T1029.001": {
        "name": "Scheduled Transfer: Regular Data Staging",
        "severity": "MEDIUM",
        "description": "High destination diversity with few enforcements suggests scheduled data exfiltration.",
    },
    "T1053.005": {
        "name": "Scheduled Task/Job: Scheduled Task",
        "severity": "LOW",
        "description": "Highly periodic request patterns may indicate automated tooling or scheduled payloads.",
    },
    "T1041": {
        "name": "Exfiltration Over C2 Channel",
        "severity": "LOW",
        "description": "Large byte transfers to multiple risk domains may indicate data staged over C2.",
    },
}

_URL_HEURISTICS: dict[str, dict[str, object]] = {
    "T1071.001": {
        "name": "Application Layer Protocol: Web Protocols",
        "severity": "MEDIUM",
        "description": "URL accessed by many distinct clients suggests a shared endpoint, possibly C2 beacons.",
    },
    "T1105": {
        "name": "Ingress Tool Transfer",
        "severity": "MEDIUM",
        "description": "High access count from many clients may indicate tool deployment via web download.",
    },
    "T1090.003": {
        "name": "Proxy: Multi-hop Proxy",
        "severity": "MEDIUM",
        "description": "Host resolved through CDN/proxy infrastructure may be masking the true origin.",
    },
}


# ── CDN domain substrings ──────────────────────────────────────────────────

CDN_SUBSTRINGS: set[str] = {
    "cloudflare",
    "fastly",
    "akamai",
    "amazonaws",
    "azureedge",
    "cloudfront",
    "vercel",
    "netlify",
    "pages.dev",
    "vercel.app",
    "vercel.sh",
    "edgecompute",
    "herokuapp",
    "fly.dev",
}

_PROXY_SUBSTRINGS: set[str] = {"proxy", "torproject", "onion", "i2p"}


def _is_cdn(host: str) -> bool:
    """Return True if *host* matches known CDN provider substrings."""
    h = host.lower()
    return any(s in h for s in CDN_SUBSTRINGS)


def _is_proxy(host: str) -> bool:
    """Return True if *host* matches known proxy/relay substrings."""
    h = host.lower()
    return any(s in h for s in _PROXY_SUBSTRINGS)


# ── Periodicity score ───────────────────────────────────────────────────────

def _periodicity_score(timeline: list[dict[str, object]]) -> float:
    """Compute a periodicity score from a minute-bucket timeline.

    Returns ``1 - std/mean`` clipped to ``[0, 1]``. A perfectly regular
    signal scores 1.0; a random Poisson stream scores near 0.0.
    """
    if len(timeline) < 2:
        return 0.0
    counts = [max(int(b["count"]), 0) for b in timeline]
    mean = sum(counts) / len(counts)
    if mean <= 0:
        return 0.0
    variance = sum((c - mean) ** 2 for c in counts) / len(counts)
    std = math.sqrt(variance)
    score = 1.0 - (std / mean)
    return max(0.0, min(1.0, score))


# ── Dataclasses ─────────────────────────────────────────────────────────────

@dataclass
class Signal:
    """Aggregated signal data for a mapped entity."""

    # Host signals
    total_requests: int = 0
    risk_requests: int = 0
    enforcements: int = 0
    blacklisted_requests: int = 0
    distinct_domains: int = 0
    distinct_dest_ips: int = 0
    distinct_http_methods: set[str] = field(default_factory=set)
    total_bytes: int = 0
    risk_share: float = 0.0
    periodicity_score: float = 0.0
    cdn_domain_count: int = 0
    time_span_hours: float = 0.0
    es_online: bool = True

    # URL signals
    total_accesses: int = 0
    distinct_clients: int = 0
    last_seen: str = ""
    first_seen: str = ""
    host_is_cdn: bool = False
    host_is_proxy: bool = False


@dataclass
class AttckTechnique:
    """One mapped MITRE ATT&CK technique."""

    technique_id: str
    name: str
    severity: str  # HIGH | MEDIUM | LOW
    description: str
    evidence: dict[str, object] = field(default_factory=dict)


@dataclass
class AttckMapping:
    """Top-level mapping result."""

    entity: dict[str, str]  # {"kind": "host"|"url", "value": "..."}
    generated_at: str  # ISO-8601
    data_sources: list[str]
    es_online: bool
    signals: Signal
    techniques: list[AttckTechnique]
    summary: str


# ── Host heuristics ────────────────────────────────────────────────────────

def _heuristic_t1071_001_host(sig: Signal) -> AttckTechnique | None:
    """T1071.001 — Application Layer Protocol: Web Protocols.

    Triggers when a host makes many requests across many risk domains,
    suggesting HTTP-based C2 or reconnaissance.
    """
    if sig.total_requests < 50:
        return None
    if sig.distinct_domains < 5:
        return None
    if sig.risk_share < 0.3:
        return None
    severity = "HIGH" if sig.risk_share >= 0.6 else "MEDIUM"
    return AttckTechnique(
        technique_id="T1071.001",
        name=_HOST_HEURISTICS["T1071.001"]["name"],
        severity=severity,
        description=_HOST_HEURISTICS["T1071.001"]["description"],
        evidence={
            "total_requests": sig.total_requests,
            "distinct_domains": sig.distinct_domains,
            "risk_share": round(sig.risk_share, 4),
        },
    )


def _heuristic_t1090_003_host(sig: Signal) -> AttckTechnique | None:
    """T1090.003 — Proxy: Multi-hop Proxy.

    Triggers when CDN traffic carries risk traffic, suggesting multi-hop
    routing to mask origin.
    """
    if sig.cdn_domain_count < 1:
        return None
    if sig.risk_share < 0.2:
        return None
    return AttckTechnique(
        technique_id="T1090.003",
        name=_HOST_HEURISTICS["T1090.003"]["name"],
        severity="MEDIUM",
        description=_HOST_HEURISTICS["T1090.003"]["description"],
        evidence={
            "cdn_domain_count": sig.cdn_domain_count,
            "risk_share": round(sig.risk_share, 4),
        },
    )


def _heuristic_t1029_001_host(sig: Signal) -> AttckTechnique | None:
    """T1029.001 — Scheduled Transfer: Regular Data Staging.

    Triggers when many distinct destination IPs are contacted with few
    enforcements, suggesting automated data staging.
    """
    if sig.distinct_dest_ips < 10:
        return None
    if sig.enforcements > sig.risk_requests * 0.5:
        return None
    return AttckTechnique(
        technique_id="T1029.001",
        name=_HOST_HEURISTICS["T1029.001"]["name"],
        severity="MEDIUM",
        description=_HOST_HEURISTICS["T1029.001"]["description"],
        evidence={
            "distinct_dest_ips": sig.distinct_dest_ips,
            "risk_requests": sig.risk_requests,
            "enforcements": sig.enforcements,
        },
    )


def _heuristic_t1053_005_host(sig: Signal) -> AttckTechnique | None:
    """T1053.005 — Scheduled Task/Job: Scheduled Task.

    Triggers on highly periodic request patterns with sufficient volume.
    """
    if sig.periodicity_score < 0.7:
        return None
    if sig.total_requests < 30:
        return None
    return AttckTechnique(
        technique_id="T1053.005",
        name=_HOST_HEURISTICS["T1053.005"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1053.005"]["description"],
        evidence={
            "periodicity_score": round(sig.periodicity_score, 4),
            "total_requests": sig.total_requests,
        },
    )


def _heuristic_t1041_host(sig: Signal) -> AttckTechnique | None:
    """T1041 — Exfiltration Over C2 Channel.

    Triggers on large byte transfers to multiple risk domains.
    """
    if sig.total_bytes < 100_000_000:
        return None
    if sig.risk_share < 0.5:
        return None
    if sig.distinct_domains < 3:
        return None
    return AttckTechnique(
        technique_id="T1041",
        name=_HOST_HEURISTICS["T1041"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1041"]["description"],
        evidence={
            "total_bytes": sig.total_bytes,
            "risk_share": round(sig.risk_share, 4),
            "distinct_domains": sig.distinct_domains,
        },
    )


_HOST_HEURISTICS_LIST: list[tuple[str, object]] = [
    ("T1071.001", _heuristic_t1071_001_host),
    ("T1090.003", _heuristic_t1090_003_host),
    ("T1029.001", _heuristic_t1029_001_host),
    ("T1053.005", _heuristic_t1053_005_host),
    ("T1041", _heuristic_t1041_host),
]


# ── URL heuristics ──────────────────────────────────────────────────────────

def _heuristic_t1071_001_url(sig: Signal) -> AttckTechnique | None:
    """T1071.001 — Application Layer Protocol: Web Protocols.

    URL hit by many distinct clients suggests shared C2 beacon endpoint.
    """
    if sig.total_accesses < 20:
        return None
    if sig.distinct_clients < 3:
        return None
    return AttckTechnique(
        technique_id="T1071.001",
        name=_URL_HEURISTICS["T1071.001"]["name"],
        severity="MEDIUM",
        description=_URL_HEURISTICS["T1071.001"]["description"],
        evidence={
            "total_accesses": sig.total_accesses,
            "distinct_clients": sig.distinct_clients,
        },
    )


def _heuristic_t1105_url(sig: Signal) -> AttckTechnique | None:
    """T1105 — Ingress Tool Transfer.

    High access volume from many clients may indicate tool deployment.
    """
    if sig.total_accesses < 50:
        return None
    if sig.distinct_clients < 5:
        return None
    return AttckTechnique(
        technique_id="T1105",
        name=_URL_HEURISTICS["T1105"]["name"],
        severity="MEDIUM",
        description=_URL_HEURISTICS["T1105"]["description"],
        evidence={
            "total_accesses": sig.total_accesses,
            "distinct_clients": sig.distinct_clients,
        },
    )


def _heuristic_t1090_003_url(sig: Signal) -> AttckTechnique | None:
    """T1090.003 — Proxy: Multi-hop Proxy.

    Triggers when the URL's host is behind CDN or proxy infrastructure.
    """
    if not (sig.host_is_cdn or sig.host_is_proxy):
        return None
    return AttckTechnique(
        technique_id="T1090.003",
        name=_URL_HEURISTICS["T1090.003"]["name"],
        severity="MEDIUM",
        description=_URL_HEURISTICS["T1090.003"]["description"],
        evidence={
            "host_is_cdn": sig.host_is_cdn,
            "host_is_proxy": sig.host_is_proxy,
        },
    )


_URL_HEURISTICS_LIST: list[tuple[str, object]] = [
    ("T1071.001", _heuristic_t1071_001_url),
    ("T1105", _heuristic_t1105_url),
    ("T1090.003", _heuristic_t1090_003_url),
]


# ── Core mapping functions ──────────────────────────────────────────────────

async def map_host(ip: str, minutes: int) -> AttckMapping:
    """Map a single client IP to ATT&CK techniques.

    Queries Elasticsearch using the same block-pattern query as the
    monitoring pipeline, aggregates signals, and runs the host heuristic
    catalog against them.
    """
    generated_at = datetime.now(timezone.utc).isoformat()
    signals = Signal(es_online=True)
    techniques: list[AttckTechnique] = []
    data_sources: list[str] = []

    try:
        settings = get_settings()

        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
            whitelist_patterns = await get_whitelist_patterns(db)
            bl_cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
            bl_rows = await bl_cursor.fetchall()
        finally:
            await db.close()

        blacklist_set: set[str] = {
            r["value"] for r in bl_rows if r["kind"] in ("url", "ip")
        }
        data_sources = ["es", "blacklist"]

        whitelist_regex = _build_pattern_regex(whitelist_patterns)

        query = build_logs_query(
            block_patterns,
            minutes,
            settings.es_query_size,
            client_ip=ip,
            fields=QUERY_SOURCE_FIELDS,
        )

        async with es_client(settings, timeout=30) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception:
                signals.es_online = False
                return AttckMapping(
                    entity={"kind": "host", "value": ip},
                    generated_at=generated_at,
                    data_sources=data_sources,
                    es_online=False,
                    signals=signals,
                    techniques=[],
                    summary="Elasticsearch unavailable.",
                )

        hits = res.get("hits", {}).get("hits", [])
        if not hits:
            return AttckMapping(
                entity={"kind": "host", "value": ip},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=True,
                signals=signals,
                techniques=[],
                summary="No matching traffic found in the specified window.",
            )

        # actions=None keeps every row (ALLOW+DENY+FLAG); default is ALLOW-only which would undercount.
        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=True,
            actions=None,
        )
        if blacklist_set:
            df = df[~df["base_url"].astype(str).isin(blacklist_set)]
        if df.empty:
            return AttckMapping(
                entity={"kind": "host", "value": ip},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=True,
                signals=signals,
                techniques=[],
                summary="No matching traffic found in the specified window.",
            )
        # Aggregate signals.
        signals.total_requests = int(len(df))
        if "action" in df.columns:
            actions = df["action"].fillna("").astype(str).str.strip().str.upper()
            signals.risk_requests = int(actions.isin(["ALLOW", ""]).sum())
            signals.enforcements = int(actions.isin(["DENY", "FLAG"]).sum())
        else:
            # Legacy rows carry no action — every block-pattern hit was an ALLOW risk by construction.
            signals.risk_requests = signals.total_requests
            signals.enforcements = 0
        signals.blacklisted_requests = int(
            df["base_url"].astype(str).isin(blacklist_set).sum()
        )
        signals.distinct_domains = int(df["domain"].nunique())
        signals.distinct_dest_ips = int(df["server_ip"].nunique())
        signals.distinct_http_methods = set(
            str(m) for m in df["http_method"].dropna().unique() if str(m).strip()
        )
        signals.total_bytes = int(
            pd.to_numeric(df["bytes_downloaded"], errors="coerce").fillna(0).sum()
            + pd.to_numeric(df["bytes_uploaded"], errors="coerce").fillna(0).sum()
        )
        signals.risk_share = (
            signals.risk_requests / signals.total_requests
            if signals.total_requests > 0
            else 0.0
        )

        # CDN domain count: rows where domain matches a CDN substring.
        signals.cdn_domain_count = int(df["domain"].astype(str).apply(_is_cdn).sum())

        # Periodicity score from timeline. Cap at 7d (10080 min) — longer
        # windows produce hundreds of thousands of minute-granularity buckets,
        # which is a memory/CPU hazard. For windows beyond 7d, set 0.0.
        if minutes <= 10080:
            timeline = build_timeline(df, minutes)
            signals.periodicity_score = round(_periodicity_score(timeline), 4)
        else:
            signals.periodicity_score = 0.0


        # Time span.
        ts = pd.to_datetime(df["@timestamp"], errors="coerce", utc=True)
        if not ts.empty:
            span_s = (ts.max() - ts.min()).total_seconds()
            signals.time_span_hours = round(span_s / 3600, 2)

        # Run host heuristics.
        for tid, fn in _HOST_HEURISTICS_LIST:
            tech = fn(signals)
            if tech is not None:
                techniques.append(tech)

        summary_parts = [f"Host {ip}: {signals.total_requests} requests, "
                         f"{signals.distinct_domains} distinct domains, "
                         f"risk share {signals.risk_share:.1%}."]
        if techniques:
            summary_parts.append(f"Matched {len(techniques)} technique(s): "
                                 + ", ".join(t.technique_id for t in techniques))
        else:
            summary_parts.append("No ATT&CK techniques matched.")
        summary = " ".join(summary_parts)

    except Exception as e:
        signals.es_online = False
        summary = f"Mapping failed: {e}"

    return AttckMapping(
        entity={"kind": "host", "value": ip},
        generated_at=generated_at,
        data_sources=data_sources,
        es_online=signals.es_online,
        signals=signals,
        techniques=techniques,
        summary=summary,
    )


async def map_url(url: str, source: str = "live", limit: int = 50) -> AttckMapping:
    """Map a single URL to ATT&CK techniques.

    When ``source="live"`` queries Elasticsearch; when
    ``source="findings"`` queries the persisted findings table.
    """
    generated_at = datetime.now(timezone.utc).isoformat()
    signals = Signal(es_online=True)
    techniques: list[AttckTechnique] = []
    data_sources: list[str] = []

    try:
        settings = get_settings()
        db = await get_db()
        try:
            block_patterns = await get_block_patterns(db)
            whitelist_patterns = await get_whitelist_patterns(db)
            bl_cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
            bl_rows = await bl_cursor.fetchall()
        finally:
            await db.close()

        blacklist_set: set[str] = {
            r["value"] for r in bl_rows if r["kind"] in ("url", "ip")
        }
        data_sources = ["findings" if source == "findings" else "es", "blacklist"]

        whitelist_regex = _build_pattern_regex(whitelist_patterns)

        # Resolve the URL host for CDN/proxy detection.
        _HOST_RE = re.compile(r"^https?://([^/]+)")
        m = _HOST_RE.match(url)
        host = m.group(1) if m else ""
        signals.host_is_cdn = _is_cdn(host)
        signals.host_is_proxy = _is_proxy(host)

        df: pd.DataFrame
        if source == "live":
            # Use a search token for the URL inside ES.
            query = build_logs_query(
                block_patterns,
                1440,  # default 24h window
                settings.es_query_size,
                search=url,
                fields=QUERY_SOURCE_FIELDS,
            )

            async with es_client(settings, timeout=30) as es:
                try:
                    res = await es.search(index=settings.elastic_index, body=query)
                except Exception:
                    signals.es_online = False
                    return AttckMapping(
                        entity={"kind": "url", "value": url},
                        generated_at=generated_at,
                        data_sources=data_sources,
                        es_online=False,
                        signals=signals,
                        techniques=[],
                        summary="Elasticsearch unavailable.",
                    )

            hits = res.get("hits", {}).get("hits", [])
            if not hits:
                return AttckMapping(
                    entity={"kind": "url", "value": url},
                    generated_at=generated_at,
                    data_sources=data_sources,
                    es_online=True,
                    signals=signals,
                    techniques=[],
                    summary="No matching traffic found in the specified window.",
                )
            # actions=None keeps every row (ALLOW+DENY+FLAG); default is ALLOW-only which would undercount.
            df = apply_filters(
                pd.DataFrame([h["_source"] for h in hits]),
                whitelist_regex,
                exclude_whitelist=True,
                actions=None,
            )
            if blacklist_set:
                df = df[~df["base_url"].astype(str).isin(blacklist_set)]
        else:
            # Findings table path — same logic as ``url_breakdown``.
            # NOTE: the findings table uses ``log_timestamp`` (not last_seen/first_seen).
            db_findings = await get_db()
            try:
                cur = await db_findings.execute(
                    """
                    SELECT client_ip, MAX(log_timestamp) AS last_seen, MIN(log_timestamp) AS first_seen,
                           COUNT(*) AS cnt
                    FROM findings
                    WHERE url = ?
                    GROUP BY client_ip
                    ORDER BY cnt DESC
                    LIMIT ?
                    """,
                    (url, limit),
                )
                rows = await cur.fetchall()
            finally:
                await db_findings.close()
            if not rows:
                return AttckMapping(
                    entity={"kind": "url", "value": url},
                    generated_at=generated_at,
                    data_sources=data_sources,
                    es_online=True,
                    signals=signals,
                    techniques=[],
                    summary="No matching traffic found in the specified window.",
                )
            signals.total_accesses = sum(int(r["cnt"]) for r in rows)
            signals.distinct_clients = len(rows)
            first_row = min(rows, key=lambda r: str(r["first_seen"]))
            last_row = max(rows, key=lambda r: str(r["last_seen"]))
            signals.first_seen = str(first_row["first_seen"])
            signals.last_seen = str(last_row["last_seen"])

            # For findings source we run URL heuristics directly — periodicity/
            # time-span signals aren't available without ES.
            techniques = _run_url_heuristics(signals)
            summary = _build_url_summary(url, signals, techniques)
            return AttckMapping(
                entity={"kind": "url", "value": url},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=True,
                signals=signals,
                techniques=techniques,
                summary=summary,
            )

        if df.empty:
            return AttckMapping(
                entity={"kind": "url", "value": url},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=True,
                signals=signals,
                techniques=[],
                summary="No matching traffic found in the specified window.",
            )

        signals.total_accesses = int(len(df))
        signals.distinct_clients = int(df["client_ip"].nunique())
        ts = pd.to_datetime(df["@timestamp"], errors="coerce", utc=True)
        if not ts.empty:
            signals.last_seen = ts.max().isoformat()
            signals.first_seen = ts.min().isoformat()

        # Run URL heuristics.
        techniques = _run_url_heuristics(signals)

        summary = _build_url_summary(url, signals, techniques)

    except Exception as e:
        signals.es_online = False
        summary = f"Mapping failed: {e}"

    return AttckMapping(
        entity={"kind": "url", "value": url},
        generated_at=generated_at,
        data_sources=data_sources,
        es_online=signals.es_online,
        signals=signals,
        techniques=techniques,
        summary=summary,
    )


def _run_url_heuristics(sig: Signal) -> list[AttckTechnique]:
    """Run all URL heuristic functions and return matched techniques."""
    techniques: list[AttckTechnique] = []
    for tid, fn in _URL_HEURISTICS_LIST:
        tech = fn(sig)
        if tech is not None:
            techniques.append(tech)
    return techniques


def _build_url_summary(url: str, sig: Signal, techniques: list[AttckTechnique]) -> str:
    """Build a human-readable summary string for a URL mapping."""
    parts = [f"URL {url}: {sig.total_accesses} accesses, "
             f"{sig.distinct_clients} distinct clients."]
    if techniques:
        parts.append(f"Matched {len(techniques)} technique(s): "
                     + ", ".join(t.technique_id for t in techniques))
    else:
        parts.append("No ATT&CK techniques matched.")
    return " ".join(parts)
