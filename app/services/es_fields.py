"""Elasticsearch field inventory — field-sample gate.

Provides a cached inventory of one sample document + field capabilities
from the Elasticsearch index. Runs at startup (best-effort) and on-demand
via debug endpoint. All field-reading code depends on this gate.
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.es_client import es_client

log = logging.getLogger(__name__)

# Module-level cache: populated once per process, invalidatable for tests
_field_inventory: dict[str, Any] | None = None


def _invalidate_cache() -> None:
    """Clear the cached inventory (used by tests)."""
    global _field_inventory
    _field_inventory = None


async def fetch_field_inventory(es: Any | None = None) -> dict[str, Any]:
    """Fetch one sample document and field capabilities from Elasticsearch.

    Args:
        es: Optional pre-built AsyncElasticsearch client. If None, a client
            is created and managed via the context manager.

    Returns:
        Dict with keys: "sample" (one _source document or {}), "field_caps"
        (dict from field_caps API or {}), "cached" (bool), "mode" (str).

    Never raises — on any failure returns a safe default with es_online=False.
    """
    global _field_inventory

    # Return cached if available
    if _field_inventory is not None:
        return {**_field_inventory, "cached": True}

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

    _field_inventory = {
        "sample": sample_doc,
        "field_caps": field_caps,
        "cached": False,
        "mode": mode,
        "es_online": es_online,
    }
    return _field_inventory


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
    "mode_has_extended_findings",
]
