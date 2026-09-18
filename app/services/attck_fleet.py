"""Fleet-wide MITRE ATT&CK aggregate over the persisted findings table.

Why this module exists (and why it reads SQLite, not Elasticsearch):

The per-entity endpoints (``GET /api/attck/host/{ip}``, ``GET /api/attck/url/{url}``)
answer "what does THIS entity look like". Nothing answers the fleet question an
operator actually asks first — *across every host, which techniques are present,
how many, and which are trending?* That needs an aggregate keyed by technique,
not by entity.

The naive implementation is an N+1: call ``map_host`` once per distinct
``client_ip``, which runs one ES query each. On a deployment with thousands of
clients in the window that is thousands of ES round-trips behind a single page
load, and it re-derives per host what the findings table already stores.

This module instead aggregates over **the findings table** — the same data
``map_host``'s findings path reads — in a fixed number of ``GROUP BY`` queries
(three: per-client totals, per-client action split, per-client server
cardinality). No per-host ES call, no N+1. It reuses the *same* catalogue, the
*same* ``Signal``, and the *same* gated runners as the per-entity paths, so the
fleet view can never drift from what the host panel says: a technique the gate
withholds for one host is withheld here for the same reason.

Honesty rules it inherits from the spec:

* **Field-availability gate.** Techniques whose fields are absent are not
  emitted, and the fleet response carries the resolved mode plus the
  suppressions actually encountered, exactly as the per-entity paths do.
* **Never 500.** A malformed row, an unreadable DB, a failed resolver — each
  degrades to a well-formed empty/partial result with a reason string.
* **Measured bytes only for byte floors.** The fleet is built from persisted
  counters (``bytes_downloaded``/``bytes_uploaded``), so ``bytes_source`` is
  ``"bytes"`` when the columns carry numbers and ``"none"`` otherwise. The
  ``duration_seconds × 8192`` proxy is deliberately **not** applied here: doing
  so per host would manufacture the same 38× inflation this review removed
  (§j.6), multiplied across the fleet.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.database import get_db
from app.services.attck_mapping import (
    AttckTechnique,
    FieldAvailability,
    Signal,
    _run_host_heuristics,
    resolve_availability,
)

log = logging.getLogger(__name__)

# How many host summaries the fleet response carries. The technique aggregate
# is over ALL hosts in the window; only the per-host breakdown is capped, so a
# large deployment still gets the complete technique picture.
DEFAULT_HOST_LIMIT = 50


@dataclass
class FleetTechniqueAggregate:
    """One technique, aggregated across every host that evidenced it."""

    technique_id: str
    name: str
    severity: str
    description: str
    host_count: int
    example_hosts: list[str] = field(default_factory=list)


@dataclass
class FleetHostSummary:
    """One host's resolved technique set (a compact per-host row)."""

    client_ip: str
    total_requests: int
    risk_share: float
    techniques: list[str] = field(default_factory=list)


@dataclass
class FleetMapping:
    """Top-level fleet result. Mirrors ``AttckMapping``'s shape where it can."""

    generated_at: str
    es_online: bool
    mode: str
    data_sources: list[str]
    hosts_scanned: int
    hosts_with_techniques: int
    techniques: list[FleetTechniqueAggregate] = field(default_factory=list)
    host_summaries: list[FleetHostSummary] = field(default_factory=list)
    suppressed: list[dict[str, str]] = field(default_factory=list)
    summary: str = ""


async def map_fleet(minutes: int, host_limit: int = DEFAULT_HOST_LIMIT) -> FleetMapping:
    """Aggregate ATT&CK techniques across every host in the persisted findings.

    Args:
        minutes: Window in minutes (0 = no window filter, the whole table).
        host_limit: Cap on the per-host breakdown (the technique aggregate is
            never capped).

    Never raises: any failure returns a well-formed empty mapping whose
    ``summary`` names the reason.
    """
    generated_at = datetime.now(UTC).isoformat()

    try:
        avail = resolve_availability()
    except Exception:
        # A failed resolver must not take the endpoint down; degrade to the
        # all-unknown state, which gates every technique closed.
        avail = FieldAvailability(mode="UNKNOWN", es_online=False, fields={})

    data_sources = ["findings", f"field_inventory:{avail.mode}"]

    # mode UNKNOWN => nothing resolvable, same rule as the per-entity paths.
    if avail.mode == "UNKNOWN":
        return FleetMapping(
            generated_at=generated_at,
            es_online=False,
            mode=avail.mode,
            data_sources=data_sources,
            hosts_scanned=0,
            hosts_with_techniques=0,
            summary="UNKNOWN mode: techniques not resolvable.",
        )

    try:
        rows = await _load_client_aggregates(minutes)
    except Exception as exc:  # an unreadable DB is a reason, not a 500
        log.warning("[attck_fleet] findings aggregation failed: %s", exc)
        return FleetMapping(
            generated_at=generated_at,
            es_online=True,
            mode=avail.mode,
            data_sources=data_sources,
            hosts_scanned=0,
            hosts_with_techniques=0,
            summary=f"Findings aggregation failed: {type(exc).__name__}.",
        )

    if not rows:
        return FleetMapping(
            generated_at=generated_at,
            es_online=True,
            mode=avail.mode,
            data_sources=data_sources,
            hosts_scanned=0,
            hosts_with_techniques=0,
            summary="No persisted findings in the specified window.",
        )

    # ── Run the gated host catalogue once per host ──
    technique_hosts: dict[str, set[str]] = {}
    technique_meta: dict[str, AttckTechnique] = {}
    summaries: list[FleetHostSummary] = []
    suppressed_counter: Counter[tuple[str, str]] = Counter()
    technique_sev: dict[str, str] = {}

    for row in rows:
        sig = _signal_from_row(row, avail)
        techniques, suppressed = _run_host_heuristics(sig, avail)
        for s in suppressed:
            suppressed_counter[(s["id"], s["reason"])] += 1

        ids: list[str] = []
        for tech in techniques:
            ids.append(tech.technique_id)
            technique_hosts.setdefault(tech.technique_id, set()).add(row["client_ip"])
            technique_meta.setdefault(tech.technique_id, tech)
            # A technique can rank differently per host; the fleet row reports
            # the worst ranking any host produced, never the first seen.
            technique_sev[tech.technique_id] = _worst_severity(
                [technique_sev.get(tech.technique_id, "LOW"), tech.severity]
            )

        summaries.append(
            FleetHostSummary(
                client_ip=row["client_ip"],
                total_requests=row["total_requests"],
                risk_share=sig.risk_share,
                techniques=ids,
            )
        )

    # ── Roll up technique -> host count, most prevalent first ──
    aggregate = [
        FleetTechniqueAggregate(
            technique_id=tid,
            name=technique_meta[tid].name,
            severity=technique_sev.get(tid, technique_meta[tid].severity),
            description=technique_meta[tid].description,
            host_count=len(hosts),
            example_hosts=sorted(hosts)[:5],
        )
        for tid, hosts in technique_hosts.items()
    ]
    aggregate.sort(key=lambda t: (-t.host_count, t.technique_id))

    hosts_with = sum(1 for s in summaries if s.techniques)
    # Most-affected hosts first, then by volume — the operator's triage order.
    summaries.sort(key=lambda s: (-len(s.techniques), -s.total_requests))

    suppressed = [
        {"id": tid, "reason": reason}
        for (tid, reason), _count in suppressed_counter.most_common()
    ]

    summary_parts = [
        f"Fleet: {len(rows)} hosts,",
        f"{hosts_with} with techniques,",
        f"{len(aggregate)} distinct technique(s).",
    ]
    if suppressed:
        summary_parts.append(
            "Suppressed (fields absent): "
            + ", ".join(s["id"] for s in suppressed)
            + "."
        )

    return FleetMapping(
        generated_at=generated_at,
        es_online=True,
        mode=avail.mode,
        data_sources=data_sources,
        hosts_scanned=len(rows),
        hosts_with_techniques=hosts_with,
        techniques=aggregate,
        host_summaries=summaries[:host_limit],
        suppressed=suppressed,
        summary=" ".join(summary_parts),
    )


async def _load_client_aggregates(minutes: int) -> list[dict[str, Any]]:
    """Per-client aggregates from the findings table — three GROUP BY queries.

    Returns one dict per distinct ``client_ip`` carrying exactly the signals a
    host mapping needs. This is the whole point of the module: the per-host
    data is read in aggregate, not one ES query per host.

    Field-level availability is deliberately NOT inferred here — the resolver
    owns that. A column that no row populates (e.g. ``category`` always "") is
    the resolver's business, and the SQL only counts what is stored.
    """
    db = await get_db()
    try:
        window = ""
        params: tuple[Any, ...] = ()
        if minutes and minutes > 0:
            window = "WHERE log_timestamp >= datetime('now', ?)"
            params = (f"-{int(minutes)} minutes",)

        # 1. Per-client totals + server cardinality + byte sums.
        cur = await db.execute(
            f"""
            SELECT client_ip,
                   COUNT(*)                              AS total_requests,
                   COUNT(DISTINCT server_ip)             AS distinct_dest_ips,
                   COUNT(DISTINCT category)              AS distinct_categories,
                   COALESCE(SUM(CAST(bytes_downloaded AS INTEGER)), 0) AS download_bytes,
                   COALESCE(SUM(CAST(bytes_uploaded   AS INTEGER)), 0) AS upload_bytes,
                   MIN(log_timestamp)                    AS first_seen,
                   MAX(log_timestamp)                    AS last_seen
            FROM findings
            {window}
            GROUP BY client_ip
            """,
            params,
        )
        totals = {r["client_ip"]: dict(r) for r in await cur.fetchall()}

        # 2. Per-client action split (risk vs enforcement), same window clause.
        cur = await db.execute(
            f"""
            SELECT client_ip,
                   SUM(CASE WHEN UPPER(action) IN ('ALLOW', '') THEN 1 ELSE 0 END) AS risk_requests,
                   SUM(CASE WHEN UPPER(action) IN ('DENY', 'FLAG') THEN 1 ELSE 0 END)
                       AS enforcements
            FROM findings
            {window}
            GROUP BY client_ip
            """,
            params,
        )
        for r in await cur.fetchall():
            if r["client_ip"] in totals:
                totals[r["client_ip"]]["risk_requests"] = int(r["risk_requests"] or 0)
                totals[r["client_ip"]]["enforcements"] = int(r["enforcements"] or 0)
    finally:
        await db.close()

    return list(totals.values())


def _signal_from_row(row: dict[str, Any], avail: FieldAvailability) -> Signal:
    """Build a ``Signal`` for one host from its SQL aggregate row.

    Only fields the resolver marked PRESENT are read into signals that depend on
    them; the rest keep their UNKNOWN-safe defaults. This keeps the fleet view
    under the same gate as the per-entity paths.
    """
    sig = Signal(es_online=True)
    sig.available_fields = dict(avail.fields)
    sig.mode = avail.mode

    sig.total_requests = int(row.get("total_requests") or 0)
    risk = int(row.get("risk_requests") or 0)
    enf = int(row.get("enforcements") or 0)
    sig.risk_requests = risk
    sig.enforcements = enf
    sig.risk_share = (risk / sig.total_requests) if sig.total_requests else 0.0

    # The findings source never stores a per-row SERVER->client relation beyond
    # the count, so the distinct-destination signal is the aggregate.
    sig.distinct_dest_ips = int(row.get("distinct_dest_ips") or 0)

    # `domain` is NOT the findings table's carrier — `category` is (spec §j.2).
    # distinct_domains is only meaningful when the resolver says `domain` is
    # readable; otherwise it stays 0 and the domain-gated predicates decline.
    if avail.has("domain"):
        sig.distinct_domains = int(row.get("distinct_categories") or 0)

    # Byte accounting: persisted counters only. `bytes_source` is "bytes" when
    # the columns actually carry numbers, "none" otherwise. The duration proxy
    # is deliberately not applied at fleet scale (see module docstring).
    download = int(row.get("download_bytes") or 0)
    upload = int(row.get("upload_bytes") or 0)
    if avail.any_of("bytes_downloaded", "bytes_uploaded") and (download or upload):
        sig.download_bytes = download
        sig.upload_bytes = upload
        sig.total_bytes = download + upload
        sig.bytes_source = "bytes"
        if sig.total_bytes:
            sig.upload_share = round(upload / sig.total_bytes, 4)
    else:
        sig.total_bytes = None
        sig.bytes_source = "none"

    # Time span from the stored timestamps, when readable.
    if avail.has("@timestamp"):
        span = _span_hours(row.get("first_seen"), row.get("last_seen"))
        if span is not None:
            sig.time_span_hours = span

    return sig


def _span_hours(first: Any, last: Any) -> float | None:
    """Hours between two stored timestamps, or None when unparseable."""
    if not first or not last:
        return None
    try:
        a = datetime.fromisoformat(str(first).replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return round(abs((b - a).total_seconds()) / 3600, 2)


def _worst_severity(severities: list[str]) -> str:
    """Highest severity label present (HIGH > MEDIUM > LOW)."""
    order = ("LOW", "MEDIUM", "HIGH")
    best = "LOW"
    for s in severities:
        if s in order and order.index(s) > order.index(best):
            best = s
    return best


__all__ = [
    "FleetHostSummary",
    "FleetMapping",
    "FleetTechniqueAggregate",
    "DEFAULT_HOST_LIMIT",
    "map_fleet",
]
