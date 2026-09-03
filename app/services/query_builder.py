"""Elasticsearch query DSL construction and pattern matching utilities.

Pure functions with zero I/O — fully testable in isolation. Extracted from
``monitor.py`` to create a deep module with clear locality: when a search
query bug recurs, you look here, not in the 1000-line orchestrator.
"""

import re

# Lucene query_string characters that must be backslash-escaped when a pattern
# is inlined as a term. `*` and `?` are intentionally left untouched so
# patterns keep acting as wildcards; `&` and `|` are escaped too so a pattern
# can never smuggle in a Lucene `&&`/`||` operator.
_QUERY_STRING_SPECIAL = re.compile(r"([+\-!(){}[\]^\"~:\\\/&| ])")


def glob_to_regex(pattern: str) -> str:
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


def build_pattern_regex(patterns: list[str]) -> str:
    """Join wildcard patterns into a single alternation regex.

    Case-insensitivity is applied by the caller (``case=False`` on
    ``str.contains`` / ``re.IGNORECASE``), not baked into the regex.
    """
    return "|".join(p for p in map(glob_to_regex, patterns) if p)


def whitelist_sql_clauses(patterns: list[str]) -> list[str]:
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


def escape_query_string(term: str) -> str:
    """Escape Lucene query_string special chars in a pattern term.

    ``*`` and ``?`` are preserved so patterns keep acting as wildcards; all
    other Lucene operators and delimiters (``:``, ``/``, ``+``, ``-``, quotes,
    brackets, whitespace...) are escaped so an arbitrary pattern cannot break
    the query or silently change its meaning.
    """
    return _QUERY_STRING_SPECIAL.sub(r"\\\1", term) if term else term


def build_logs_query(
    block_patterns: list[str],
    minutes: int,
    size: int,
    search: str | None = None,
    client_ip: str | None = None,
    fields: list[str] | None = None,
) -> dict:
    """ES query that flags URLs matching any block pattern within the window.

    ``search`` (optional) narrows the result set *at the ES level*: every
    whitespace-separated token must appear as a substring of the URL, client
    IP or server IP. Tokens are escaped so the operator can never break out
    of the query_string grammar. ``client_ip`` (optional) narrows to a single
    client via a ``term`` filter — used by the drill-down radial.
    ``fields`` (optional) limits ``_source`` to only the listed fields for
    projection — only requested fields are fetched from ES.
    """
    query_string = " OR ".join(
        f"url : {escape_query_string(p)}" for p in block_patterns
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
            "url.keyword:*{t}* OR client_ip.keyword:*{t}* OR server_ip.keyword:*{t}*"
            ")".format(t=escape_query_string(term))
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
    filters: list[dict] = []
    # minutes <= 0 is the "all time" sentinel — no time range filter at all.
    if minutes > 0:
        filters.append(
            {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
        )
    if client_ip:
        filters.append({"term": {"client_ip": client_ip}})
    result: dict = {
        "size": size,
        "query": {"bool": {"filter": filters, "must": must}},
    }
    if fields is not None:
        result["_source"] = fields
    return result


def build_client_session_query(client: str, minutes: int, size: int) -> dict:
    """ES query for all requests from one client in a time window.

    Filter-only: term filter on client_ip without the block-pattern query_string
    used by build_logs_query. Sorted @timestamp ascending for session timeline.
    """
    session_filters: list[dict] = []
    if minutes > 0:
        session_filters.append(
            {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
        )
    session_filters.append({"term": {"client_ip": client}})
    return {
        "size": size,
        "sort": [{"@timestamp": {"order": "asc"}}],
        "query": {"bool": {"filter": session_filters}},
    }


# ── Task 12: UI-filter → ES _search body (spec §5.1 query pipeline) ────────


def time_range_to_es(time_range: str) -> str | None:
    """Translate a UI time-range label to an ES ``now-*`` offset.

    Accepts ``"24h"`` / ``"7d"`` / ``"30d"`` (and any ``<n>h``/``<n>d``/``<n>m``
    label) and returns ``"now-1d"`` / ``"now-7d"`` / ``"now-30d"``. Returns
    ``None`` for empty / ``"all"`` (the all-time sentinel) and ``"24h"``-style
    labels that don't parse, so callers can skip the range clause entirely.
    """
    label = (time_range or "").strip().lower()
    if not label or label == "all":
        return None
    if re.fullmatch(r"\d+[hdm]", label):
        return f"now-{label}"
    if label in {"24h", "1d"}:
        return "now-1d"
    return None


class QueryBuilder:
    """Translate UI filter state into an ES ``_search`` body (spec §5.1).

    Consumes the FilterContext state ``{globalSearch, timeRange, action,
    hostFilter, patternFilter, size}`` plus the Kibana ``FieldMap`` so custom
    index schemas configured in System Settings are honoured everywhere.
    """

    @staticmethod
    def build(filters: dict, field_map: "FieldMap") -> dict:  # noqa: F821
        """Build an ES ``_search`` body from UI filter state.

        ``filters`` keys: ``globalSearch`` (multi_match over src/dest/url/
        domain), ``timeRange`` (``"24h"``/``"7d"``/``"30d"`` → ``now-*``
        range), ``action`` (uppercase ALLOW/DENY/FLAG, ``"All"``/empty skips),
        ``hostFilter``/``patternFilter`` (KQL-style clauses), ``size`` (default
        50). Results sort newest-first by the mapped timestamp field.
        """
        must: list[dict] = []
        if filters.get("globalSearch"):
            q = filters["globalSearch"]
            must.append(
                {
                    "multi_match": {
                        "query": q,
                        "fields": [
                            field_map.src_ip,
                            field_map.dest_ip,
                            field_map.url,
                            field_map.domain,
                        ],
                    }
                }
            )
        if filters.get("timeRange"):
            es_offset = time_range_to_es(filters["timeRange"])
            if es_offset:
                must.append(
                    {"range": {field_map.timestamp: {"gte": es_offset}}}
                )
        if filters.get("action") and filters["action"] != "All":
            # The configured logstash-proxy index stores `action` as UPPERCASE
            # (ALLOW/DENY/FLAG); a lowercase term would match nothing. Keep the
            # filter value verbatim (UI already sends uppercase).
            must.append({"term": {field_map.action: filters["action"]}})
        for key in ("hostFilter", "patternFilter"):
            value = filters.get(key)
            if not value:
                continue
            clauses = QueryBuilder.kql_to_dsl(str(value), field_map)
            must.extend(clauses)
        return {
            "query": {"bool": {"must": must}},
            "size": int(filters.get("size", 50) or 50),
            "sort": [{field_map.timestamp: "desc"}],
        }

    @staticmethod
    def kql_to_dsl(kql: str, field_map: "FieldMap") -> list[dict]:  # noqa: F821
        """Translate a minimal KQL expression into ES DSL ``must`` clauses.

        Minimal safe translation: ``field: value`` pairs map to ``term``
        clauses on the mapped field (dotted paths are kept verbatim — ES
        handles nested fields), ``AND`` joins are preserved as sibling
        ``must`` clauses, and bare text becomes a ``multi_match`` across the
        same four search fields as ``globalSearch``. Anything unparseable
        (operators other than ``AND``/``OR``, unbalanced quotes) is treated
        as bare text rather than raised — a search box can never 500.

        Example: ``url.full: *streaming* AND event.action: deny`` →
        ``[{term: {url.full: "*streaming*"}}, {term: {event.action: "deny"}}]``
        """
        clauses: list[dict] = []
        text = (kql or "").strip()
        if not text:
            return clauses
        # Split on AND (uppercase, with optional surrounding spaces).
        tokens = [t.strip() for t in re.split(r"\s+AND\s+", text, flags=re.IGNORECASE)]
        for token in tokens:
            if not token:
                continue
            match = re.match(r"^([A-Za-z0-9_.@-]+)\s*:\s*(.+)$", token)
            if match:
                field, value = match.group(1), match.group(2).strip()
                clauses.append({"term": {field: value}})
            else:
                clauses.append(
                    {
                        "multi_match": {
                            "query": token,
                            "fields": [
                                field_map.src_ip,
                                field_map.dest_ip,
                                field_map.url,
                                field_map.domain,
                            ],
                        }
                    }
                )
        return clauses
