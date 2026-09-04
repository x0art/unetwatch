"""Monitor service — poll orchestrator and query runner.

This module is now a thin orchestrator that imports from focused deep modules:
- ``query_builder``: ES query DSL construction and pattern matching (pure functions)
- ``result_processor``: DataFrame filtering, aggregation, result building (pure functions)
- ``es_client``: ES client factory and lifecycle (I/O boundary)
- ``delivery``: Webhook and MS Teams delivery (I/O boundary)

All original function names are re-exported here for backward compatibility
so that existing imports in routes, tests, and scheduler continue to work.
"""

import json
import re
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import pandas as pd

from app.config import get_settings
from app.services.es_client import (  # noqa: F401
    build_es_client,
    is_es_online,
)

# ── Re-exports from deep modules (backward compatibility) ──────────────────
from app.services.query_builder import (  # noqa: F401
    build_all_query,
    build_logs_query,
    build_pattern_regex as _build_pattern_regex,
    escape_query_string as _escape_query_string,
    glob_to_regex as _glob_to_regex,
    whitelist_sql_clauses as _whitelist_sql_clauses,
)


@asynccontextmanager
async def _es_client_context(
    settings=None, *, timeout=5, retry_on_timeout=False, max_retries=0
):
    """Context manager that delegates to the (patchable) build_es_client."""
    client = build_es_client(
        settings,
        timeout=timeout,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
    )
    try:
        yield client
    finally:
        await client.close()
from app.services.delivery import (  # noqa: F401
    deliver_msteams,
    deliver_n8n,
    send_logs,
)
from app.services.result_processor import (  # noqa: F401
    apply_filters,
    store_findings,
)
from app.services.result_processor import (
    build_flow as _build_flow,
)
from app.services.result_processor import (
    build_items as _build_items,
)
from app.services.result_processor import (
    build_timeline as _build_timeline,
)


async def get_block_patterns(db) -> list[str]:
    cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type='block'"
    )
    rows = await cursor.fetchall()
    return [r[0] for r in rows]


async def get_whitelist_patterns(db) -> list[str]:
    cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type='whitelist'"
    )
    rows = await cursor.fetchall()
    return [r[0] for r in rows]


# ── In-process TTL cache ───────────────────────────────────────────────────

_query_cache: dict[str, tuple[float, dict]] = {}
_QUERY_TTL_S = 2.0


def _query_cache_key(
    minutes: int,
    search: str | None,
    exclude_whitelist: bool,
    exclude_blacklist: bool,
    block_patterns: list[str],
    whitelist_patterns: list[str],
    client_ip: str | None = None,
) -> str:
    """Stable cache key for a run_query invocation."""
    return "|".join(
        [
            str(minutes),
            search or "",
            str(exclude_whitelist),
            str(exclude_blacklist),
            client_ip or "",
            "|".join(block_patterns),
            "|".join(whitelist_patterns),
        ]
    )


def _invalidate_query_cache() -> None:
    """Clear the query cache (used by tests and after pattern edits)."""
    _query_cache.clear()


def _client_query_cache_key(
    ip: str,
    minutes: int,
    search: str | None,
    limit: int,
    block_patterns: list[str],
    whitelist_patterns: list[str],
) -> str:
    """Stable cache key for a run_client_query invocation."""
    return "|".join(
        [
            "client",
            ip,
            str(minutes),
            search or "",
            str(limit),
            "|".join(block_patterns),
            "|".join(whitelist_patterns),
        ]
    )


# ── Per-client query (drill-down radial) ───────────────────────────────────

async def run_client_query(
    ip: str,
    minutes: int = 60,
    search: str | None = None,
    limit: int = 12,
) -> dict:
    """Per-client URL breakdown aggregated from live ES (drill-down radial).

    Same response shape as the persisted-findings breakdown endpoint with
    ``source="es"``: the hub count plus per-URL counts. Whitelist exclusion
    mirrors ``run_query`` (``exclude_whitelist=True``, all actions kept).
    Elasticsearch failures degrade gracefully (``es_online: False``) — the
    endpoint never 500s. Identical duplicate ticks within the TTL reuse the
    cached payload instead of re-hitting ES.
    """
    settings = get_settings()

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
    finally:
        await db.close()

    result = {
        "client_ip": ip,
        "source": "es",
        "total_accesses": 0,
        "es_online": True,
        "urls": [],
    }

    cache_key = _client_query_cache_key(
        ip, minutes, search, limit, block_patterns, whitelist_patterns
    )
    hit = _query_cache.get(cache_key)
    if hit is not None and time.monotonic() - hit[0] < _QUERY_TTL_S:
        return dict(hit[1])

    try:
        if not block_patterns:
            return result

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(
            block_patterns,
            minutes,
            settings.es_query_size,
            search=search,
            client_ip=ip,
        )

        async with _es_client_context(settings, timeout=30) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception:
                result["es_online"] = False
                return result

        hits = res["hits"]["hits"]
        if not hits:
            return result

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=True,
            actions=None,
        )
        if df.empty:
            return result

        result["total_accesses"] = int(len(df))
        urls = df["url"].astype(str)
        base_by_url = df.assign(base_url=df["base_url"].astype(str)).groupby("url")[
            "base_url"
        ].first()
        last_by_url = (
            df.assign(ts=df["@timestamp"].astype(str)).groupby("url")["ts"].max()
        )
        counts = urls.value_counts().head(limit)
        result["urls"] = [
            {
                "url": u,
                "base_url": str(base_by_url.get(u, "") or ""),
                "count": int(c),
                "last_seen": str(last_by_url.get(u, "") or ""),
            }
            for u, c in counts.items()
        ]
    finally:
        _query_cache[cache_key] = (time.monotonic(), result)
    return result


# ── Query page runner ──────────────────────────────────────────────────────

async def run_query(
    minutes: int = 60,
    limit: int = 500,
    search: str | None = None,
    exclude_whitelist: bool = False,
    exclude_blacklist: bool = False,
    client_ip: str | None = None,
) -> dict:
    """Run the block-pattern ES query and return a rich payload for the Query page.

    ``search`` narrows the query *inside Elasticsearch* (URL/IP substring)
    instead of changing the time window; ``client_ip`` narrows to a single
    client via the ES ``term`` filter (Host Inspector); ``exclude_whitelist``
    drops whitelisted matches server-side so the whole result set (table,
    charts, flow, stats) shrinks; ``exclude_blacklist`` excludes rows whose
    destination host (``base_url``) is on the blacklist. Returns the matching
    documents (table), aggregates (stat cards + charts) and a
    client_ip → base_url flow.
    Elasticsearch failures degrade gracefully (``es_online: False``) and are
    recorded in ``monitor_logs``.
    """
    started = datetime.now(UTC)
    settings = get_settings()

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
        bl_cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
        bl_rows = await bl_cursor.fetchall()
    finally:
        await db.close()
    blacklist_urls = {r["value"] for r in bl_rows if r["kind"] == "url"}
    blacklist_ips = {r["value"] for r in bl_rows if r["kind"] == "ip"}

    cache_key = _query_cache_key(
        minutes,
        search,
        exclude_whitelist,
        exclude_blacklist,
        block_patterns,
        whitelist_patterns,
        client_ip,
    )
    hit = _query_cache.get(cache_key)
    if hit is not None and time.monotonic() - hit[0] < _QUERY_TTL_S:
        return dict(hit[1])

    result = {
        "window_minutes": minutes,
        "es_online": True,
        "query": None,
        "total_requests": 0,
        "unique_ips": 0,
        "distinct_urls": 0,
        "items": [],
        "top_urls": [],
        "top_ips": [],
        "timeline": [],
        "flow": {"nodes": [], "links": []},
    }
    log = _default_log("query", minutes)
    try:
        if not block_patterns:
            log["error"] = "No block patterns configured."
            return result

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(
            block_patterns,
            minutes,
            settings.es_query_size,
            search=search,
            client_ip=client_ip,
        )
        result["query"] = query
        log["es_query"] = query

        async with _es_client_context(settings, timeout=30) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception as e:
                result["es_online"] = False
                log["es_online"] = False
                log["error"] = str(e)
                return result

        hits = res["hits"]["hits"]
        log["matches"] = len(hits)
        if not hits:
            return result

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=exclude_whitelist,
            actions=None,
        )
        if exclude_blacklist and (blacklist_urls or blacklist_ips):
            blacklist_set = blacklist_urls | blacklist_ips
            df = df[~df["base_url"].astype(str).isin(blacklist_set)]
        log["filtered"] = len(df)
        if df.empty:
            return result

        log["top_urls"] = df["url"].astype(str).value_counts().head(10).index.tolist()
        urls = df["url"].astype(str).tolist()
        actual_patterns_q: list[str] = []
        for pat in block_patterns:
            regex = _glob_to_regex(pat)
            if regex and any(re.search(regex, u, re.IGNORECASE) for u in urls):
                actual_patterns_q.append(pat)
        log["matched_patterns"] = actual_patterns_q or list(block_patterns)

        result["total_requests"] = int(len(df))
        result["unique_ips"] = int(df["client_ip"].nunique())
        result["distinct_urls"] = int(df["url"].nunique())
        result["top_urls"] = [
            {"url": url, "count": int(count)}
            for url, count in df["url"].astype(str).value_counts().head(10).items()
        ]
        result["top_ips"] = [
            {"client_ip": ip, "count": int(count)}
            for ip, count in df["client_ip"].astype(str).value_counts().head(10).items()
        ]
        result["timeline"] = _build_timeline(df, minutes)
        result["flow"] = _build_flow(df)
        result["items"] = _build_items(
            df,
            limit,
            block_patterns=block_patterns,
            whitelist_regex=whitelist_regex,
            blacklist_urls=blacklist_urls,
            blacklist_ips=blacklist_ips,
        )
    except Exception as e:
        log["error"] = str(e)
        result["error"] = str(e)
        print(f"[{datetime.now(UTC).isoformat()}][WARN] Query run failed: {e}")
    finally:
        log["duration_ms"] = int((datetime.now(UTC) - started).total_seconds() * 1000)
        if (
            not log["error"]
            and log["webhook_status"] is None
            and not log["webhook_error"]
        ):
            log["webhook_reason"] = "Query runs don't trigger webhook delivery"
        from app.services.logs import write_log

        await write_log(log)
        _query_cache[cache_key] = (time.monotonic(), result)
    return result


async def run_all_query(
    minutes: int = 60,
    limit: int = 500,
    search: str | None = None,
    ip: str | None = None,
) -> dict:
    """Run an ES query over the WHOLE window — no block-pattern clause.

    Returns the same response shape as ``run_query`` (``items``, ``top_urls``,
    ``top_ips``, ``timeline``, ``flow``, ``total_requests``, ``unique_ips``,
    ``es_online``) so the Live Monitor can switch between the full proxy
    stream and flagged-only with a single toggle. ``ip`` narrows to a single
    client via a ``term`` filter. ``apply_filters`` keeps EVERY action
    (``actions=None``) and does NOT exclude whitelist matches — the full
    stream is exactly that. Blacklisted destinations (``base_url`` on the
    blacklist) are always excluded here; the Query page's include/exclude
    blacklist selector does not apply in this ``view_mode=all`` path.
    Elasticsearch failures degrade gracefully (``es_online: False``), never 5xx.
    """
    started = datetime.now(UTC)
    settings = get_settings()

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
        bl_cursor = await db.execute("SELECT kind, value FROM blacklist_entries")
        bl_rows = await bl_cursor.fetchall()
    finally:
        await db.close()
    blacklist_urls = {r["value"] for r in bl_rows if r["kind"] == "url"}
    blacklist_ips = {r["value"] for r in bl_rows if r["kind"] == "ip"}

    cache_key = "all|" + _query_cache_key(
        minutes,
        search,
        False,
        False,
        block_patterns,
        whitelist_patterns,
        ip,
    )
    hit = _query_cache.get(cache_key)
    if hit is not None and time.monotonic() - hit[0] < _QUERY_TTL_S:
        return dict(hit[1])

    result = {
        "window_minutes": minutes,
        "es_online": True,
        "query": None,
        "total_requests": 0,
        "unique_ips": 0,
        "distinct_urls": 0,
        "items": [],
        "top_urls": [],
        "top_ips": [],
        "timeline": [],
        "flow": {"nodes": [], "links": []},
    }
    log = _default_log("query", minutes)
    try:
        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_all_query(
            minutes, settings.es_query_size, search=search, ip=ip
        )
        result["query"] = query
        log["es_query"] = query

        async with _es_client_context(settings, timeout=30) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception as e:
                result["es_online"] = False
                log["es_online"] = False
                log["error"] = str(e)
                return result

        hits = res["hits"]["hits"]
        log["matches"] = len(hits)
        if not hits:
            return result

        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=False,
            actions=None,
        )
        if df.empty:
            return result

        if blacklist_urls or blacklist_ips:
            blacklist_set = blacklist_urls | blacklist_ips
            df = df[~df["base_url"].astype(str).isin(blacklist_set)]
        log["filtered"] = len(df)
        if df.empty:
            return result

        result["total_requests"] = int(len(df))
        result["unique_ips"] = int(df["client_ip"].nunique())
        result["distinct_urls"] = int(df["url"].nunique())
        result["top_urls"] = [
            {"url": url, "count": int(count)}
            for url, count in df["url"].astype(str).value_counts().head(10).items()
        ]
        result["top_ips"] = [
            {"client_ip": ip, "count": int(count)}
            for ip, count in df["client_ip"].astype(str).value_counts().head(10).items()
        ]
        result["timeline"] = _build_timeline(df, minutes)
        result["flow"] = _build_flow(df)
        result["items"] = _build_items(
            df,
            limit,
            block_patterns=[],
            whitelist_regex=whitelist_regex,
            blacklist_urls=blacklist_urls,
            blacklist_ips=blacklist_ips,
        )
    except Exception as e:
        log["error"] = str(e)
        result["error"] = str(e)
        print(f"[{datetime.now(UTC).isoformat()}][WARN] All-traffic query failed: {e}")
    finally:
        log["duration_ms"] = int((datetime.now(UTC) - started).total_seconds() * 1000)
        if (
            not log["error"]
            and log["webhook_status"] is None
            and not log["webhook_error"]
        ):
            log["webhook_reason"] = "Query runs don't trigger webhook delivery"
        from app.services.logs import write_log

        await write_log(log)
        _query_cache[cache_key] = (time.monotonic(), result)
    return result


# ── Startup: field-sample gate (best-effort, never crashes boot) ────────────

async def warm_field_inventory() -> None:
    """Fetch ES field inventory at startup (best-effort).

    Runs once per process. Logs on failure but never raises — the monitor
    must start even if ES is unreachable. The inventory is cached in
    es_fields._field_inventory for subsequent use by /api/es/fields and
    downstream consumers.
    """
    import logging

    from app.services.es_fields import fetch_field_inventory

    _log = logging.getLogger(__name__)
    try:
        await fetch_field_inventory()
    except Exception as e:
        _log.warning(f"[monitor] Field inventory warmup failed (non-fatal): {e}")


# ── Poll (scheduler entry point) ───────────────────────────────────────────

def _default_log(kind: str, minutes: int | None) -> dict:
    """Fresh log entry shared by poll and query run paths."""
    from app.services.logs import default_log

    return default_log(kind, minutes)


async def fetch_logs(minutes: int = 10):
    """Poll Elasticsearch for block-pattern matches and alert via webhook.

    Every run is recorded in ``monitor_logs`` — the exact ES query DSL,
    match counts, storage result and webhook delivery outcome — so the Logs
    page can audit what happened.
    """
    settings = get_settings()
    started = datetime.now(UTC)

    from app.database import get_db

    db = await get_db()
    log = _default_log("poll", minutes)
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)

        if not block_patterns:
            log["error"] = "No block patterns configured."
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] No block patterns configured."
            )
            return

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(block_patterns, minutes, settings.es_query_size)
        log["es_query"] = query

        async with _es_client_context(
            settings, timeout=180, retry_on_timeout=True, max_retries=3
        ) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception as e:
                log["es_online"] = False
                log["error"] = str(e)
                print(f"Error: {e}")
                return

        hits = res["hits"]["hits"]
        log["matches"] = len(hits)

        if not hits:
            log["webhook_reason"] = "No matches in window — nothing to send"
            print(f"[{datetime.now(UTC).isoformat()}][INFO] No matches found.")
            return

        df = apply_filters(pd.DataFrame([h["_source"] for h in hits]), whitelist_regex)
        log["filtered"] = len(df)

        if not df.empty:
            log["top_urls"] = df["url"].astype(str).value_counts().head(10).index.tolist()
            urls = df["url"].astype(str).tolist()
            actual_patterns: list[str] = []
            for pat in block_patterns:
                regex = _glob_to_regex(pat)
                if regex and any(re.search(regex, u, re.IGNORECASE) for u in urls):
                    actual_patterns.append(pat)
            log["matched_patterns"] = actual_patterns or list(block_patterns)

        if df.empty:
            log["webhook_reason"] = (
                f"{len(hits)} matches, all excluded by whitelist/ALLOW filter — "
                "nothing to send"
            )
            print(f"[{datetime.now(UTC).isoformat()}][INFO] No filtered matches.")
            return

        required_columns = [
            "@timestamp", "client_ip", "server_ip", "url",
            "duration_seconds", "action",
        ]
        df_filtered = df[required_columns]
        model_groupby_ip = (
            df.groupby("client_ip")[["url", "base_url"]].agg(list).reset_index()
        )
        model_groupby_ip["base_url"] = (
            model_groupby_ip["base_url"].apply(set).apply(list)
        )
        result = model_groupby_ip.apply(
            lambda row: {
                "client_ip": row["client_ip"],
                "url": row["url"],
                "base_url": row["base_url"],
            },
            axis=1,
        ).tolist()

        total_sum = len(df_filtered)
        documents_len = len(model_groupby_ip)

        payload = {
            "summary": {
                "total_matches": total_sum,
                "timestamp_utc": datetime.now(UTC).isoformat(),
            },
            "total_documents": documents_len,
            "documents": result,
        }

        # Persist locally before webhook delivery
        try:
            matched_pats = log.get("matched_patterns", block_patterns)
            log["stored"] = await store_findings(db, df, matched_pats)
        except Exception as e:
            log["error"] = f"Failed to store findings: {e}"
            print(f"[{datetime.now(UTC).isoformat()}][WARN] Failed to store findings: {e}")

        # Store payload for retry before sending
        try:
            log["webhook_payload"] = json.dumps(payload, default=str)
        except (TypeError, ValueError):
            pass

        # ── n8n webhook delivery ─────────────────────────────────────
        await deliver_n8n(log, payload, total_sum)

        # ── MS Teams Workflows delivery ──────────────────────────────
        matched_pats = log.get("matched_patterns", block_patterns)
        await deliver_msteams(log, result, matched_pats, block_patterns)

    except Exception as e:
        log["error"] = str(e)
        print(f"Error: {e}")
    finally:
        log["duration_ms"] = int((datetime.now(UTC) - started).total_seconds() * 1000)
        from app.services.logs import write_log

        await write_log(log)
        await db.close()


# ── Dashboard metrics ──────────────────────────────────────────────────────

async def fetch_metrics(minutes: int = 60) -> dict:
    """Aggregate flagged URL traffic from ES for the dashboard metrics charts.

    Applies the same block-pattern + whitelist + ALLOW filter as fetch_logs().
    Elasticsearch being unreachable (or returning unexpected documents) degrades
    gracefully — the endpoint never 500s.
    """
    settings = get_settings()

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
    finally:
        await db.close()

    result = {
        "window_minutes": minutes,
        "es_online": True,
        "total_requests": 0,
        "unique_ips": 0,
        "top_urls": [],
        "top_ips": [],
    }

    if not block_patterns:
        return result

    whitelist_regex = _build_pattern_regex(whitelist_patterns)
    query = build_logs_query(block_patterns, minutes, settings.es_query_size)

    async with _es_client_context(settings, timeout=15) as es:
        try:
            res = await es.search(index=settings.elastic_index, body=query)
        except Exception:
            result["es_online"] = False
            return result

    try:
        hits = res["hits"]["hits"]
        if not hits:
            return result

        df = apply_filters(pd.DataFrame([h["_source"] for h in hits]), whitelist_regex)
        if df.empty:
            return result

        result["total_requests"] = int(len(df))
        result["unique_ips"] = int(df["client_ip"].nunique())
        top_urls = df["url"].astype(str).value_counts().head(10)
        top_ips = df["client_ip"].astype(str).value_counts().head(10)
        result["top_urls"] = [
            {"url": url, "count": int(count)} for url, count in top_urls.items()
        ]
        result["top_ips"] = [
            {"client_ip": ip, "count": int(count)} for ip, count in top_ips.items()
        ]
    except Exception as e:
        print(f"[{datetime.now(UTC).isoformat()}][WARN] Metrics aggregation failed: {e}")
    return result
