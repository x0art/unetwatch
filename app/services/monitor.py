import math
import re
import time
from datetime import UTC, datetime
from numbers import Integral, Real

import pandas as pd
from elasticsearch import AsyncElasticsearch

from app.config import get_settings
from app.services.logs import default_log, write_log


def build_es_client(
    settings,
    *,
    timeout: float = 5,
    retry_on_timeout: bool = False,
    max_retries: int = 0,
) -> AsyncElasticsearch:
    """Shared Elasticsearch client factory (short timeouts by default)."""
    return AsyncElasticsearch(
        [settings.elastic_host],
        basic_auth=(settings.elastic_user, settings.elastic_pass),
        verify_certs=False,
        request_timeout=timeout,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
    )


async def is_es_online() -> bool:
    """True when Elasticsearch answers a ping within a short timeout."""
    settings = get_settings()
    es = build_es_client(settings)
    try:
        return await es.ping()
    except Exception:
        return False
    finally:
        await es.close()


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


# Lucene query_string characters that must be backslash-escaped when a pattern
# is inlined as a term. `*` and `?` are intentionally left untouched so
# patterns keep acting as wildcards; `&` and `|` are escaped too so a pattern
# can never smuggle in a Lucene `&&`/`||` operator.
_QUERY_STRING_SPECIAL = re.compile(r"([+\-!(){}[\]^\"~:\\/&| ])")


def _glob_to_regex(pattern: str) -> str:
    """Convert a wildcard pattern (``*``/``?``) into a safe literal-match regex.

    Patterns are globs, not regexes: ``*`` matches any run of characters,
    ``?`` matches any single character, and everything else is matched
    literally. This mirrors the substring semantics the Findings graph uses
    for whitelist patterns, and guarantees a user-supplied pattern can never
    produce an invalid regex (``re.error``) that would crash a poll or a
    metrics run.
    """
    pattern = pattern.strip()
    if not pattern:
        return ""
    return re.escape(pattern).replace(r"\*", ".*").replace(r"\?", ".")


def _build_pattern_regex(patterns: list[str]) -> str:
    """Join wildcard patterns into a single alternation regex.

    Case-insensitivity is applied by the caller (``case=False`` on
    ``str.contains`` / ``re.IGNORECASE``), not baked into the regex.
    """
    return "|".join(p for p in map(_glob_to_regex, patterns) if p)


def _whitelist_sql_clauses(patterns: list[str]) -> list[str]:
    """SQL ``NOT LIKE`` exclusion clauses for whitelist glob patterns.

    Patterns composed only of literals plus the ``*``/``?`` wildcards
    translate 1:1 to SQL LIKE: ``*`` → ``%``, ``?`` → ``_``, and literal
    underscores are escaped (LIKE's ``_`` is a single-char wildcard; in a
    glob it is literal). Patterns containing anything else (regex meta
    characters, whitespace, ``%``) are not SQL-expressible and are left to
    the pure-Python ``re.search`` fallback — returning ``[]`` (or fewer
    clauses) makes the caller keep the Python pass for those rows.
    """
    clauses = []
    for pattern in map(str.strip, patterns):
        if not pattern:
            continue
        # Only literals + * / ? are expressible. `-` inside a class is
        # escaped for clarity; the charset deliberately excludes `+`, `(`,
        # `[`, whitespace, etc. so those patterns take the Python path.
        if not re.fullmatch(r"[A-Za-z0-9./:_\-]*[\*?][A-Za-z0-9./:_\-]*", pattern):
            continue
        like = pattern.replace("_", r"\_").replace("?", "_").replace("*", "%")
        clause = f"(url NOT LIKE '{like}' ESCAPE '\\' AND base_url NOT LIKE '{like}' ESCAPE '\\')"
        clauses.append(clause)
    return clauses


def _escape_query_string(term: str) -> str:
    """Escape Lucene query_string special chars in a pattern term.

    ``*`` and ``?`` are preserved so patterns keep acting as wildcards; all
    other Lucene operators and delimiters (``:``, ``/``, ``+``, ``-``, quotes,
    brackets, whitespace...) are escaped so an arbitrary pattern cannot break
    the query or silently change its meaning.
    """
    return _QUERY_STRING_SPECIAL.sub(r"\\\1", term) if term else term


def build_logs_query(
    block_patterns: list[str], minutes: int, size: int, search: str | None = None
) -> dict:
    """ES query that flags URLs matching any block pattern within the window.

    ``search`` (optional) narrows the result set *at the ES level*: every
    whitespace-separated token must appear as a substring of the URL, client
    IP or server IP. Tokens are escaped so the operator can never break out
    of the query_string grammar.
    """
    query_string = " OR ".join(
        f"url : {_escape_query_string(p)}" for p in block_patterns
    )
    must: list[dict] = [
        {"query_string": {"query": query_string, "analyze_wildcard": True}}
    ]
    terms = [t for t in re.split(r"\s+", search.strip()) if t] if search else []
    # Cap the number of ANDed wildcard clauses: each token becomes three
    # leading-wildcard subqueries (url/client_ip/server_ip), which are
    # scan-heavy on large indexes. 20 tokens = 60 wildcard clauses, far
    # below ES's default max_clause_count (1024).
    terms = terms[:20]
    if terms:
        clauses = [
            "("
            "url:*{t}* OR client_ip:*{t}* OR server_ip:*{t}*"
            ")".format(t=_escape_query_string(term))
            for term in terms
        ]
        must.append(
            {
                "query_string": {
                    "query": " AND ".join(clauses),
                    "analyze_wildcard": True,
                }
            }
        )
    return {
        "size": size,
        "query": {
            "bool": {
                "filter": [
                    {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
                ],
                "must": must,
            }
        },
    }


def _normalize_timestamp(ts, fallback: str) -> str:
    """Return a usable ISO-8601 timestamp for a finding.

    The ES ``@timestamp`` is the source of truth; ``fallback`` (the poll
    time) is only used when the document has no usable value. Handles ISO
    strings, datetime/pandas Timestamp objects, numeric epoch values
    (seconds/milliseconds) and missing markers (None, NaN, NaT, empty
    string) so a log entry can never be stored with a blank or "NaT" time.
    """
    if ts is None:
        return fallback
    if isinstance(ts, str):
        ts = ts.strip()
        return ts or fallback
    try:
        if bool(pd.isna(ts)):
            return fallback
    except (TypeError, ValueError):
        pass
    # numbers.Integral/Real also catch numpy scalar types (np.int64, np.float64).
    if isinstance(ts, (Integral, Real)):
        try:
            if not math.isfinite(float(ts)):
                return fallback
            if ts > 1e12:  # epoch milliseconds
                return datetime.fromtimestamp(ts / 1000, UTC).isoformat()
            if ts > 1e9:  # epoch seconds
                return datetime.fromtimestamp(ts, UTC).isoformat()
        except (TypeError, ValueError, OverflowError):
            return fallback
    if isinstance(ts, datetime):
        return ts.isoformat()
    rendered = str(ts).strip()
    return rendered or fallback


def _safe_number(value) -> float | None:
    """Coerce a pandas/ES value to a float, or None when it is missing/NaN."""
    if value is None:
        return None
    try:
        if bool(pd.isna(value)):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def apply_filters(
    df: pd.DataFrame,
    whitelist_regex: str,
    *,
    exclude_whitelist: bool = True,
    actions: tuple[str, ...] | None = ("ALLOW",),
) -> pd.DataFrame:
    """Apply whitelist + action filters and derive base_url.

    Missing columns are tolerated (filled with empty strings) so a single odd
    document can never crash a whole poll. ``exclude_whitelist=False`` keeps
    whitelisted matches so the Query page can badge them in the UI instead of
    silently dropping them. ``actions`` restricts to the given actions
    (default ALLOW-only, which the findings/webhook flow relies on); pass
    ``actions=None`` to keep every row regardless of action.
    """
    df = df.copy()
    for col in ("url", "client_ip", "action", "@timestamp"):
        if col not in df.columns:
            df[col] = ""
    # Vectorized base_url extraction — equivalent to the old per-row
    # ``parts = url.split("/"); parts[2] if len(parts) >= 3 else url``
    # (a split with no limit keeps the host in position 2; URLs without a
    # third segment — no scheme, bare host, empty — fall back to the url).
    urls = df["url"].astype(str)
    df["base_url"] = urls.str.split("/").str[2].fillna(urls)
    if whitelist_regex and exclude_whitelist:
        df = df[~df["url"].astype(str).str.contains(whitelist_regex, case=False)]
    if actions is not None:
        df = df[df["action"].isin(actions)]
    return df


async def store_findings(db, df: pd.DataFrame) -> int:
    """Persist filtered matches so they surface in the Findings page.

    Uses INSERT OR IGNORE + a UNIQUE(client_ip, url, log_timestamp) constraint so
    overlapping poll windows never create duplicate rows. Returns the number of
    rows actually inserted.
    """
    rows = []
    now = datetime.now(UTC).isoformat()
    # Guard the one column apply_filters doesn't guarantee (server_ip may be
    # absent from a doc's _source), then iterate as tuples — much cheaper
    # than df.iterrows() for large batches.
    if "server_ip" not in df.columns:
        df["server_ip"] = ""
    cols = ["client_ip", "server_ip", "url", "base_url", "@timestamp"]
    for r in df[cols].itertuples(index=False, name=None):
        rows.append(
            (
                str(r[0] or ""),
                str(r[1] or ""),
                str(r[2] or ""),
                str(r[3] or ""),
                _normalize_timestamp(r[4], now),
            )
        )
    if not rows:
        return 0
    cursor = await db.executemany(
        "INSERT OR IGNORE INTO findings"
        " (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    await db.commit()
    return int(cursor.rowcount or 0)


async def fetch_logs(minutes: int = 10):
    """Poll Elasticsearch for block-pattern matches and alert via webhook.

    Every run is recorded in ``monitor_logs`` — the exact ES query DSL,
    match counts, storage result and webhook delivery outcome — so the Logs
    page can audit what happened.
    """
    settings = get_settings()
    started = datetime.now(UTC)
    es = build_es_client(
        settings, timeout=180, retry_on_timeout=True, max_retries=3
    )

    from app.database import get_db

    db = await get_db()
    log = default_log("poll", minutes)
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

        # Surface what this run actually flagged — top matched URLs and the
        # block patterns they hit (stored so the Logs page can show them).
        if not df.empty:
            log["top_urls"] = df["url"].astype(str).value_counts().head(10).index.tolist()
            log["matched_patterns"] = list(block_patterns)

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

        # Persist locally before webhook delivery; storage failures must never
        # break alert delivery, so this is best-effort.
        try:
            log["stored"] = await store_findings(db, df)
        except Exception as e:
            log["error"] = f"Failed to store findings: {e}"
            print(f"[{datetime.now(UTC).isoformat()}][WARN] Failed to store findings: {e}")

        if not settings.webhook_url:
            log["webhook_reason"] = "Webhook URL not configured — nothing sent"
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] "
                "Webhook URL not configured, skipping delivery."
            )
        else:
            try:
                log["webhook_status"] = await send_logs(
                    settings.webhook_url, total_sum, payload
                )
            except Exception as e:
                log["webhook_error"] = str(e)
                print(f"[{datetime.now(UTC).isoformat()}][WARN] Webhook failed: {e}")

    except Exception as e:
        log["error"] = str(e)
        print(f"Error: {e}")
    finally:
        log["duration_ms"] = int((datetime.now(UTC) - started).total_seconds() * 1000)
        await write_log(log)
        await es.close()
        await db.close()


def _build_timeline(df: pd.DataFrame, minutes: int) -> list[dict]:
    """Bucket matching docs into a continuous minute-granularity timeline.

    Bucket width is scaled to the window so long windows (e.g. 24h) still
    render a reasonable number of points (~48 max).
    """
    ts = pd.to_datetime(df["@timestamp"], errors="coerce", utc=True).dropna()
    if ts.empty:
        return []
    span = max(1, minutes // 48)
    binned = ts.dt.floor(f"{span}min")
    counts = binned.value_counts().sort_index()
    if counts.empty:
        return []
    full = pd.date_range(counts.index.min(), counts.index.max(), freq=f"{span}min")
    counts = counts.reindex(full, fill_value=0)
    return [
        {"bucket": idx.isoformat(), "count": int(c)} for idx, c in counts.items()
    ]


def _build_flow(df: pd.DataFrame) -> dict:
    """Collapse docs into a client_ip → base_url flow for visualization."""
    grouped = (
        df.groupby(["client_ip", "base_url"]).size().reset_index(name="count")
    )
    nodes: list[dict] = []
    for ip in grouped["client_ip"].unique():
        nodes.append({"id": f"ip:{ip}", "label": str(ip), "kind": "ip"})
    for base in grouped["base_url"].unique():
        nodes.append({"id": f"base:{base}", "label": str(base), "kind": "base"})
    links = [
        {
            "source": f"ip:{row.client_ip}",
            "target": f"base:{row.base_url}",
            "count": int(row.count),
        }
        for row in grouped.itertuples()
    ]
    return {"nodes": nodes, "links": links}


def _build_items(
    df: pd.DataFrame,
    limit: int,
    *,
    block_patterns: list[str],
    whitelist_regex: str,
    blacklist_urls: set[str],
    blacklist_ips: set[str],
) -> list[dict]:
    """Rows for the Query page table (capped to ``limit``).

    Each row is annotated for the UI badges: which block pattern(s) matched
    (``blocked_by``), whether the URL matches a whitelist pattern
    (``whitelisted``), and whether its host, base IP or client IP is already
    on the blacklist (``blacklisted`` / ``blacklist_source``).
    """
    now = datetime.now(UTC).isoformat()
    whitelist_matcher = (
        re.compile(whitelist_regex, re.IGNORECASE) if whitelist_regex else None
    )

    df = df.head(limit)
    records = df.to_dict("records")
    # Vectorized block-pattern annotation: one regex pass per pattern across
    # the whole batch instead of a per-row re.search per pattern. Indices are
    # positional (reset_index) so they line up with the records list.
    url_series = df["url"].astype(str).reset_index(drop=True)
    block_hits: list[list[str]] = [[] for _ in range(len(records))]
    for pattern in block_patterns:
        if not pattern.strip():
            continue
        matched = url_series.str.contains(
            _glob_to_regex(pattern), regex=True, case=False, na=False
        )
        for i in matched[matched].index:
            block_hits[i].append(pattern)

    items: list[dict] = []
    for i, row in enumerate(records):
        url = str(row.get("url") or "")
        base_url = str(row.get("base_url") or "")
        client_ip = str(row.get("client_ip") or "")

        blocked_by = block_hits[i]
        whitelisted = bool(whitelist_matcher and whitelist_matcher.search(url))

        # A base_url can itself be an IP address, so it must be matched
        # against the IP list too — otherwise IP-based entries never get
        # the blacklist badge even when the address is on the blacklist.
        blacklisted = base_url in blacklist_urls or base_url in blacklist_ips
        blacklist_source = (
            "url" if base_url in blacklist_urls
            else "ip" if base_url in blacklist_ips
            else None
        )
        if not blacklisted and client_ip in blacklist_ips:
            blacklisted = True
            blacklist_source = "ip"

        items.append(
            {
                "timestamp": _normalize_timestamp(row.get("@timestamp"), now),
                "client_ip": client_ip,
                "server_ip": str(row.get("server_ip") or ""),
                "url": url,
                "base_url": base_url,
                "duration_seconds": _safe_number(row.get("duration_seconds")),
                "action": str(row.get("action") or ""),
                "blocked_by": blocked_by,
                "whitelisted": whitelisted,
                "blacklisted": blacklisted,
                "blacklist_source": blacklist_source,
            }
        )
    return items


# In-process TTL cache for run_query: identical duplicate ticks (same window,
# filters and pattern sets) within the TTL return the cached payload instead of
# re-hitting Elasticsearch. The short TTL only collapses *identical* duplicates
# — distinct auto-refresh ticks still see fresh data.
_query_cache: dict[str, tuple[float, dict]] = {}
_QUERY_TTL_S = 2.0


def _query_cache_key(
    minutes: int,
    search: str | None,
    exclude_whitelist: bool,
    exclude_blacklist: bool,
    block_patterns: list[str],
    whitelist_patterns: list[str],
) -> str:
    """Stable cache key for a run_query invocation."""
    return "|".join(
        [
            str(minutes),
            search or "",
            str(exclude_whitelist),
            str(exclude_blacklist),
            "|".join(block_patterns),
            "|".join(whitelist_patterns),
        ]
    )


def _invalidate_query_cache() -> None:
    """Clear the query cache (used by tests and after pattern edits)."""
    _query_cache.clear()


async def run_query(
    minutes: int = 60,
    limit: int = 500,
    search: str | None = None,
    exclude_whitelist: bool = False,
    exclude_blacklist: bool = False,
) -> dict:
    """Run the block-pattern ES query and return a rich payload for the Query page.

    ``search`` narrows the query *inside Elasticsearch* (URL/IP substring)
    instead of changing the time window; ``exclude_whitelist`` drops
    whitelisted matches server-side so the whole result set (table, charts,
    flow, stats) shrinks. Returns the matching documents (table), aggregates
    (stat cards + charts) and a client_ip → base_url flow. Elasticsearch
    failures degrade gracefully (``es_online: False``) and are recorded in
    ``monitor_logs``.
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

    # Serve an identical in-flight/duplicate tick from cache within the TTL.
    cache_key = _query_cache_key(
        minutes,
        search,
        exclude_whitelist,
        exclude_blacklist,
        block_patterns,
        whitelist_patterns,
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
    log = default_log("query", minutes)
    try:
        if not block_patterns:
            log["error"] = "No block patterns configured."
            return result

        whitelist_regex = _build_pattern_regex(whitelist_patterns)
        query = build_logs_query(
            block_patterns, minutes, settings.es_query_size, search=search
        )
        result["query"] = query
        log["es_query"] = query

        es = build_es_client(settings, timeout=30)
        try:
            res = await es.search(index=settings.elastic_index, body=query)
        except Exception as e:
            result["es_online"] = False
            log["es_online"] = False
            log["error"] = str(e)
            return result
        finally:
            await es.close()

        hits = res["hits"]["hits"]
        log["matches"] = len(hits)
        if not hits:
            return result

        # By default raw matches are returned (whitelisted docs badged in the
        # UI); the user can opt into excluding them so fewer rows come back.
        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=exclude_whitelist,
            actions=None,
        )
        if exclude_blacklist and (blacklist_urls or blacklist_ips):
            # A base_url can itself be an IP, so exclude entries found in
            # either list as well as client IPs on the IP blacklist.
            blacklist_set = blacklist_urls | blacklist_ips
            df = df[
                ~df["base_url"].astype(str).isin(blacklist_set)
                & ~df["client_ip"].astype(str).isin(blacklist_ips)
            ]
        log["filtered"] = len(df)
        if df.empty:
            return result

        log["top_urls"] = df["url"].astype(str).value_counts().head(10).index.tolist()
        log["matched_patterns"] = list(block_patterns)

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
        # Only label the delivery skip when the run actually completed —
        # a failed run (log["error"]) wasn't "skipped", it never got there.
        if (
            not log["error"]
            and log["webhook_status"] is None
            and not log["webhook_error"]
        ):
            log["webhook_reason"] = "Query runs don't trigger webhook delivery"
        await write_log(log)
        # Cache every completed run (success or degraded) so a duplicate tick
        # within the TTL reuses it instead of re-querying ES.
        _query_cache[cache_key] = (time.monotonic(), result)
    return result


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

    es = build_es_client(settings, timeout=15)
    whitelist_regex = _build_pattern_regex(whitelist_patterns)
    query = build_logs_query(block_patterns, minutes, settings.es_query_size)

    try:
        res = await es.search(index=settings.elastic_index, body=query)
    except Exception:
        result["es_online"] = False
        return result
    finally:
        await es.close()

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


async def send_logs(webhook_url: str, n_item: int, payload: dict) -> int:
    """Deliver the alert payload to the webhook; returns the HTTP status."""
    import aiohttp

    async with aiohttp.ClientSession() as session:
        async with session.post(webhook_url, json=payload, timeout=15) as response:
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] Found {n_item} rows."
            )
            result_msg = (
                "Success on"
                if response.status == 200
                else f"Error {response.status} while"
            )
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] "
                f"{result_msg} sending."
            )
            return response.status
