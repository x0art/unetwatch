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


# Columns read by apply_filters / build_items / _build_timeline / _build_flow,
# plus `host`/`message` which the ATT&CK aggregate reads for proxy-node
# provenance and raw-line recovery (spec §j.7). Projecting _source to these
# fields keeps long-window fetches small; extra fields are harmless — every
# consumer reads named columns only, so a field none of them touch is simply
# ignored.
QUERY_SOURCE_FIELDS = [
    "url", "client_ip", "server_ip", "@timestamp", "action",
    "duration_seconds", "domain", "base_url", "category", "http_method",
    "http_status_code", "country_code", "bytes_downloaded", "bytes_uploaded",
    "rule_info", "rule_name", "user_id", "matched_patterns", "user_agent",
    "host", "message",
]


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


# ── Block-pattern clause: URL OR domain (canonical) ────────────────────────
#
# The block-pattern clause is built ONCE, here, and shared by the ES clause
# (`build_logs_query`) and the pandas annotation
# (`result_processor.build_items`) so the two can never express different
# rules. A pattern is glob-matched against the row's URL **or** its
# destination domain — the scheme/port-stripped authority persisted as
# `base_url` — because URL-only matching under-counts a destination reached
# through many paths (`https://x.example/a`, `/b`, `/c`…). The `url` arm is
# kept verbatim so every row that matched before still matches; the widening
# only ADDS rows. `base_url` is a keyword field in the proxy mapping (the
# `build_all_query` search clause already targets `base_url.keyword`), so the
# domain arm is itself a wildcard query_string term, not an aggregation.


def build_block_pattern_clause(block_patterns: list[str]) -> str:
    """The Lucene ``url OR base_url`` query_string for one block-pattern set.

    ONE expression of the block-pattern rule: each pattern becomes
    ``(url : <p> OR base_url : <p>)`` and the per-pattern clauses are ORed.
    ``build_logs_query`` inlines this as the pattern filter;
    `build_pattern_match_predicate` expresses the identical predicate in Python
    for the pandas side.

    A blank pattern (``p.strip() == ""``) is SKIPPED, not escaped-and-emitted:
    `glob_to_regex` returns ``""`` for it and `build_pattern_match_predicate`
    skips it, so emitting a degenerate ``(url : \\ \\ \\  OR base_url : \\ \\ \\ )``
    term here would make the ES clause and the Python predicate express
    different rules for the same input. Every surviving pattern keeps the
    exact per-pattern shape, so the clause shape is unchanged.
    """
    return " OR ".join(
        f"(url : {escape_query_string(p)} OR base_url : {escape_query_string(p)})"
        for p in block_patterns
        if p.strip()
    )


def build_pattern_match_predicate(block_patterns: list[str]):
    """The SAME block-pattern rule as `build_block_pattern_clause`, for dict rows.

    Returns ``predicate(row) -> bool``: a pattern matches a row when it matches
    the row's ``url`` OR its destination domain. The domain is derived with
    ``result_processor.extract_domain`` — the one home for how a row's domain
    is computed — so the ES clause and this predicate cannot drift. This is the
    per-row twin of `build_block_pattern_clause`: the ES query decides WHICH
    rows come back, this decides how MANY (``app/routes/hosts.py`` sizes the ES
    ``size`` cap from the widened frame without a second round-trip).
    """
    from app.services.result_processor import extract_domain, pattern_match_series

    def predicate(row: dict) -> bool:
        domain = extract_domain(row)
        url = str(row.get("url") or "")
        for pattern in block_patterns:
            if not pattern.strip():
                continue
            regex = glob_to_regex(pattern)
            if not regex:
                continue
            if re.search(regex, url, re.IGNORECASE):
                return True
            if re.search(regex, domain, re.IGNORECASE):
                return True
        return False

    return predicate


def build_logs_query(
    block_patterns: list[str],
    minutes: int,
    size: int,
    search: str | None = None,
    client_ip: str | None = None,
    fields: list[str] | None = None,
    actions: list[str] | None = None,
) -> dict:
    """ES query that flags URLs OR domains matching any block pattern.

    ``search`` (optional) narrows the result set *at the ES level*: every
    whitespace-separated token must appear as a substring of the URL, client
    IP or server IP. Tokens are escaped so the operator can never break out
    of the query_string grammar. ``client_ip`` (optional) narrows to a single
    client via a ``term`` filter — used by the drill-down radial.
    ``fields`` (optional) limits ``_source`` to only the listed fields for
    projection — only requested fields are fetched from ES.

    ``actions`` (optional) turns this into an ACTION query: a ``terms``
    filter on ``action`` is appended and the block-pattern clause is OMITTED
    entirely. The two are mutually exclusive by construction, because they
    answer different questions about different row populations. A REACH
    ("did this host get through?") is a block-pattern match; an ENFORCEMENT
    ("did the proxy deny this host?") is an ``action`` the proxy recorded —
    and the proxy records a DENY against the destination it refused, which
    need not be the URL a block pattern names. Asking for enforcements with
    the pattern clause present therefore under-counts to zero on ordinary
    traffic (see ``_aggregate_host`` in ``app/routes/hosts.py``).

    ``actions is None`` (the default) keeps the same SHAPE as before (pattern
    clause present, no action filter); only the clause TEXT widened. The
    pattern now matches the row's ``url`` **or** its destination domain
    (``base_url``), because URL-only matching under-counts a flagged
    destination reached through many sibling paths — the domain is the durable
    identity the operator reasons about (see `build_block_pattern_clause`).
    The ``url`` arm is unchanged, so a row that matched before still matches.
    Callers that pass ``actions`` receive a query with NO pattern restriction.
    """
    # Scoring-free: the block-pattern clause is a filter (same doc set, no
    # scores). Only the optional user search stays in must (possibly empty —
    # ES accepts "must": []).
    must: list[dict] = []
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
    # Order: range first, then the pattern-or-action clause, then client_ip.
    if minutes > 0:
        filters.append(
            {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
        )
    if actions is not None:
        # Action query: the pattern clause is deliberately absent so DENY rows
        # recorded against a non-pattern URL are still returned. This is the
        # one branch where the pattern clause must NOT be appended.
        filters.append({"terms": {"action": list(actions)}})
    else:
        # URL OR domain, built once in `build_block_pattern_clause` so this
        # clause and the pandas annotation in `result_processor` share ONE
        # expression of the rule.
        query_string = build_block_pattern_clause(block_patterns)
        filters.append(
            {"query_string": {"query": query_string, "analyze_wildcard": True}}
        )
    if client_ip:
        filters.append({"term": {"client_ip": client_ip}})
    result: dict = {
        "size": size,
        "query": {"bool": {"filter": filters, "must": must}},
        "timeout": "60s",
        "track_total_hits": False,
    }
    if fields is not None:
        result["_source"] = fields
    return result


def build_all_query(
    minutes: int,
    size: int,
    search: str | None = None,
    ip: str | None = None,
    fields: list[str] | None = None,
) -> dict:
    """ES query over the whole window with NO block-pattern clause.

    Range (+ optional substring search) only — returns ALL traffic so the
    Live Monitor can show the full proxy stream, not just flagged matches.
    ``minutes <= 0`` is the all-time sentinel (no range clause). ``ip``
    narrows to a single client via a ``term`` filter. ``fields`` optionally
    projects ``_source`` to the listed names. Every whitespace-separated
    search token must appear as a substring of the URL, domain, base_url,
    client IP or server IP.
    """
    must: list[dict] = []
    filters: list[dict] = []
    if minutes > 0:
        must.append(
            {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
        )
    terms = [t for t in re.split(r"\s+", (search or "").strip()) if t][:20]
    if terms:
        clauses = [
            "("
            "url.keyword:*{t}* OR domain.keyword:*{t}* OR base_url.keyword:*{t}*"
            " OR client_ip.keyword:*{t}* OR server_ip.keyword:*{t}*"
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
    if ip:
        filters.append({"term": {"client_ip": ip}})
    body: dict = {
        "query": {"bool": {"must": must, "filter": filters}},
        "size": size,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "timeout": "60s",
        "track_total_hits": False,
    }
    if fields is not None:
        body["_source"] = fields
    return body


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
