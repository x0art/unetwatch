"""Elasticsearch field inventory — field-sample gate.

Provides a cached inventory of one sample document + field capabilities
from the Elasticsearch index. Runs at startup (best-effort), on a scheduled
refresh, and on-demand via the debug endpoint. All field-reading code
depends on this gate.

Cache policy (chosen deliberately — see ``_FAILED_TTL_SECONDS``):

* **A success is cached for the process lifetime.** A resolved mode
  (UC-A/UC-B/COLLAPSED) is a statement about the deployment's *schema*, which
  changes rarely; re-fetching it on every ATT&CK request would add an ES
  round-trip to every panel load for no information gain. The scheduled
  refresh (main.py lifespan) picks up schema drift without a restart.
* **A failure is never cached permanently.** When ``es_online`` is False the
  payload is *returned* (callers still get a well-formed, never-raising
  result) but the module global is deliberately left as-is, so the next call
  retries instead of serving "mode=UNKNOWN" for the rest of the process. This
  was a real trap: a transient ES failure at boot used to poison the cache
  forever, and only a restart recovered the ATT&CK panel.
* **Failures are throttled, not retried freely.** ``_last_failure_at``
  records the monotonic timestamp of the last failed fetch and the failure
  result is served from memory (marked ``cached: True``) for
  ``_FAILED_TTL_SECONDS``. Without this, a persistently-down ES would make
  every ATT&CK request block on a fresh round-trip until it timed out.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from app.services.es_client import es_client

log = logging.getLogger(__name__)

# Module-level cache: a SUCCESS is cached for the process lifetime,
# invalidatable for tests. A failure never lands here (see module docstring).
_field_inventory: dict[str, Any] | None = None
_last_failure: dict[str, Any] | None = None
_last_failure_at: float | None = None

# How long a failed fetch is served from memory before we try ES again.
# 30 s is short enough that an operator who fixes ES sees the panel recover
# within one refresh, and long enough that a page load's worth of concurrent
# ATT&CK requests (host + URL panels, retries) collapses onto one round-trip
# instead of each blocking on a fresh connect timeout (~10-30 s each).
_FAILED_TTL_SECONDS = 30.0


def _invalidate_cache() -> None:
    """Clear the cached inventory and the failure throttle (used by tests)."""
    global _field_inventory, _last_failure, _last_failure_at
    _field_inventory = None
    _last_failure = None
    _last_failure_at = None


async def fetch_field_inventory(es: Any | None = None) -> dict[str, Any]:
    """Fetch one sample document and field capabilities from Elasticsearch.

    Args:
        es: Optional pre-built AsyncElasticsearch client. If None, a client
            is created and managed via the context manager.

    Returns:
        Dict with keys: "sample" (one _source document or {}), "field_caps"
        (dict from field_caps API or {}), "cached" (bool), "mode" (str),
        "es_online" (bool).

    Never raises — on any failure returns a safe default with es_online=False.

    Cache semantics:
        * success  -> stored in ``_field_inventory``; later calls return it
          with ``cached: True``.
        * failure  -> returned but NOT stored; the next call retries, unless
          the previous failure is younger than ``_FAILED_TTL_SECONDS``, in
          which case the memoised failure is returned (``cached: True``) so a
          down ES cannot make every request pay a connection timeout.
    """
    global _field_inventory, _last_failure, _last_failure_at

    # Return cached SUCCESS if available.
    if _field_inventory is not None:
        return {**_field_inventory, "cached": True}

    # Negative-result throttle: while a recent failure is fresh, serve it from
    # memory rather than blocking on another ES round-trip.
    if _last_failure is not None and _last_failure_at is not None:
        if time.monotonic() - _last_failure_at < _FAILED_TTL_SECONDS:
            return {**_last_failure, "cached": True}

    settings = None
    try:
        from app.config import get_settings

        settings = get_settings()
    except Exception:
        pass

    sample_doc: dict[str, Any] = {}
    field_caps: dict[str, Any] = {}
    es_online = False

    async def _do_fetch(client: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        # Fetch one sample document
        sample_res = await client.search(
            index=settings.elastic_index if settings else "logs-*",
            body={"size": 1, "query": {"match_all": {}}, "_source": True},
        )
        hits = sample_res.get("hits", {}).get("hits", [])
        sample = hits[0]["_source"] if hits else {}

        # Fetch field capabilities
        caps_res = await client.field_caps(index=settings.elastic_index if settings else "logs-*")
        caps = caps_res.get("fields", {})

        return sample, caps

    try:
        if es is not None:
            sample_doc, field_caps = await _do_fetch(es)
            es_online = True
        else:
            async with es_client(settings) as client:
                sample_doc, field_caps = await _do_fetch(client)
                es_online = True
    except Exception as e:
        log.warning(f"[es_fields] Failed to fetch field inventory: {e}")
        es_online = False

    # Determine mode based on confirmed fields
    mode = _resolve_mode(sample_doc, field_caps, es_online)

    payload = {
        "sample": sample_doc,
        "field_caps": field_caps,
        "cached": False,
        "mode": mode,
        "es_online": es_online,
    }

    if es_online:
        # Only a successful fetch describes the schema; cache it for the
        # process lifetime (the scheduled refresh replaces it on drift).
        _last_failure = None
        _last_failure_at = None
        _field_inventory = payload
        return payload

    # A failed fetch is returned but NEVER promoted into the success cache:
    # doing so would pin mode="UNKNOWN" for the whole process and blank the
    # ATT&CK panel until a restart. Record it only as a throttled negative.
    _last_failure = payload
    _last_failure_at = time.monotonic()
    log.warning(
        "[es_fields] Serving uncached UNKNOWN inventory; will retry in %.0fs",
        _FAILED_TTL_SECONDS,
    )
    return payload


def _resolve_mode(sample: dict, caps: dict, es_online: bool) -> str:
    """Resolve the field mode from inventory.

    Modes per spec §7-AC1, §8-Q3:
    - UC-A: user_agent + username + session + action + duration_seconds present
    - UC-B: username + session + action + duration_seconds present (no user_agent)
    - COLLAPSED: only the six baseline fields present
    """
    if not es_online:
        return "UNKNOWN"

    # Check for the six confirmed baseline fields
    baseline = {"@timestamp", "url", "client_ip", "server_ip", "duration_seconds", "action"}
    has_baseline = baseline.issubset(sample.keys()) or all(f in caps for f in baseline)

    if not has_baseline:
        return "UNKNOWN"

    # Check UC-A fields
    uc_a_extra = {"user_agent", "username", "session"}
    has_uc_a = uc_a_extra.issubset(sample.keys()) or all(f in caps for f in uc_a_extra)

    if has_uc_a:
        return "UC-A"

    # Check UC-B fields (no user_agent)
    uc_b_extra = {"username", "session"}
    has_uc_b = uc_b_extra.issubset(sample.keys()) or all(f in caps for f in uc_b_extra)

    if has_uc_b:
        return "UC-B"

    return "COLLAPSED"


def get_cached_inventory() -> dict[str, Any] | None:
    """Return the cached inventory without fetching (for tests/debug)."""
    return _field_inventory


def get_mode() -> str:
    """Return the current field mode (UC-A, UC-B, COLLAPSED, UNKNOWN)."""
    inv = get_cached_inventory()
    return inv.get("mode", "UNKNOWN") if inv else "UNKNOWN"


def cached_mode() -> str:
    """Return the cached mode without triggering a fetch (pure read).

    ``get_mode()`` is a pure read today, but callers that must stay synchronous
    and side-effect free (the ATT&CK resolver) should depend on this explicit
    contract rather than on ``get_mode``'s current implementation.
    """
    return get_mode()


def inventory_field_names() -> set[str]:
    """Return the union of fields the cached inventory actually observed.

    A name counts as observed when it appears either in the sampled document's
    keys or in ``field_caps``. This is deliberately the *union*: the ATT&CK
    availability resolver treats "seen in either" as present, because a single
    sampled document can legitimately omit a field the mapping carries.

    Returns an empty set when no inventory has been fetched. An empty set is
    indistinguishable from "nothing present", so callers MUST pair it with a
    mode check (see ``attck_mapping.resolve_availability``) before concluding
    that a field is absent.
    """
    inv = get_cached_inventory()
    if not inv:
        return set()
    names: set[str] = set()
    sample = inv.get("sample") or {}
    if isinstance(sample, dict):
        names.update(str(k) for k in sample)
    caps = inv.get("field_caps") or {}
    if isinstance(caps, dict):
        names.update(str(k) for k in caps)
    return names


def mode_has_extended_findings() -> bool:
    """Return True if mode is UC-A or UC-B (has action/duration_seconds + user_agent/identity)."""
    mode = get_mode()
    return mode in ("UC-A", "UC-B")


# Export invalidation for tests
__all__ = [
    "fetch_field_inventory",
    "get_cached_inventory",
    "_invalidate_cache",
    "get_mode",
    "cached_mode",
    "inventory_field_names",
    "mode_has_extended_findings",
]
