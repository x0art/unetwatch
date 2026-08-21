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
) -> dict:
    """ES query that flags URLs matching any block pattern within the window.

    ``search`` (optional) narrows the result set *at the ES level*: every
    whitespace-separated token must appear as a substring of the URL, client
    IP or server IP. Tokens are escaped so the operator can never break out
    of the query_string grammar. ``client_ip`` (optional) narrows to a single
    client via a ``term`` filter — used by the drill-down radial.
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
    filters: list[dict] = [
        {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
    ]
    if client_ip:
        filters.append({"term": {"client_ip": client_ip}})
    return {
        "size": size,
        "query": {"bool": {"filter": filters, "must": must}},
    }
