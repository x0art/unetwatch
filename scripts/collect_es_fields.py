#!/usr/bin/env python3
"""Read-only Elasticsearch field-collection CLI for uNetWatch handover.

Collects everything an analyst needs to finalise the ATT&CK mapping against
REAL proxy field data and writes it to a single JSON report:

    1. Connection metadata (host, index, ping, ES version)
    2. Index mapping (``_mapping``) — the raw field tree
    3. Field capabilities (``_field_caps?fields=*``) — authoritative field list
    4. A 3-document sample, ``_source`` verbatim (REDACT NOTHING)
    5. Baseline / extended / rich field presence table
    6. Resolved mode (UC-A / UC-B / COLLAPSED / UNKNOWN) via the app resolver
    7. Cheap aggregate cardinality hints (client_ip, base_url, category,
       http_method, action)

Honesty contract
----------------
* **Read-only.** No writes to ES, ever. Only ``ping``, ``_mapping``,
  ``_field_caps``, ``_search``.
* **Never aborts.** Every collectable section records ``{"error": "..."}``
  on failure instead of raising. The script exits 0 even when ES is
  unreachable; the report then carries ``"es_reachable": false`` and a
  ``"notes"`` array explaining what could not be collected.

Usage
-----
    python scripts/collect_es_fields.py --out docs/es-field-handover.json
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import json
import sys
from pathlib import Path
from typing import Any

# Allow running as ``python scripts/collect_es_fields.py`` from the repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from app.config import get_settings  # noqa: E402
from app.services.es_client import build_es_client  # noqa: E402
from app.services.es_fields import _resolve_mode  # noqa: E402

# ── Field sets the analyst cares about ──────────────────────────────────────

BASELINE_FIELDS = [
    "@timestamp",
    "url",
    "client_ip",
    "server_ip",
    "duration_seconds",
    "action",
]

EXTENDED_FIELDS = [
    "user_agent",
    "username",
    "session",
]

RICH_PROXY_FIELDS = [
    "domain",
    "base_url",
    "category",
    "http_method",
    "http_status_code",
    "country_code",
    "bytes_downloaded",
    "bytes_uploaded",
    "rule_info",
    "rule_name",
    "user_id",
]

ALL_TRACKED_FIELDS = BASELINE_FIELDS + EXTENDED_FIELDS + RICH_PROXY_FIELDS

# Cardinality hints: (label, field). One terms aggregation each, size 0.
CARDINALITY_FIELDS = ["client_ip", "base_url", "category", "http_method", "action"]

SAMPLE_SIZE = 3

WARNING_TEXT = (
    "This report contains VERBATIM Elasticsearch _source documents and may "
    "include sensitive data: full request URLs, client/server IP addresses, "
    "usernames, session identifiers, user agents and internal hostnames. "
    "REVIEW BEFORE SHARING. Nothing has been redacted by the collector."
)


def _err(exc: BaseException) -> dict[str, str]:
    """Normalise any exception into the ``{"error": ...}`` section shape."""
    return {"error": f"{type(exc).__name__}: {exc}"}


def _observed_type(field: str, caps: dict[str, Any]) -> str | None:
    """Return the observed ES type for a field from field_caps, if known."""
    entry = caps.get(field)
    if not isinstance(entry, dict):
        return None
    for _type, meta in entry.items():
        # Prefer a searchable type when several are reported.
        if isinstance(meta, dict) and meta.get("searchable"):
            return _type
    # Fall back to the first reported type.
    for _type in entry:
        return _type
    return None


def _present_in_caps(field: str, caps: dict[str, Any]) -> bool:
    return field in caps


def _leaf_fields(mapping: dict[str, Any]) -> list[str]:
    """Flatten an ES ``_mapping`` response into a sorted list of leaf paths."""
    props: dict[str, Any] = {}
    try:
        for index_body in mapping.values():
            if isinstance(index_body, dict) and "mappings" in index_body:
                props = index_body["mappings"].get("properties", {})
                break
    except Exception:
        return []

    leaves: list[str] = []

    def _walk(node: dict[str, Any], prefix: str) -> None:
        for name, spec in node.items():
            if not isinstance(spec, dict):
                continue
            path = f"{prefix}.{name}" if prefix else name
            sub = spec.get("properties")
            if sub:
                _walk(sub, path)
            else:
                leaves.append(path)

    _walk(props, "")
    return sorted(leaves)


async def _collect(args: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    index = settings.elastic_index

    report: dict[str, Any] = {
        "WARNING": WARNING_TEXT,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "collector": "scripts/collect_es_fields.py",
        "read_only": True,
        "es_reachable": False,
        "notes": [],
        "connection": {
            "host": settings.elastic_host,
            "index": index,
            "user": settings.elastic_user,
        },
        "es_version": None,
        "ping": {"ok": False},
    }

    client = build_es_client(settings, timeout=args.timeout)

    try:
        # 1. Ping / connection metadata ─────────────────────────────────────
        try:
            report["ping"]["ok"] = bool(await client.ping())
            if not report["ping"]["ok"]:
                report["ping"]["error"] = "ping returned False"
        except Exception as exc:  # noqa: BLE001
            report["ping"]["error"] = f"{type(exc).__name__}: {exc}"

        try:
            info = await client.info()
            report["es_version"] = info.get("version", {}).get("number")
            report["connection"]["cluster_name"] = info.get("cluster_name")
        except Exception as exc:  # noqa: BLE001
            report["es_version_error"] = f"{type(exc).__name__}: {exc}"

        reachable = report["ping"].get("ok", False) or report["es_version"] is not None
        report["es_reachable"] = bool(reachable)

        # 2. Index mapping ──────────────────────────────────────────────────
        mapping: dict[str, Any] = {}
        try:
            mapping = await client.indices.get_mapping(index=index)
            report["mapping"] = mapping
            report["mapping_leaf_fields"] = _leaf_fields(mapping)
        except Exception as exc:  # noqa: BLE001
            report["mapping"] = _err(exc)
            report["mapping_leaf_fields"] = []

        # 3. Field capabilities (authoritative "which fields exist") ────────
        caps: dict[str, Any] = {}
        try:
            caps_res = await client.field_caps(index=index, fields="*")
            caps = caps_res.get("fields", {}) if isinstance(caps_res, dict) else {}
            report["field_caps"] = caps
            report["field_caps_count"] = len(caps)
        except Exception as exc:  # noqa: BLE001
            report["field_caps"] = _err(exc)
            report["field_caps_count"] = 0

        # 4. Sample documents (verbatim _source, no redaction) ──────────────
        sample_sources: list[dict[str, Any]] = []
        try:
            sample_res = await client.search(
                index=index,
                body={
                    "size": SAMPLE_SIZE,
                    "query": {"match_all": {}},
                    "sort": [{"@timestamp": "desc"}],
                },
            )
            hits = sample_res.get("hits", {}).get("hits", [])
            for hit in hits:
                sample_sources.append(
                    {
                        "_index": hit.get("_index"),
                        "_id": hit.get("_id"),
                        "_source": hit.get("_source", {}),
                    }
                )
            report["sample"] = sample_sources
            report["sample_count"] = len(sample_sources)
        except Exception as exc:  # noqa: BLE001
            report["sample"] = _err(exc)
            report["sample_count"] = 0

        # Field-presence uses the union of all sampled docs.
        sample_keys: set[str] = set()
        for doc in sample_sources:
            src = doc.get("_source", {})
            if isinstance(src, dict):
                sample_keys.update(src.keys())

        # 5. Baseline / extended / rich field presence table ────────────────
        presence: dict[str, dict[str, Any]] = {}
        for field in ALL_TRACKED_FIELDS:
            presence[field] = {
                "present_in_sample": field in sample_keys,
                "present_in_field_caps": _present_in_caps(field, caps),
                "observed_type": _observed_type(field, caps),
            }
        report["field_presence"] = presence
        report["field_presence_groups"] = {
            "baseline": BASELINE_FIELDS,
            "extended": EXTENDED_FIELDS,
            "rich_proxy": RICH_PROXY_FIELDS,
        }

        # 6. Resolved mode — reuse the app resolver, never reimplement ──────
        first_source: dict[str, Any] = {}
        for doc in sample_sources:
            src = doc.get("_source", {})
            if isinstance(src, dict) and src:
                first_source = src
                break
        try:
            mode = _resolve_mode(first_source, caps, report["es_reachable"])
        except Exception as exc:  # noqa: BLE001
            mode = "UNKNOWN"
            report["mode_error"] = f"{type(exc).__name__}: {exc}"
        report["mode"] = mode
        report["mode_reason"] = _mode_reason(mode, presence)

        # 7. Aggregate cardinality hints (cheap; may fail on a big index) ───
        cardinality: dict[str, Any] = {}
        for field in CARDINALITY_FIELDS:
            try:
                agg_res = await client.search(
                    index=index,
                    body={
                        "size": 0,
                        "aggs": {"distinct": {"terms": {"field": field, "size": 0}}},
                    },
                )
                bucket = agg_res.get("aggregations", {}).get("distinct", {})
                cardinality[field] = {
                    "distinct_buckets": len(bucket.get("buckets", [])),
                    "doc_count_error_upper_bound": bucket.get(
                        "doc_count_error_upper_bound"
                    ),
                    "sum_other_doc_count": bucket.get("sum_other_doc_count"),
                }
            except Exception as exc:  # noqa: BLE001
                cardinality[field] = _err(exc)
        report["cardinality"] = cardinality

    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass

    # ── Notes: explain anything that could not be collected ─────────────
    notes: list[str] = report["notes"]
    if not report["es_reachable"]:
        notes.append(
            "Elasticsearch was UNREACHABLE (ping and version both failed). "
            "No mapping, field capabilities, sample documents or cardinality "
            "data could be collected. Verify ELASTIC_HOST and that the "
            "cluster is running, then re-run."
        )
    else:
        if isinstance(report.get("mapping"), dict) and "error" in report["mapping"]:
            notes.append(f"Index mapping not collected: {report['mapping']['error']}")
        if isinstance(report.get("field_caps"), dict) and "error" in report["field_caps"]:
            notes.append(f"Field capabilities not collected: {report['field_caps']['error']}")
        if isinstance(report.get("sample"), dict) and "error" in report["sample"]:
            notes.append(f"Sample documents not collected: {report['sample']['error']}")
        if report.get("es_version") is None:
            notes.append(
                "ES version not reported; the cluster may be a non-standard "
                "or proxy-fronted deployment."
            )
        sample_err = isinstance(report.get("sample"), dict) and "error" in report["sample"]
        if not sample_err and report.get("sample_count", 0) == 0:
            notes.append(
                "The index returned zero documents; field presence in the "
                "sample is uninformative — rely on field_caps."
            )
    missing_baseline = [
        f
        for f in BASELINE_FIELDS
        if not presence.get(f, {}).get("present_in_field_caps")
        and not presence.get(f, {}).get("present_in_sample")
    ]
    if missing_baseline:
        notes.append(
            "Baseline field(s) absent from both sample and field_caps: "
            + ", ".join(missing_baseline)
            + ". Mode cannot exceed UNKNOWN/COLLAPSED without them."
        )
    if isinstance(report.get("cardinality"), dict):
        failed_cards = [
            f for f, v in report["cardinality"].items() if isinstance(v, dict) and "error" in v
        ]
        if failed_cards:
            notes.append(
                "Cardinality aggregation failed for: " + ", ".join(failed_cards) + "."
            )

    return report


def _mode_reason(mode: str, presence: dict[str, dict[str, Any]]) -> str:
    """Human explanation of why the resolver returned this mode."""
    if mode == "UNKNOWN":
        return (
            "ES unreachable, or one/more of the six baseline fields "
            "(@timestamp, url, client_ip, server_ip, duration_seconds, "
            "action) could not be confirmed."
        )
    if mode == "UC-A":
        return (
            "Baseline present plus user_agent + username/session — durable "
            "identity grouping is available."
        )
    if mode == "UC-B":
        return (
            "Baseline present plus username/session but no user_agent — "
            "composite ua+client_ip grouping."
        )
    if mode == "COLLAPSED":
        return (
            "Only the six baseline fields are confirmed; no user_agent or "
            "username/session — client_ip-only grouping."
        )
    return "Unrecognised mode."


def _summarise(report: dict[str, Any], out_path: Path) -> str:
    caps = report.get("field_caps")
    fields_found = report.get("field_caps_count", 0)
    lines = [
        f"report written   : {out_path}",
        f"es_reachable     : {report.get('es_reachable')}",
        f"mode             : {report.get('mode')}",
        f"fields in caps   : {fields_found}",
        f"sample docs      : {report.get('sample_count', 0)}",
    ]
    if isinstance(caps, dict) and "error" in caps:
        lines.append(f"field_caps error : {caps['error']}")
    notes = report.get("notes") or []
    if notes:
        lines.append(f"notes            : {len(notes)} (see report)")
        for note in notes:
            lines.append(f"  - {note}")
    return "\n".join(lines)


async def _run(args: argparse.Namespace) -> int:
    try:
        report = await _collect(args)
    except Exception as exc:  # noqa: BLE001 — last-resort guard, still exit 0
        report = {
            "WARNING": WARNING_TEXT,
            "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "collector": "scripts/collect_es_fields.py",
            "read_only": True,
            "es_reachable": False,
            "mode": "UNKNOWN",
            "notes": [f"Collector crashed before completing: {type(exc).__name__}: {exc}"],
            "fatal_error": f"{type(exc).__name__}: {exc}",
        }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")

    print(_summarise(report, out_path))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only ES field collector for the uNetWatch handover.",
    )
    parser.add_argument(
        "--out",
        default="docs/es-field-handover.json",
        help="Output JSON path (default: docs/es-field-handover.json)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="Per-request ES timeout in seconds (default: 5)",
    )
    args = parser.parse_args(argv)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
