"""Normalizes raw Kibana/ES hits to the app's canonical schema (spec §5.2).

Maps a raw ``_source`` document (nested Kibana/ECS shape) to
``NormalizedAppState`` (id, timestamp, src_ip, src_host, dest_ip, domain,
url, action, duration_ms, bytes, matched_pattern_id/name).

``FieldMap`` indirection is supported for custom index schemas: when a
``FieldMap`` is provided, mapped dotted paths are resolved (e.g.
``field_map.src_ip = "client_ip"``) and fall back to the literal §5.2 default
path when a mapped field is absent from the document. The brief's literal
mapping is the default path so existing indices need no configuration.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.routes.settings import FieldMap


def _get_dotted(source: dict[str, Any], dotted: str) -> Any:
    """Resolve a dotted path like ``"source.ip"`` inside ``_source``.

    Returns ``None`` when any segment is missing or the cursor stops being a
    dict. Single-segment keys like ``"@timestamp"`` are handled naturally
    (split yields one segment).
    """
    if not dotted or not isinstance(source, dict):
        return None
    cur: Any = source
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
        if cur is None:
            return None
    return cur


class Normalizer:
    """Raw ES hit → NormalizedAppState transformer."""

    @staticmethod
    def to_app_state(hit: dict[str, Any], field_map: FieldMap | None = None) -> dict[str, Any]:
        """Map a single ES hit to ``NormalizedAppState``.

        ``hit`` is the ES envelope ``{"_id": str, "_source": {...}}`` as
        returned by ``_search``. ``field_map`` (optional) supplies custom
        field names remapped via System Settings; dotted paths are resolved
        (``"source.ip"``, ``"url.full"``). Missing values surface as ``None``
        (or ``""`` for action) — never an exception.
        """
        src: dict[str, Any] = (
            hit.get("_source") if isinstance(hit.get("_source"), dict) else {}
        )

        def mapped(field_map_attr: str, default_dotted: str) -> Any:
            """Mapped dotted value first, literal default second."""
            if field_map is not None:
                mapped_path = getattr(field_map, field_map_attr)
                val = _get_dotted(src, mapped_path)
                if val is not None:
                    return val
            return _get_dotted(src, default_dotted)

        timestamp = (
            _get_dotted(src, field_map.timestamp)
            if field_map is not None
            else src.get("@timestamp")
        )
        if timestamp is None and field_map is not None:
            timestamp = src.get("@timestamp")

        src_ip = mapped("src_ip", "source.ip")
        # FieldMap has no src_host key — always the literal source.host path.
        src_host = _get_dotted(src, "source.host")
        dest_ip = mapped("dest_ip", "destination.ip")
        domain = mapped("domain", "destination.domain")
        if not domain:
            domain = _get_dotted(src, "url.domain")
        url = mapped("url", "url.full")
        raw_action = mapped("action", "event.action")
        action = (raw_action or "").upper() if raw_action is not None else ""
        duration_ms = mapped("duration", "event.duration")
        bts = _get_dotted(src, "source.bytes")

        rule = src.get("rule") if isinstance(src.get("rule"), dict) else {}

        return {
            "id": hit.get("_id"),
            "timestamp": timestamp,
            "src_ip": src_ip,
            "src_host": src_host,
            "dest_ip": dest_ip,
            "domain": domain,
            "url": url,
            "action": action,
            "duration_ms": duration_ms,
            "bytes": bts,
            "matched_pattern_id": rule.get("id"),
            "matched_pattern_name": rule.get("name"),
        }
