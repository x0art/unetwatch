"""MITRE ATT&CK mapping service.

Maps client-IP hosts and URLs to ATT&CK techniques by running the same
block-pattern ES query that drives the rest of the app, then applying a
fixed set of heuristics over the resulting dataframes.

Field-driven, not assumption-driven
-----------------------------------
``QUERY_SOURCE_FIELDS`` is only the *projection list* handed to Elasticsearch:
ES silently omits fields a document does not carry, and ``apply_filters`` then
default-fills the missing names with ``""`` (see result_processor.py:88-110).
A naive heuristic therefore reads a fabricated empty column and cannot tell
"no domains" from "this deployment has no ``domain`` field at all".

``resolve_availability()`` fixes that: it resolves every field the heuristics
may read to ``PRESENT`` / ``ABSENT`` / ``UNKNOWN`` *before* any predicate runs,
keyed on the same UC-A / UC-B / COLLAPSED / UNKNOWN mode that ``es_fields``
already resolves. Each technique declares the fields it requires; a technique
with an unmet requirement is *suppressed* with a reason, never guessed. See
``docs/attck-mapping-spec.md`` (this module implements §b/§c3/§d/§e of it).

Degradation is honest by construction:
* ``mode == UNKNOWN``            -> zero techniques, explicit reason string.
* ``mode == COLLAPSED``          -> non-baseline fields are ABSENT (the mode
                                    guarantees the inventory is exactly the six
                                    baseline fields), so byte/domain-gated
                                    techniques are withheld rather than guessed.
* an optional field missing      -> one confidence step down, recorded in the
                                    technique's ``evidence``.

Designed as a thin bridge between the monitoring stack and the ATT&CK
visualisation — it never 500s; every exception falls through to an
``es_online=False`` sentinel payload. The response shape is frozen: the
frontend (admin-ui/src/api.ts:2104-2143, AttckPanel.tsx) depends on
``AttckTechnique = technique_id/name/severity/description/evidence`` and
``AttckMapping``'s existing keys. Suppression reasons ride in
``signals.suppressed`` (structured) and ``summary`` (prose) — deliberately
NOT in ``techniques[].evidence``: a suppressed technique is one that produced
no ``techniques[]`` entry at all, so there is no evidence object to carry it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from app.config import get_settings
from app.database import get_db
from app.services import es_fields
from app.services.es_client import es_client
from app.services.monitor import (
    build_logs_query,
    get_block_patterns,
    get_whitelist_patterns,
    _build_pattern_regex,
)
from app.services.query_builder import QUERY_SOURCE_FIELDS
from app.services.result_processor import apply_filters, build_timeline


# ── Field availability (the gate everything else hangs on) ──────────────────

PRESENT = "present"
ABSENT = "absent"
UNKNOWN = "unknown"

# The six fields _resolve_mode() requires for ANY non-UNKNOWN mode.
# Duplicated here rather than imported: es_fields exposes no baseline constant,
# and a drift guard in the tests asserts the two stay equal.
BASELINE_FIELDS: tuple[str, ...] = (
    "@timestamp",
    "url",
    "client_ip",
    "server_ip",
    "duration_seconds",
    "action",
)

# Everything the ATT&CK engine is willing to read, with the resolver that
# decides presence. Field order is the resolution order; keys are the names
# used by availability["fields"] and by each technique's required set.
#
# Resolver meanings:
#   "mode"      -- present iff mode in (UC-A, UC-B). Used for user_agent-like
#                  lens fields: es_fields._resolve_mode() only awards UC-A/UC-B
#                  after it has confirmed these, so modal presence implies them.
#   "baseline"  -- the six required fields; PRESENT iff mode is known.
#   "inventory" -- present iff the cached inventory observed the name; in
#                  COLLAPSED the inventory IS the baseline set, so a
#                  non-baseline name resolves ABSENT (not merely UNKNOWN).
_FIELD_RESOLVERS: dict[str, str] = {
    # ── baseline six ──
    "@timestamp": "baseline",
    "url": "baseline",
    "client_ip": "baseline",
    "server_ip": "baseline",
    "duration_seconds": "baseline",
    "action": "baseline",
    # ── QUERY_SOURCE_FIELDS, non-baseline ──
    "domain": "inventory",
    "category": "inventory",
    "http_method": "inventory",
    "http_status_code": "inventory",
    "country_code": "inventory",
    "bytes_downloaded": "inventory",
    "bytes_uploaded": "inventory",
    "rule_info": "inventory",
    "rule_name": "inventory",
    "user_id": "inventory",
    "matched_patterns": "inventory",
    "user_agent": "mode",
    # ── extended fields the app already knows how to read ──
    # (docs/field-sample-report.md §4, plus the alternates that pipeline
    # renames produce). These close the gap where QUERY_SOURCE_FIELDS has no
    # usable byte/category field.
    "username": "inventory",
    "session": "inventory",
    "content_type": "inventory",
    "request_size": "inventory",
    "response_size": "inventory",
    "referer": "inventory",
    "method": "inventory",
    "response_status": "inventory",
    "bytes": "inventory",
    "response_bytes": "inventory",
    "rule": "inventory",
}

# Fields the per-document data can legitimately be blank on even when the field
# is present in the inventory (it is populated for some docs, not all). A
# technique whose *required* field is one of these is not gated on it — the
# engine downgrades instead. See attck-mapping-spec.md §d ("handover-bound").
_DOWNGRADE_ONLY_FIELDS: frozenset[str] = frozenset(
    {"category", "country_code", "user_agent", "username", "session", "referer"}
)

# Lens fields whose *availability* is what the UC-A/UC-B mode itself proves, so
# their absence from the availability map is "not sampled" rather than "missing
# evidence". Charging a confidence step for them would double-count the mode
# transition and drop a UC-A result below its own UC-B baseline.
_MODE_PROVEN_FIELDS: frozenset[str] = frozenset({"user_agent"})


@dataclass(frozen=True)
class FieldAvailability:
    """Resolved presence of every field the ATT&CK engine may read."""

    mode: str
    es_online: bool
    fields: dict[str, str]  # name -> PRESENT | ABSENT | UNKNOWN

    def has(self, name: str) -> bool:
        """PRESENT is the only state a required field may be in to emit."""
        return self.fields.get(name) == PRESENT

    def any_of(self, *names: str) -> bool:
        """True when at least one alternative field is PRESENT."""
        return any(self.has(n) for n in names)

    def first_present(self, *names: str) -> str | None:
        """Return the first PRESENT name in *names* (pipeline-rename tolerance)."""
        for n in names:
            if self.has(n):
                return n
        return None

    def missing(self, required: tuple[str, ...]) -> list[str]:
        """Required names that are not PRESENT (for the suppression reason)."""
        return [n for n in required if not self.has(n)]


def _empty_availability(mode: str = "UNKNOWN", es_online: bool = False) -> FieldAvailability:
    """All-UNKNOWN availability — the state when nothing has been sampled."""
    return FieldAvailability(
        mode=mode,
        es_online=es_online,
        fields={name: UNKNOWN for name in _FIELD_RESOLVERS},
    )


def resolve_availability(
    *,
    mode: str | None = None,
    inventory_names: set[str] | None = None,
    es_online: bool = True,
) -> FieldAvailability:
    """Resolve every field to PRESENT/ABSENT/UNKNOWN from the ES mode + inventory.

    Presence is driven by the **actual inventory** (the sampled document's keys
    ∪ ``field_caps``), in every mode. The mode's only role is to mark a small
    closed set of names — the ones ``es_fields._resolve_mode`` explicitly
    tested and rejected — as proven-ABSENT when it returns COLLAPSED.

    Args:
        mode: Resolved mode. Read from the es_fields cache when omitted.
        inventory_names: Observed field names (sample keys ∪ field_caps). Read
            from the cache when omitted.
        es_online: Whether ES is reachable; only surfaces in reasons.

    Never raises: an unreadable cache degrades to all-UNKNOWN, which gates
    every technique closed (the safe direction).
    """
    try:
        if mode is None:
            mode = es_fields.get_mode()
        if inventory_names is None:
            inventory_names = es_fields.inventory_field_names()
    except Exception:
        return _empty_availability("UNKNOWN", es_online=False)

    mode = mode or "UNKNOWN"

    # Mode UNKNOWN (ES unreachable, or baseline fields missing): we cannot tell
    # what any document carries, so every field is UNKNOWN — which the gate
    # treats as insufficient, yielding zero techniques with a clear reason.
    if not es_online or mode == "UNKNOWN":
        avail = _empty_availability(mode, es_online)
        return avail

    inventory_names = inventory_names or set()

    # ── Which fields does the MODE itself say something about? ──
    #
    # `es_fields._resolve_mode()` does not merely *label* a deployment; it
    # runs an explicit presence test for a small, closed set of names and
    # returns COLLAPSED only after every one of them failed BOTH
    # `issubset(sample.keys())` AND `all(f in caps)`. That failure is real
    # evidence of ABSENCE for exactly those names — and for nothing else.
    #
    # The historical bug was treating that narrow proof as a blanket rule
    # ("COLLAPSED => inventory == baseline six, so every non-baseline field is
    # ABSENT"). Real Elasticsearch disproves it: the inventory is the union of
    # the sampled document's keys and `field_caps`, and real logstash-proxy
    # documents carry `category`, `bytes_downloaded`, `bytes_uploaded`,
    # `rule_name`, `http_status_code`, `country_code` and `user_id` — none of
    # which `_resolve_mode` ever inspects. Declaring them ABSENT hid fields the
    # engine can genuinely read (spec §j.8).
    #
    # The correct split:
    #   * a name the mode explicitly tested and rejected -> ABSENT (proven);
    #   * otherwise presence comes from the inventory, whatever the mode:
    #       - seen in `field_caps` -> PRESENT (index-wide, authoritative);
    #       - absent from `field_caps` but present in the sampled document
    #         -> PRESENT (a `_source` key that a real document carries is
    #         readable, which is all the heuristics need);
    #       - seen in neither -> UNKNOWN ("not sampled"), NEVER ABSENT.
    #
    # UNKNOWN is the honest state for "our sample did not mention it": the
    # inventory is one document plus an index mapping, not a per-document
    # census, so silence is not proof of absence.
    mode_rejected: frozenset[str] = (
        frozenset({"user_agent", "username", "session"})
        if mode == "COLLAPSED"
        else frozenset()
    )

    resolved: dict[str, str] = {}
    for name, resolver in _FIELD_RESOLVERS.items():
        if resolver == "baseline":
            resolved[name] = PRESENT
        else:
            # "inventory" and "mode" now resolve identically: a field is
            # present iff the inventory observed it. The "mode" resolver's
            # original meaning ("present iff a UC-mode exists") is subsumed —
            # UC-A/UC-B are only ever awarded *because* the inventory showed
            # their lens fields, so the inventory is the single source of
            # truth either way.
            if name in inventory_names:
                resolved[name] = PRESENT
            elif name in mode_rejected:
                resolved[name] = ABSENT
            else:
                resolved[name] = UNKNOWN
    return FieldAvailability(mode=mode, es_online=es_online, fields=resolved)


# ── Heuristic catalog (technique_id → metadata + field requirements) ────────
#
# Each entry carries the fields the technique's predicate MAY read. ``required``
# names are hard gates: any one of them not PRESENT suppresses the technique
# (recorded with a reason). ``optional`` names only downgrade confidence by one
# step each when absent — they are evidence legs, not precondition.
#
# ``required_any`` expresses an OR-leg requirement ("needs a byte counter of
# some kind"); at least one name in the group must be PRESENT.
#
# Keep these honest: a predicate that reads a field must either list it in
# ``required``/``required_any`` or in ``optional``, and it must never touch a
# field not listed at all.

_HOST_HEURISTICS: dict[str, dict[str, object]] = {
    "T1071.001": {
        "name": "Application Layer Protocol: Web Protocols",
        "severity": "auto",  # HIGH / MEDIUM based on thresholds
        "description": (
            "Excessive requests to diverse domains suggest HTTP(S) traffic used as a "
            "command-and-control channel."
        ),
        "required": ("@timestamp",),
        "optional": ("action", "domain", "user_agent", "username", "session"),
    },
    "T1090.003": {
        "name": "Proxy: Multi-hop Proxy",
        "severity": "MEDIUM",
        "description": (
            "Traffic routed through CDN/proxy infrastructure may indicate network "
            "isolation or evasion."
        ),
        "required": ("url",),
        "optional": ("domain", "action"),
    },
    "T1029.001": {
        "name": "Scheduled Transfer: Regular Data Staging",
        "severity": "MEDIUM",
        "description": (
            "High destination diversity with few enforcements suggests scheduled data "
            "exfiltration."
        ),
        "required": ("server_ip",),  # the distinct_dest_ips leg is the base signal
        # A *measured* byte counter is genuinely required: the duration proxy
        # must never be the sole basis for this technique's volume leg (see
        # `_heuristic_t1029_001_host` and spec §j.9.2).
        "required_any": ("bytes_uploaded", "bytes_downloaded"),
        "optional": ("action", "domain"),
    },
    "T1053.005": {
        "name": "Scheduled Task/Job: Scheduled Task",
        "severity": "LOW",
        "description": (
            "Highly periodic request patterns may indicate automated tooling or scheduled "
            "payloads."
        ),
        "required": ("@timestamp",),
        "optional": ("url", "action"),
    },
    "T1041": {
        "name": "Exfiltration Over C2 Channel",
        "severity": "LOW",
        "description": (
            "Large byte transfers to multiple risk domains may indicate data staged over "
            "C2."
        ),
        # Same rule as T1029.001: `duration_seconds` is deliberately NOT a
        # byte leg here. Its presence in `required_any` is what let a
        # duration-only stream open the gate and then compare an *invented*
        # total against the real floor (spec §j.6/§j.9.2).
        "required_any": ("bytes_uploaded", "bytes_downloaded"),
    },
    "T1078": {
        "name": "Valid Accounts",
        "severity": "MEDIUM",
        "description": (
            "A sustained, low-variance session with no enforcements is indistinguishable from "
            "credential abuse over a web service."
        ),
        "required": ("client_ip", "action"),
        "optional": ("duration_seconds", "domain", "user_id"),
    },
    "T1583.003": {
        "name": "Acquire Infrastructure: Virtual Private Server",
        "severity": "LOW",
        "description": (
            "Repeat contact with a small set of non-CDN destinations registered across exotic "
            "network blocks suggests operator-owned infrastructure."
        ),
        "required": ("server_ip",),
        "optional": ("action", "domain", "country_code"),
    },
    "T1567": {
        "name": "Exfiltration Over Web Service",
        "severity": "MEDIUM",
        "description": (
            "Upload-shaped traffic (POST/PUT volume, upload-heavy byte split) to a web service "
            "suggests data transfer, not retrieval."
        ),
        "required_any": ("bytes_uploaded", "bytes_downloaded"),
        "optional": ("http_method", "domain", "category"),
    },
    "T1114.002": {
        "name": "Email Collection: Remote Email Collection",
        "severity": "LOW",
        "description": (
            "A read-oriented endpoint (folder/INBOX/message shapes) carrying an upload-heavy or "
            "long-lived pattern is a remote-collection candidate."
        ),
        "required": ("url",),
        "required_any": ("bytes_uploaded", "bytes_downloaded"),
        "optional": ("user_id", "http_method", "action"),
    },
    "T1204.002": {
        "name": "User Execution: Malicious File",
        "severity": "MEDIUM",
        "description": (
            "A burst of rejected content-navigation requests to a mixed destination set is a "
            "malware-delivery attempt, not settled traffic."
        ),
        "required": ("action", "url"),
        "optional": ("http_status_code", "category", "domain", "bytes_downloaded"),
    },
    "T1583.001": {
        "name": "Acquire Infrastructure: Domains",
        "severity": "LOW",
        "description": (
            "Many distinct /16 destinations contacted briefly and rarely in common suggests a "
            "freshly-acquired, disposable domain set."
        ),
        "required": ("server_ip",),
        "optional": ("domain", "action", "country_code"),
    },
    "T1567.002": {
        "name": "Exfiltration to Cloud Storage",
        "severity": "LOW",
        "description": (
            "A cloud-storage class (rule_name/category) carrying an upload-heavy transfer is "
            "collection moved to third-party storage."
        ),
        "required_any": ("rule_name", "category"),
        "optional": ("bytes_uploaded", "bytes_downloaded", "http_method"),
    },
}

_URL_HEURISTICS: dict[str, dict[str, object]] = {
    "T1071.001": {
        "name": "Application Layer Protocol: Web Protocols",
        "severity": "MEDIUM",
        "description": (
            "URL accessed by many distinct clients suggests a shared endpoint, possibly C2 "
            "beacons."
        ),
        "required": ("url", "client_ip"),
        "optional": ("@timestamp", "content_type", "category"),
    },
    "T1105": {
        "name": "Ingress Tool Transfer",
        "severity": "MEDIUM",
        "description": (
            "High access count from many clients may indicate tool deployment via web "
            "download."
        ),
        "required": ("url",),
        "required_any": ("bytes_downloaded", "response_size", "request_size"),
        "optional": ("content_type", "category", "@timestamp"),
    },
    "T1090.003": {
        "name": "Proxy: Multi-hop Proxy",
        "severity": "MEDIUM",
        "description": (
            "Host resolved through CDN/proxy infrastructure may be masking the true "
            "origin."
        ),
        "required": ("url",),
        "optional": (),
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


# ── Periodicity: two statistics, neither of which is 1 - std/mean ───────────
#
# Why not ``1 - std/mean`` on minute buckets (the historical formula):
#   1. It is monotone in *sample density*, not in periodicity. In the Poisson
#      limit std/mean = 1/sqrt(lam), so a host with more traffic scores higher
#      on an unchanged cadence.
#   2. It is unsound on sparse buckets. build_timeline() scales bucket width to
#      the window (30 min at 24h, 5 min at 4h), so a genuine 1-minute
#      heartbeat lands a constant count in every bucket: it scores zero and
#      T1053.005 can never fire.
#
# The two replacements split the job by *what each can actually see*:
#   * ``_interval_cv`` reads the raw ``@timestamp`` column (full resolution) and
#     is the load-bearing detector for a fast beat — 1 min, 5 min, 1 h.
#   * ``_slot_concentration`` reads the pre-bucketed timeline and can only see a
#     coarse lockstep that survives build_timeline's bucket width; it is a
#     corroborator, and its docstring states the aliasing limit.


def _interval_cv(ts: pd.Series) -> float | None:
    """Coefficient of variation of inter-arrival intervals, or None if unstable.

    Measures the *arrivals themselves* (every gap between consecutive
    ``@timestamp`` values), not gaps between merged bursts. That distinction
    is the whole statistic:

    * a machine beat — 1 min, 5 min, 1 h, with or without jitter — has a small
      CV (measured: 0.00 exact, 0.07 at 5 % jitter, 0.28 at 20 % jitter);
    * organic load is Poisson, whose inter-arrival gaps are exponential and
      score ``CV ≈ 1.0`` (measured: 0.97).

    An earlier version merged arrivals within 1 h into "bursts" before
    measuring. That was exactly backwards: on a dense stream (a 1-minute
    heartbeat produces 60 arrivals/hour) the merge collapsed the beat to one
    arrival per hour, and Poisson noise to the same, so the two became
    indistinguishable — and slightly *inverted* (a jittered beat scored 0.005,
    noise 0.014). The merge is deleted; the threshold below does the work.

    ``None`` means "cannot tell" (fewer than ``_INTERVAL_MIN_SAMPLES`` gaps),
    which the caller must surface as UNKNOWN — never as 0.0, which would read
    as "acyclic".
    """
    stamps = pd.to_datetime(ts, errors="coerce", utc=True).dropna().sort_values()
    if len(stamps) < 2:
        return None
    secs = stamps.astype("int64") // 1_000_000_000
    intervals = [int(b) - int(a) for a, b in zip(secs, secs.iloc[1:]) if b > a]
    if len(intervals) < _INTERVAL_MIN_SAMPLES:
        return None
    mean = sum(intervals) / len(intervals)
    if mean <= 0:
        return None
    variance = sum((i - mean) ** 2 for i in intervals) / len(intervals)
    return math.sqrt(variance) / mean


def _slot_concentration(timeline: list[dict[str, object]]) -> float | None:
    """Best fixed-slot coverage of a pre-bucketed timeline, in [0, 1], or None.

    Splits the timeline's span into 5-minute slots (zero-filled — the sums are
    additive, so an absent bucket is just a zero), takes each slot modulo one
    shift-hour (12 slots), and returns the busiest phase's share of all
    requests. A lockstep scheduler that lands on a phase boundary concentrates
    (→ 0.5 for a 30-minute cadence, 1.0 for 1-hour); a spread load divides
    across the phases.

    **This statistic cannot detect a cadence finer than its slot grid, and the
    caller must not pretend otherwise.** The grid is fixed at 5 minutes while
    ``build_timeline`` buckets the data at ``minutes // 48`` (5 min at a 4 h
    window — matching; but 30 min at 24 h, 210 min at 7 d — far coarser). Once
    the data has been bucketed wider than 5 minutes, the cadence is already
    gone: a 1-minute heartbeat and a 30-minute lockstep both present as
    "every 1800-second bucket has the same count", and this function returns
    the same value for both. Measured on the 24 h path: 1-minute heartbeat,
    30-minute lockstep and uniform Poisson load *all* score 0.5; only the
    1-hour cadence separates (1.0).

    So this is a coarse, best-effort corroborator. The load-bearing detector
    for fast cadences is ``_interval_cv`` on the raw arrivals — see
    ``_heuristic_t1053_005_host``, which fires on EITHER a tight interval CV
    (the reliable signal) or a strong slot concentration.

    ``None`` means the span holds fewer than ``_SLOT_MIN_COUNT`` slots: an
    unstable statistic the caller must treat as UNKNOWN rather than as a
    negative result.
    """
    if len(timeline) < _SLOT_MIN_COUNT:
        return None
    total = sum(max(int(b.get("count", 0)), 0) for b in timeline)
    if total <= 0:
        return None
    try:
        starts = sorted(str(b.get("bucket")) for b in timeline)
        span = (
            pd.to_datetime(starts[-1], utc=True)
            - pd.to_datetime(starts[0], utc=True)
        )
    except Exception:
        return None
    if span.total_seconds() / _SLOT_SECONDS < _SLOT_MIN_COUNT:
        return None
    phase_totals = [0] * _SLOT_PHASES
    for b in timeline:
        try:
            ts = pd.to_datetime(b.get("bucket"), utc=True)
        except Exception:
            return None
        phase = int(ts.timestamp()) // _SLOT_SECONDS % _SLOT_PHASES
        phase_totals[phase] += max(int(b.get("count", 0)), 0)
    return max(phase_totals) / total


_INTERVAL_MIN_SAMPLES = 10
_SLOT_SECONDS = 300  # 5-minute slot grid
_SLOT_PHASES = 12  # slots per shift-hour (3600 / 300)
_SLOT_MIN_COUNT = 2


# ── Dataclasses ─────────────────────────────────────────────────────────────

@dataclass
class Signal:
    """Aggregated signal data for a mapped entity.

    ``None`` on a numeric signal means UNKNOWN (the field was not present),
    which is deliberately distinct from a real ``0``. The gate in
    ``_evaluate`` treats UNKNOWN as "not available"; predicates that read a
    ``None`` must therefore be paired with a PRESENT check on its source field.
    """

    # ── Field availability (always populated; drives every gate) ──
    available_fields: dict[str, str] = field(default_factory=dict)
    mode: str = "UNKNOWN"

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

    # ── Byte-accounting provenance ──
    # Which fields the byte totals actually came from, so evidence can name the
    # source instead of implying a measurement that never happened. One of:
    # "bytes" (real counters), "duration-proxy" (duration*8192 fallback),
    # "none" (nothing present -> total_bytes is UNKNOWN, not 0).
    bytes_source: str = "none"
    upload_bytes: int | None = None
    download_bytes: int | None = None
    upload_share: float | None = None

    # ── Periodicity (the two sound statistics) ──
    interval_cv: float | None = None
    slot_concentration: float | None = None

    # ── URL signals ──
    total_accesses: int = 0
    distinct_clients: int = 0
    last_seen: str = ""
    first_seen: str = ""
    host_is_cdn: bool = False
    host_is_proxy: bool = False

    # ── Suppressions ──
    # Techniques the gate WITHHELD, as ``[{"id", "reason"}, …]``. A suppressed
    # technique emits no ``techniques[]`` entry at all, so this is the only
    # field a reader can consult for the reasons; ``summary`` carries the same
    # text in prose. Additive to the frozen wire contract: ``AttckSignal``
    # declares no index signature, but extra keys on a TS interface are
    # ignored, so the panel compiles and renders unchanged.
    suppressed: list[dict[str, str]] = field(default_factory=list)


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


# ── Confidence gating ──────────────────────────────────────────────────────

_SEVERITY_ORDER = ("LOW", "MEDIUM", "HIGH")


def _downgrade(severity: str, steps: int = 1) -> str:
    """Drop *severity* by *steps* levels, clamped at LOW."""
    try:
        idx = _SEVERITY_ORDER.index(severity)
    except ValueError:
        return "LOW"
    return _SEVERITY_ORDER[max(0, idx - steps)]


def _optional_missing(
    avail: FieldAvailability, optional: tuple[str, ...]
) -> list[str]:
    """Optional fields that are not PRESENT — each costs one confidence step.

    Two exclusions, for different reasons:
    * ``_DOWNGRADE_ONLY_FIELDS`` are populated per document, so their absence
      on one doc is a *weakness*, not a distinct evidence leg. Counting them
      would double-charge the same observation.
    * ``_MODE_PROVEN_FIELDS`` are proven present by the mode itself; their
      absence from the map means "not sampled", and charging for them would
      make a UC-A result score below its own UC-B baseline.
    """
    return [
        name
        for name in optional
        if name not in _DOWNGRADE_ONLY_FIELDS
        and name not in _MODE_PROVEN_FIELDS
        and not avail.has(name)
    ]


def _evidence_extra(avail: FieldAvailability, sig: Signal) -> dict[str, object]:
    """Provenance block stamped into every technique's evidence.

    Satisfies spec §e.4: a reader must be able to re-derive the verdict —
    which mode resolved, each field's resolved state, and where the byte
    numbers came from — without reading this module.
    """
    return {
        "es_mode": avail.mode,
        "bytes_source": sig.bytes_source,
        "field_availability": dict(avail.fields),
    }


def _gate(
    avail: FieldAvailability,
    tid: str,
    catalogue: dict[str, dict[str, object]],
) -> str | None:
    """Return a suppression reason, or None when the technique may run.

    Hard gates only: ``required`` must all be PRESENT and at least one name in
    ``required_any`` (when declared) must be. Optional fields never block.
    """
    meta = catalogue[tid]
    required: tuple[str, ...] = tuple(meta.get("required", ()))  # type: ignore[arg-type]
    required_any: tuple[str, ...] = tuple(  # type: ignore[arg-type]
        meta.get("required_any", ())
    )
    missing = avail.missing(required)
    if missing:
        present = sorted(n for n, s in avail.fields.items() if s == PRESENT)
        return (
            f"requires {', '.join(required)}; missing {', '.join(missing)} "
            f"(present: {', '.join(present) or 'none'})"
        )
    if required_any and not avail.any_of(*required_any):
        present = sorted(n for n, s in avail.fields.items() if s == PRESENT)
        return (
            f"requires any of {', '.join(required_any)}; "
            f"none present (present: {', '.join(present) or 'none'})"
        )
    return None


def _evaluate(
    avail: FieldAvailability,
    tid: str,
    catalogue: dict[str, dict[str, object]],
    heuristic: object,
    sig: Signal,
) -> tuple[AttckTechnique | None, dict[str, str]]:
    """Gate, run, and confidence-adjust one technique.

    Returns ``(technique_or_None, suppression)`` where ``suppression`` is an
    empty dict on success and ``{"id", "reason"}`` otherwise. Never raises —
    a broken heuristic is a suppression, not a 500.
    """
    reason = _gate(avail, tid, catalogue)
    if reason is not None:
        return None, {"id": tid, "reason": reason}
    try:
        tech = heuristic(sig)  # type: ignore[operator]
    except Exception as exc:  # a heuristic must never take the endpoint down
        return None, {"id": tid, "reason": f"predicate failed: {type(exc).__name__}"}
    if tech is None:
        return None, {}

    meta = catalogue.get(tid, {})
    optional: tuple[str, ...] = tuple(meta.get("optional", ()))  # type: ignore[arg-type]
    missing = _optional_missing(avail, optional)
    steps = len(missing)
    if steps:
        tech.severity = _downgrade(tech.severity, steps=steps)
        tech.evidence["confidence_downgrade"] = (
            f"-{steps} step(s): optional field(s) not present: {', '.join(missing)}"
        )
    tech.evidence.update(_evidence_extra(avail, sig))
    return tech, {}


# ── Host heuristics ────────────────────────────────────────────────────────

def _heuristic_t1071_001_host(sig: Signal) -> AttckTechnique | None:
    """T1071.001 — Application Layer Protocol: Web Protocols.

    A high volume of traffic across many distinct, mostly-ALLOWed destinations
    is the proxy-visible shape of HTTP(S) used as a C2 / beacon channel.
    """
    if sig.total_requests < 50:
        return None
    if sig.risk_share < 0.3:
        return None
    # The domain floor is field-gated upstream (T1071.001 requires only
    # @timestamp/client_ip), so substitute volume when domains are unreadable.
    if sig.available_fields.get("domain") == PRESENT:
        if sig.distinct_domains < 5:
            return None
        domain_leg: object = {"distinct_domains": sig.distinct_domains}
    else:
        if sig.total_requests < 200:
            return None
        domain_leg = {"distinct_domains": "unknown"}
    severity = "HIGH" if sig.risk_share >= 0.6 else "MEDIUM"
    if sig.interval_cv is not None and sig.interval_cv <= 0.35:
        severity = "HIGH" if severity == "MEDIUM" and sig.blacklisted_requests else severity
    return AttckTechnique(
        technique_id="T1071.001",
        name=_HOST_HEURISTICS["T1071.001"]["name"],
        severity=severity,
        description=_HOST_HEURISTICS["T1071.001"]["description"],
        evidence={
            "total_requests": sig.total_requests,
            "risk_share": round(sig.risk_share, 4),
            **domain_leg,
        },
    )


def _heuristic_t1090_003_host(sig: Signal) -> AttckTechnique | None:
    """T1090.003 — Proxy: Multi-hop Proxy.

    CDN/relay traffic carrying risk traffic. Without ``domain`` the CDN count
    is unobservable, so only the volume/risk leg remains and the caller's
    optional-field downgrade marks it.
    """
    if sig.available_fields.get("domain") == PRESENT:
        if sig.cdn_domain_count < 1:
            return None
    elif sig.total_requests < 200:
        # No domain field: cannot see CDN domains, so require a strong volume
        # proxy rather than emitting on an empty counter.
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

    Many distinct destinations, few enforcements, and a measurable transfer
    volume. Enforcements exceed risk here only when the proxy was actually
    resisting; ALLOW-heavy diversity is the staging shape.

    The volume leg must be a **measured** byte count. The
    ``duration_seconds × 8192`` proxy reaches this 1 MB floor on ~122 ordinary
    rows while inventing 38× the real byte total, so a proxy-only stream is
    treated as "volume not measured" and declines here rather than passing on
    an invented figure.
    """
    if sig.distinct_dest_ips < 10:
        return None
    if sig.risk_requests > 0 and sig.enforcements > sig.risk_requests * 0.5:
        return None
    if sig.bytes_source == "bytes":
        if sig.total_bytes is not None and sig.total_bytes < 1_000_000:
            return None
    else:
        # No measured byte field — the volume leg cannot be evaluated.
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
            "bytes_source": sig.bytes_source,
        },
    )


def _heuristic_t1053_005_host(sig: Signal) -> AttckTechnique | None:
    """T1053.005 — Scheduled Task/Job: Scheduled Task.

    Two independent signals, either of which is sufficient:

    * ``interval_cv`` — the load-bearing one. It reads the raw arrival gaps,
      so it separates a machine beat (≤ 0.35, measured 0.00 exact / 0.28 at
      20 % jitter) from Poisson load (≈ 1.0). This is what lets a 1-minute
      heartbeat be found at all.
    * ``slot_concentration`` — a coarse corroborator for a lockstep that
      survives build_timeline's bucket width (≥ 0.5). It cannot see a fast
      cadence; see its docstring. Kept because a 1-hour lockstep that is
      invisible to nothing still shows up here even when the arrival gaps are
      gappy enough to fail the CV sample floor.

    The historical ``periodicity_score`` is NOT consulted — on the bucket
    widths build_timeline produces it cannot score a real heartbeat above 0.
    """
    if sig.total_requests < 30:
        return None
    regular = False
    if sig.interval_cv is not None and sig.interval_cv <= 0.35:
        regular = True
    if sig.slot_concentration is not None and sig.slot_concentration >= 0.5:
        regular = True
    if not regular:
        return None
    return AttckTechnique(
        technique_id="T1053.005",
        name=_HOST_HEURISTICS["T1053.005"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1053.005"]["description"],
        evidence={
            "interval_cv": (
                None if sig.interval_cv is None else round(sig.interval_cv, 4)
            ),
            "slot_concentration": (
                None
                if sig.slot_concentration is None
                else round(sig.slot_concentration, 4)
            ),
            "total_requests": sig.total_requests,
        },
    )


def _heuristic_t1041_host(sig: Signal) -> AttckTechnique | None:
    """T1041 — Exfiltration Over C2 Channel.

    Large outbound volume on a mostly-ALLOWed, multi-destination session.
    Requires a **measured** byte source (real counters). The
    ``duration_seconds × 8192`` proxy may not be the sole basis for crossing a
    byte floor: on real proxy traffic (``duration_seconds: 0.01``) it invents
    ~8 KiB per row — 38× the real 215 B — and would reach this predicate's
    threshold on ~12k ordinary denied requests. When no byte counter resolves,
    the technique is gated away upstream, never emitted on ``total_bytes == 0``
    and never emitted on an invented total.
    """
    if sig.bytes_source != "bytes":
        # No measured byte field: a duration proxy is not byte evidence.
        return None
    if sig.total_bytes is None or sig.total_bytes < 100_000_000:
        return None
    if sig.risk_share < 0.5:
        return None
    if sig.available_fields.get("domain") == PRESENT and sig.distinct_domains < 3:
        return None
    return AttckTechnique(
        technique_id="T1041",
        name=_HOST_HEURISTICS["T1041"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1041"]["description"],
        evidence={
            "total_bytes": sig.total_bytes,
            "bytes_source": sig.bytes_source,
            "risk_share": round(sig.risk_share, 4),
            "distinct_domains": sig.distinct_domains,
        },
    )


def _heuristic_t1078_host(sig: Signal) -> AttckTechnique | None:
    """T1078 — Valid Accounts.

    A long, low-enforcement, sustained session to a web service is the
    indistinguishable-over-the-wire shape of valid-account abuse. Kept LOW
    unless a long window corroborates.
    """
    if sig.total_requests < 20:
        return None
    if sig.risk_share < 0.8:
        return None
    if sig.enforcements > 0:
        return None
    if sig.time_span_hours < 1.0:
        return None
    severity = "MEDIUM" if sig.time_span_hours >= 24 else "LOW"
    return AttckTechnique(
        technique_id="T1078",
        name=_HOST_HEURISTICS["T1078"]["name"],
        severity=severity,
        description=_HOST_HEURISTICS["T1078"]["description"],
        evidence={
            "total_requests": sig.total_requests,
            "time_span_hours": sig.time_span_hours,
            "enforcements": sig.enforcements,
        },
    )


def _heuristic_t1583_003_host(sig: Signal) -> AttckTechnique | None:
    """T1583.003 — Acquire Infrastructure: Virtual Private Server.

    Repeat contact with a *small* set of non-CDN destinations, sustained over
    time, is the operator-owned-infrastructure pattern. Infrastructure
    rationale, not in-app C2: the technique names the asset, not the channel.
    """
    if sig.distinct_dest_ips < 1 or sig.distinct_dest_ips > 5:
        return None
    if sig.time_span_hours < 12:
        return None
    if sig.risk_share < 0.5:
        return None
    if sig.available_fields.get("domain") == PRESENT and sig.cdn_domain_count:
        return None
    return AttckTechnique(
        technique_id="T1583.003",
        name=_HOST_HEURISTICS["T1583.003"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1583.003"]["description"],
        evidence={
            "distinct_dest_ips": sig.distinct_dest_ips,
            "time_span_hours": sig.time_span_hours,
            "risk_share": round(sig.risk_share, 4),
        },
    )


def _heuristic_t1583_001_host(sig: Signal) -> AttckTechnique | None:
    """T1583.001 — Acquire Infrastructure: Domains.

    Many distinct destinations contacted for one or two requests each is the
    disposable-domain-set shape (a spray, not a relationship). The technique
    names *domains*, so it is meaningless without a readable ``domain`` field —
    a spray of IPs can be a CDN edge, a scanner, or NAT, and calling that a
    freshly-acquired domain set would be fabrication. Guarded explicitly so the
    requirement is visible even though the catalogue gate is server_ip-only.
    """
    # The guard duplicates this technique's `domain` optional entry on purpose:
    # the optional list only downgrades, and here the field is load-bearing.
    if sig.available_fields.get("domain") != PRESENT:
        return None
    if sig.distinct_dest_ips < 20:
        return None
    if sig.distinct_domains < 20:
        return None
    if sig.total_requests > sig.distinct_dest_ips * 3:
        return None  # repeat relationships, not a one-touch set
    return AttckTechnique(
        technique_id="T1583.001",
        name=_HOST_HEURISTICS["T1583.001"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1583.001"]["description"],
        evidence={
            "distinct_dest_ips": sig.distinct_dest_ips,
            "distinct_domains": sig.distinct_domains,
            "total_requests": sig.total_requests,
        },
    )


def _heuristic_t1567_host(sig: Signal) -> AttckTechnique | None:
    """T1567 — Exfiltration Over Web Service.

    Upload-heavy split to a web service. Uses whichever byte counter is
    readable; suppressed upstream when none is.
    """
    if sig.upload_bytes is None or sig.download_bytes is None:
        return None
    if sig.upload_bytes < 50_000_000:
        return None
    total = sig.upload_bytes + sig.download_bytes
    if total <= 0 or sig.upload_bytes / total < 0.6:
        return None
    return AttckTechnique(
        technique_id="T1567",
        name=_HOST_HEURISTICS["T1567"]["name"],
        severity="MEDIUM",
        description=_HOST_HEURISTICS["T1567"]["description"],
        evidence={
            "upload_bytes": sig.upload_bytes,
            "download_bytes": sig.download_bytes,
            "upload_share": round(sig.upload_share or 0.0, 4),
        },
    )


def _heuristic_t1114_002_host(sig: Signal) -> AttckTechnique | None:
    """T1114.002 — Email Collection: Remote Email Collection.

    A read-oriented endpoint plus an upload-heavy / long-lived shape. This is
    the host-level reading of the same evidence the URL heuristic uses; both
    are LOW because a proxy cannot see a mailbox, only a pattern.
    """
    if not sig.available_fields:
        return None
    if sig.upload_bytes is None:
        return None
    if sig.upload_bytes < 10_000_000:
        return None
    if sig.risk_share < 0.8 or sig.total_requests < 20:
        return None
    return AttckTechnique(
        technique_id="T1114.002",
        name=_HOST_HEURISTICS["T1114.002"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1114.002"]["description"],
        evidence={
            "upload_bytes": sig.upload_bytes,
            "total_requests": sig.total_requests,
            "risk_share": round(sig.risk_share, 4),
        },
    )


def _heuristic_t1204_002_host(sig: Signal) -> AttckTechnique | None:
    """T1204.002 — User Execution: Malicious File.

    A burst of *rejected* content-navigation requests across many destinations
    is a malware-delivery attempt that did not settle. Requires ``action``
    (to see the burst shape) and ``url`` (to see it is navigation at all).
    """
    if sig.total_requests < 100:
        return None
    if sig.enforcements < 3:
        return None
    if sig.available_fields.get("domain") == PRESENT and sig.distinct_domains < 5:
        return None
    return AttckTechnique(
        technique_id="T1204.002",
        name=_HOST_HEURISTICS["T1204.002"]["name"],
        severity="MEDIUM",
        description=_HOST_HEURISTICS["T1204.002"]["description"],
        evidence={
            "total_requests": sig.total_requests,
            "enforcements": sig.enforcements,
            "distinct_domains": sig.distinct_domains,
        },
    )


def _heuristic_t1567_002_host(sig: Signal) -> AttckTechnique | None:
    """T1567.002 — Exfiltration to Cloud Storage.

    A policy class that names a cloud-storage service (rule_name/category)
    carrying an upload. The class name is the whole evidence: without a
    ``rule_name``/``category`` value there is nothing to name, so the catalogue
    gate withholds the technique rather than inferring a provider from a URL.
    """
    if sig.upload_bytes is None or sig.upload_bytes < 10_000_000:
        return None
    if sig.available_fields.get("bytes_uploaded") != PRESENT and (
        sig.available_fields.get("bytes_downloaded") != PRESENT
    ):
        return None
    return AttckTechnique(
        technique_id="T1567.002",
        name=_HOST_HEURISTICS["T1567.002"]["name"],
        severity="LOW",
        description=_HOST_HEURISTICS["T1567.002"]["description"],
        evidence={
            "upload_bytes": sig.upload_bytes,
            "bytes_source": sig.bytes_source,
        },
    )


_HOST_HEURISTICS_LIST: list[tuple[str, object]] = [
    ("T1071.001", _heuristic_t1071_001_host),
    ("T1090.003", _heuristic_t1090_003_host),
    ("T1029.001", _heuristic_t1029_001_host),
    ("T1053.005", _heuristic_t1053_005_host),
    ("T1041", _heuristic_t1041_host),
    ("T1078", _heuristic_t1078_host),
    ("T1583.003", _heuristic_t1583_003_host),
    ("T1583.001", _heuristic_t1583_001_host),
    ("T1567", _heuristic_t1567_host),
    ("T1114.002", _heuristic_t1114_002_host),
    ("T1567.002", _heuristic_t1567_002_host),
    ("T1204.002", _heuristic_t1204_002_host),
]


# ── URL heuristics ──────────────────────────────────────────────────────────

def _heuristic_t1071_001_url(sig: Signal) -> AttckTechnique | None:
    """T1071.001 — Application Layer Protocol: Web Protocols.

    One endpoint hit by many distinct clients is a shared resource — possibly
    a beacon/poll endpoint. A single client hitting it is just a user.
    """
    if sig.total_accesses < 20:
        return None
    if sig.distinct_clients < 3:
        return None
    severity = "MEDIUM"
    if sig.interval_cv is not None and sig.interval_cv <= 0.35 and sig.total_accesses >= 100:
        severity = "HIGH"
    return AttckTechnique(
        technique_id="T1071.001",
        name=_URL_HEURISTICS["T1071.001"]["name"],
        severity=severity,
        description=_URL_HEURISTICS["T1071.001"]["description"],
        evidence={
            "total_accesses": sig.total_accesses,
            "distinct_clients": sig.distinct_clients,
        },
    )


def _heuristic_t1105_url(sig: Signal) -> AttckTechnique | None:
    """T1105 — Ingress Tool Transfer.

    Download-shaped volume on a shared URL. A bare download URL is not by
    itself a tool transfer, so the byte leg carries the weight; the gate
    requires at least one byte/response-size field so this can never fire on
    an empty projection.
    """
    if sig.total_accesses < 20:
        return None
    if sig.download_bytes is None:
        return None
    if sig.download_bytes < 1_000_000:
        return None
    severity = "MEDIUM"
    if sig.distinct_clients >= 3:
        severity = "HIGH" if sig.download_bytes >= 50_000_000 else severity
    return AttckTechnique(
        technique_id="T1105",
        name=_URL_HEURISTICS["T1105"]["name"],
        severity=severity,
        description=_URL_HEURISTICS["T1105"]["description"],
        evidence={
            "total_accesses": sig.total_accesses,
            "distinct_clients": sig.distinct_clients,
            "download_bytes": sig.download_bytes,
            "bytes_source": sig.bytes_source,
        },
    )


def _heuristic_t1090_003_url(sig: Signal) -> AttckTechnique | None:
    """T1090.003 — Proxy: Multi-hop Proxy.

    The URL's host resolves through CDN / relay infrastructure, which can mask
    the true origin. Classifier-only evidence is weak, so this stays LOW; the
    host heuristic raises the same finding when risk traffic corroborates.
    """
    if not (sig.host_is_cdn or sig.host_is_proxy):
        return None
    return AttckTechnique(
        technique_id="T1090.003",
        name=_URL_HEURISTICS["T1090.003"]["name"],
        severity="LOW",
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


# ── Availability-driven runners ─────────────────────────────────────────────

def _run_host_heuristics(
    sig: Signal, avail: FieldAvailability
) -> tuple[list[AttckTechnique], list[dict[str, str]]]:
    """Gate + run the host catalogue against resolved field availability."""
    techniques: list[AttckTechnique] = []
    suppressed: list[dict[str, str]] = []
    for tid, fn in _HOST_HEURISTICS_LIST:
        tech, reason = _evaluate(avail, tid, _HOST_HEURISTICS, fn, sig)
        if tech is not None:
            techniques.append(tech)
        elif reason:
            suppressed.append(reason)
    return techniques, suppressed


def _run_url_heuristics(
    sig: Signal, avail: FieldAvailability
) -> tuple[list[AttckTechnique], list[dict[str, str]]]:
    """Gate + run the URL catalogue against resolved field availability."""
    techniques: list[AttckTechnique] = []
    suppressed: list[dict[str, str]] = []
    for tid, fn in _URL_HEURISTICS_LIST:
        tech, reason = _evaluate(avail, tid, _URL_HEURISTICS, fn, sig)
        if tech is not None:
            techniques.append(tech)
        elif reason:
            suppressed.append(reason)
    return techniques, suppressed


# ── Core mapping functions ──────────────────────────────────────────────────

async def map_host(ip: str, minutes: int) -> AttckMapping:
    """Map a single client IP to ATT&CK techniques.

    Queries Elasticsearch using the same block-pattern query as the
    monitoring pipeline, resolves which fields the docs actually carry,
    aggregates signals, then runs the host catalogue behind the gate.
    """
    generated_at = datetime.now(timezone.utc).isoformat()
    signals = Signal(es_online=True)
    techniques: list[AttckTechnique] = []
    suppressed: list[dict[str, str]] = []
    data_sources: list[str] = []

    try:
        settings = get_settings()
        avail = resolve_availability()
        signals.available_fields = dict(avail.fields)
        signals.mode = avail.mode

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
        data_sources = ["es", "blacklist", f"field_inventory:{avail.mode}"]

        # ── Availability gate: the mode is resolved before any ES call, so an
        # unusable inventory short-circuits with zero techniques, exactly as
        # the spec requires (never guess a technique whose fields are absent).
        if avail.mode == "UNKNOWN":
            signals.es_online = False
            return AttckMapping(
                entity={"kind": "host", "value": ip},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=False,
                signals=signals,
                techniques=[],
                summary="UNKNOWN mode: techniques not resolvable.",
            )

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

        _aggregate_host_signals(signals, df, avail, blacklist_set, minutes)

        # Run the gated host catalogue.
        techniques, suppressed = _run_host_heuristics(signals, avail)

        summary_parts = [
            f"Host {ip}: {signals.total_requests} requests",
            f"risk share {signals.risk_share:.1%}.",
        ]
        if avail.has("domain"):
            summary_parts.insert(1, f"{signals.distinct_domains} distinct domains,")
        if signals.bytes_source != "none":
            summary_parts.append(f"bytes={signals.total_bytes} ({signals.bytes_source}).")
        if techniques:
            summary_parts.append(
                "Matched "
                + ", ".join(f"{t.technique_id}({t.severity})" for t in techniques)
                + "."
            )
        else:
            summary_parts.append("No ATT&CK techniques matched.")
        if suppressed:
            summary_parts.append(
                "Suppressed (fields absent): "
                + ", ".join(s["id"] for s in suppressed)
                + "."
            )
        summary = " ".join(summary_parts)

    except Exception as e:
        signals.es_online = False
        summary = f"Mapping failed: {e}"

    # A suppressed technique produces no ``techniques[]`` entry, so its reason
    # has nowhere to live in that array. It rides in ``signals.suppressed``
    # (structured) and in ``summary`` (prose) — never in
    # ``techniques[].evidence``, which by construction only describes
    # techniques that were actually emitted.
    signals.suppressed = suppressed
    summary = _with_suppressed(summary, suppressed)

    return AttckMapping(
        entity={"kind": "host", "value": ip},
        generated_at=generated_at,
        data_sources=data_sources,
        es_online=signals.es_online,
        signals=signals,
        techniques=techniques,
        summary=summary,
    )


def _aggregate_host_signals(
    signals: Signal,
    df: pd.DataFrame,
    avail: FieldAvailability,
    blacklist_set: set[str],
    minutes: int,
) -> None:
    """Fill *signals* from *df*, reading only fields that resolved PRESENT.

    Never fabricates: a missing column leaves the signal at its UNKNOWN-safe
    default (``total_bytes``/``periodicity`` stay ``None``) instead of reading
    the empty-string column apply_filters planted.
    """
    signals.total_requests = int(len(df))

    # ── action ──
    if avail.has("action"):
        actions = df["action"].fillna("").astype(str).str.strip().str.upper()
        signals.risk_requests = int(actions.isin(["ALLOW", ""]).sum())
        signals.enforcements = int(actions.isin(["DENY", "FLAG"]).sum())
        if signals.enforcements == 0 and signals.risk_requests == signals.total_requests:
            # Legacy rows carry no usable action value. Every block-pattern hit
            # was an ALLOW risk by construction, but a stream with zero
            # observed enforcement is a FLOOR, not a measurement — de-boost so
            # downstream share gates cannot read 100% risk off absent labels.
            signals.risk_requests = signals.total_requests
    else:
        # action is a hard ABSENT field: treat risk as a floor, not a count.
        signals.risk_requests = signals.total_requests
        signals.enforcements = 0

    signals.blacklisted_requests = int(
        df["base_url"].astype(str).isin(blacklist_set).sum()
    )
    signals.distinct_domains = (
        int(df["domain"].nunique()) if avail.has("domain") else 0
    )
    signals.distinct_dest_ips = (
        int(df["server_ip"].nunique()) if avail.has("server_ip") else 0
    )
    signals.distinct_http_methods = (
        set(str(m) for m in df["http_method"].dropna().unique() if str(m).strip())
        if avail.has("http_method")
        else set()
    )

    # ── byte accounting, with provenance ──
    download = _sum_column(df, "bytes_downloaded")
    upload = _sum_column(df, "bytes_uploaded")
    if download is not None or upload is not None:
        signals.download_bytes = int(download or 0)
        signals.upload_bytes = int(upload or 0)
        signals.total_bytes = signals.download_bytes + signals.upload_bytes
        signals.bytes_source = "bytes"
    elif avail.has("duration_seconds"):
        # Documented proxy: duration × 8192 bytes/s (analytics.py does the
        # same). Kept distinct in evidence so a reader never mistakes it for a
        # measured byte count.
        durs = pd.to_numeric(df["duration_seconds"], errors="coerce").fillna(0)
        durs = durs.apply(lambda d: max(1, int(d)) if pd.notna(d) else 1)
        signals.total_bytes = int(durs.sum()) * 8192
        signals.download_bytes = signals.total_bytes
        signals.upload_bytes = 0
        signals.bytes_source = "duration-proxy"
    else:
        signals.total_bytes = None  # UNKNOWN — nothing to measure with
        signals.bytes_source = "none"
    if signals.total_bytes:
        signals.upload_share = round((signals.upload_bytes or 0) / signals.total_bytes, 4)

    signals.risk_share = (
        signals.risk_requests / signals.total_requests
        if signals.total_requests > 0
        else 0.0
    )
    if not avail.has("action"):
        # No enforcement labels were readable: cap the risk share at a floor
        # (see the de-boost note above) rather than asserting 100 %.
        signals.risk_share = min(signals.risk_share, 0.9)

    signals.cdn_domain_count = (
        int(df["domain"].astype(str).apply(_is_cdn).sum()) if avail.has("domain") else 0
    )

    # ── periodicity: the two sparse-safe statistics only ──
    # The historical `1 - std/mean` dispersion score is deliberately NOT
    # computed here (see the module note above): it is monotone in sample
    # density rather than in periodicity, and it scores a true heartbeat 0.0
    # on the bucket widths build_timeline produces. `periodicity_score` stays
    # on the wire contract at its 0.0 default for frontend compatibility; no
    # predicate reads it.
    if avail.has("@timestamp"):
        ts = pd.to_datetime(df["@timestamp"], errors="coerce", utc=True)
        if not ts.empty:
            span_s = (ts.max() - ts.min()).total_seconds()
            signals.time_span_hours = round(span_s / 3600, 2)
            signals.interval_cv = _interval_cv(ts)
        # Capped window: beyond 7d the minute-granularity timeline is a
        # memory/CPU hazard, and slot_concentration needs a stable span.
        if minutes <= 10080:
            signals.slot_concentration = _slot_concentration(build_timeline(df, minutes))


def _sum_column(df: pd.DataFrame, name: str) -> int | None:
    """Sum a numeric column, or None when it did not resolve (vs a real 0)."""
    if name not in df.columns:
        return None
    series = pd.to_numeric(df[name], errors="coerce")
    if series.notna().sum() == 0 and (series.isna()).all():
        # Present but entirely unparseable (empty strings from apply_filters's
        # default fill) — treat as not measured rather than as zero.
        return None
    return int(series.fillna(0).sum())


async def map_url(url: str, source: str = "live", limit: int = 50) -> AttckMapping:
    """Map a single URL to ATT&CK techniques.

    When ``source="live"`` queries Elasticsearch; when
    ``source="findings"`` queries the persisted findings table.

    The findings source reads SQLite, not ES, so its fields are whatever the
    rows carry — the gate is built from that row shape instead of the ES mode.
    """
    generated_at = datetime.now(timezone.utc).isoformat()
    signals = Signal(es_online=True)
    techniques: list[AttckTechnique] = []
    suppressed: list[dict[str, str]] = []
    data_sources: list[str] = []

    try:
        settings = get_settings()

        # Both sources gate on the ES-resolved mode: the findings path reads
        # SQLite, but that table's shape is itself driven by the same mode
        # (result_processor.store_findings), so one resolver covers both.
        avail = resolve_availability()

        signals.available_fields = dict(avail.fields)
        signals.mode = avail.mode

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
        data_sources = [
            "findings" if source == "findings" else "es",
            "blacklist",
            f"field_inventory:{avail.mode}",
        ]

        whitelist_regex = _build_pattern_regex(whitelist_patterns)

        # Resolve the URL host for CDN/proxy detection. This reads only `url`,
        # which is BASELINE (always present), so it is not gated.
        _HOST_RE = re.compile(r"^https?://([^/]+)")
        m = _HOST_RE.match(url)
        host = m.group(1) if m else ""
        signals.host_is_cdn = _is_cdn(host)
        signals.host_is_proxy = _is_proxy(host)

        if source != "live":
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

            # A findings row carries url/client_ip (grouped) and timestamps but
            # no bytes/content — the byte-gated techniques are withheld, which
            # is reported rather than guessed.
            techniques, suppressed = _run_url_heuristics(signals, avail)
            signals.suppressed = suppressed
            summary = _with_suppressed(
                _build_url_summary(url, signals, techniques), suppressed
            )
            return AttckMapping(
                entity={"kind": "url", "value": url},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=True,
                signals=signals,
                techniques=techniques,
                summary=summary,
            )

        if avail.mode == "UNKNOWN":
            signals.es_online = False
            return AttckMapping(
                entity={"kind": "url", "value": url},
                generated_at=generated_at,
                data_sources=data_sources,
                es_online=False,
                signals=signals,
                techniques=[],
                summary="UNKNOWN mode: techniques not resolvable.",
            )

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

        _aggregate_url_signals(signals, df, avail)

        techniques, suppressed = _run_url_heuristics(signals, avail)
        summary = _with_suppressed(_build_url_summary(url, signals, techniques), suppressed)

    except Exception as e:
        signals.es_online = False
        summary = f"Mapping failed: {e}"

    # Same as the host path: the structured suppression list rides in
    # ``signals.suppressed`` (see the comment there for why not evidence[]).
    signals.suppressed = suppressed
    summary = _with_suppressed(summary, suppressed)

    return AttckMapping(
        entity={"kind": "url", "value": url},
        generated_at=generated_at,
        data_sources=data_sources,
        es_online=signals.es_online,
        signals=signals,
        techniques=techniques,
        summary=summary,
    )


def _aggregate_url_signals(
    signals: Signal, df: pd.DataFrame, avail: FieldAvailability
) -> None:
    """Fill URL signals from a live ES dataframe, gated on availability."""
    signals.total_accesses = int(len(df))
    signals.distinct_clients = (
        int(df["client_ip"].nunique()) if avail.has("client_ip") else 0
    )
    if avail.has("@timestamp"):
        ts = pd.to_datetime(df["@timestamp"], errors="coerce", utc=True)
        if not ts.empty:
            signals.last_seen = ts.max().isoformat()
            signals.first_seen = ts.min().isoformat()
            signals.interval_cv = _interval_cv(ts)
    download = _sum_column(df, "bytes_downloaded")
    upload = _sum_column(df, "bytes_uploaded")
    if download is not None or upload is not None:
        signals.download_bytes = int(download or 0)
        signals.upload_bytes = int(upload or 0)
        signals.total_bytes = signals.download_bytes + signals.upload_bytes
        signals.bytes_source = "bytes"
    else:
        signals.total_bytes = None
        signals.bytes_source = "none"


def _build_url_summary(
    url: str, sig: Signal, techniques: list[AttckTechnique]
) -> str:
    """Build a human-readable summary string for a URL mapping."""
    parts = [
        f"URL {url}: {sig.total_accesses} accesses, "
        f"{sig.distinct_clients} distinct clients."
    ]
    if techniques:
        parts.append(
            "Matched "
            + ", ".join(f"{t.technique_id}({t.severity})" for t in techniques)
            + "."
        )
    else:
        parts.append("No ATT&CK techniques matched.")
    return " ".join(parts)


def _with_suppressed(
    summary: str, suppressed: list[dict[str, str]]
) -> str:
    """Append suppression reasons to a summary without changing the shape."""
    if not suppressed:
        return summary
    return summary + " | suppressed: " + "; ".join(
        f"{s['id']}: {s['reason']}" for s in suppressed
    )
