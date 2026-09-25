"""Monitor pattern handling: glob→regex safety and ES query escaping.

Patterns are globs (``*``/``?`` wildcards), not regexes. These tests pin the
conversions so a user-supplied pattern can never crash ``re.compile`` and
take down a poll or the metrics endpoint.
"""

import re

import pandas as pd

from app.services.monitor import (
    _build_pattern_regex,
    _escape_query_string,
    _glob_to_regex,
    apply_filters,
    build_logs_query,
)

# ── glob → regex conversion ────────────────────────────────────────────────


def test_glob_to_regex_literal():
    assert _glob_to_regex("googleapis") == "googleapis"
    # Domain dots must match literally.
    assert _glob_to_regex("google.com") == r"google\.com"


def test_glob_to_regex_wildcards():
    assert _glob_to_regex("*porn*") == ".*porn.*"
    assert _glob_to_regex("film?") == "film."
    assert _glob_to_regex("*") == ".*"


def test_glob_to_regex_specials_are_literal():
    # These would raise re.error if joined raw; after conversion they compile.
    for nasty in ("foo(bar)+?", "*porn*", "a+b", "(x", ")*", "foo?bar*"):
        re.compile(_glob_to_regex(nasty), re.IGNORECASE)


def test_build_pattern_regex_never_raises():
    nasty = ["*porn*", "a+b", "(x", "foo?bar*", ")*", "", "||"]
    compiled = re.compile(_build_pattern_regex(nasty), re.IGNORECASE)
    assert compiled.search("xx-porn-movies-xx")
    assert compiled.search("fooqbarzz")  # foo?bar* -> foo.bar.*
    assert compiled.search("||")
    assert not compiled.search("plaintext")


def test_build_pattern_regex_skips_empty():
    assert _build_pattern_regex(["", "  "]) == ""


# ── ES query_string escaping ───────────────────────────────────────────────


def test_escape_query_string_keeps_wildcards():
    assert _escape_query_string("*porn*") == "*porn*"
    assert _escape_query_string("IDLIX21") == "IDLIX21"


def test_escape_query_string_escapes_lucene_specials():
    assert _escape_query_string("bad+site") == "bad\\+site"
    assert _escape_query_string("-a") == "\\-a"
    assert _escape_query_string("(a)") == "\\(a\\)"
    assert _escape_query_string("a b") == "a\\ b"


def test_escape_query_string_neutralizes_operators():
    # && / || must never survive as Lucene operators.
    assert _escape_query_string("a&&b") == "a\\&\\&b"
    assert _escape_query_string("a||b") == "a\\|\\|b"


def test_escape_query_string_full_url():
    out = _escape_query_string("http://bad.example/x")
    assert out == "http\\:\\/\\/bad.example\\/x"


def test_build_logs_query_escapes_block_patterns():
    q = build_logs_query(["*porn*", "bad+site", "http://x/"], 10, 50)
    bool_q = q["query"]["bool"]
    qs_clauses = [
        f["query_string"]["query"] for f in bool_q["filter"] if "query_string" in f
    ]
    assert len(qs_clauses) == 1
    qs = qs_clauses[0]
    assert "*porn*" in qs  # wildcard preserved
    assert "bad\\+site" in qs  # operator escaped
    assert "http\\:\\/\\/x\\/" in qs  # field delimiters escaped
    assert bool_q["filter"][0]["range"]["@timestamp"]["gte"] == "now-10m"
    assert q["size"] == 50

def test_build_logs_query_all_time_omits_range_filter():
    """minutes=0 is the all-time sentinel — no @timestamp range filter."""
    from app.services.query_builder import build_client_session_query

    q = build_logs_query(["*porn*"], 0, 50)
    filters = q["query"]["bool"]["filter"]
    assert not any("range" in f for f in filters)

    session = build_client_session_query("1.2.3.4", 0, 50)
    s_filters = session["query"]["bool"]["filter"]
    assert not any("range" in f for f in s_filters)
    assert {"term": {"client_ip": "1.2.3.4"}} in s_filters


def test_build_logs_query_narrows_matches_when_search_given():
    q = build_logs_query(["*porn*"], 10, 50, search=" 1.2.3.4   bad.example ")
    must = q["query"]["bool"]["must"]
    # Tokenized, whitespace-collapsed, and escaped — must never break grammar.
    # must holds ONLY the search clause; the block-pattern clause is a filter.
    assert len(must) == 1
    search_qs = must[0]["query_string"]["query"]
    assert "(url.keyword:*1.2.3.4* OR client_ip.keyword:*1.2.3.4* OR server_ip.keyword:*1.2.3.4*)" in search_qs
    assert "(url.keyword:*bad.example* OR client_ip.keyword:*bad.example* OR server_ip.keyword:*bad.example*)" in search_qs

    # No search term → must is empty (ES accepts "must": []).
    plain = build_logs_query(["*porn*"], 10, 50)
    assert len(plain["query"]["bool"]["must"]) == 0


def test_build_logs_query_caps_search_tokens():
    # 20 tokens max — 60 wildcard clauses stay far below ES's max_clause_count.
    long_search = " ".join(f"tok{i}" for i in range(40))
    q = build_logs_query(["*porn*"], 10, 50, search=long_search)
    must = q["query"]["bool"]["must"]
    assert len(must) == 1
    search_qs = must[0]["query_string"]["query"]
    # Exactly 20 ANDed clauses; token 20+ dropped.
    assert search_qs.count("(url.keyword:*tok") == 20
    assert "(url.keyword:*tok39*" not in search_qs


# ── apply_filters resilience ───────────────────────────────────────────────


def _df():
    return pd.DataFrame(
        [
            {
                "url": "http://evil.example/a",
                "client_ip": "1.1.1.1",
                "action": "ALLOW",
                "@timestamp": "2026-01-01T00:00:00Z",
            },
            {
                "url": "http://safe-porn-ads.example/b",
                "client_ip": "1.1.1.1",
                "action": "ALLOW",
                "@timestamp": "2026-01-01T00:00:00Z",
            },
            {
                "url": "http://blocked.example/c",
                "client_ip": "1.1.1.1",
                "action": "BLOCK",
                "@timestamp": "2026-01-01T00:00:00Z",
            },
        ]
    )


def test_apply_filters_handles_nasty_whitelist_patterns():
    regex = _build_pattern_regex(["*porn*", "safe+ads", "(x"])
    out = apply_filters(_df(), regex)
    # Whitelist match (*porn*) dropped; BLOCK dropped; ALLOW kept.
    assert list(out["url"]) == ["http://evil.example/a"]


def test_apply_filters_vectorized_base_url_matches_old_semantics():
    # The vectorized `.str.split("/").str[2]` path must match the old
    # per-row `_extract_base_url` semantics exactly, including the len < 3
    # guard (no-slash URLs keep the url as base_url).
    df = pd.DataFrame(
        [
            {"url": "http://host.example/path/x", "action": "ALLOW",
             "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "http://host.example", "action": "ALLOW",
             "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "bare.example/path", "action": "ALLOW",
             "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "no-slash-at-all", "action": "ALLOW",
             "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "", "action": "ALLOW", "@timestamp": "2026-01-01T00:00:00Z"},
        ]
    )
    out = apply_filters(df, "", actions=None)
    assert list(out["base_url"]) == [
        "host.example",  # scheme://host → parts[2]
        "host.example",  # scheme://host without path
        "bare.example/path",  # no scheme → fewer than 3 parts → the url
        "no-slash-at-all",  # len < 3 guard → the url
        "",
    ]


def test_apply_filters_vectorized_still_excludes_whitelisted():
    # Exercises the vectorized base_url path while pinning whitelist
    # exclusion + ALLOW filtering end to end.
    df = pd.DataFrame(
        [
            {"url": "http://evil.example/a", "client_ip": "1.1.1.1",
             "action": "ALLOW", "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "http://safe-porn-ads.example/b", "client_ip": "1.1.1.1",
             "action": "ALLOW", "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "no-slash.example", "client_ip": "1.1.1.1",
             "action": "BLOCK", "@timestamp": "2026-01-01T00:00:00Z"},
        ]
    )
    regex = _build_pattern_regex(["*porn*"])
    out = apply_filters(df, regex)
    assert list(out["url"]) == ["http://evil.example/a"]
    assert list(out["base_url"]) == ["evil.example"]


def test_apply_filters_actions_param():
    df = pd.DataFrame(
        [
            {"url": "http://allow.example/a", "action": "ALLOW",
             "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "http://deny.example/b", "action": "DENY",
             "@timestamp": "2026-01-01T00:00:00Z"},
        ]
    )
    # Default keeps the old ALLOW-only behavior.
    out = apply_filters(df, "")
    assert out["action"].tolist() == ["ALLOW"]
    # actions=None keeps every row.
    out_all = apply_filters(df, "", actions=None)
    assert out_all["action"].tolist() == ["ALLOW", "DENY"]
    # A specific action filters to that action.
    out_deny = apply_filters(df, "", actions=("DENY",))
    assert out_deny["action"].tolist() == ["DENY"]


# ── build_client_session_query (filter-only, no query_string) ────────────────


def test_build_all_query_searches_domain_and_base_url():
    """Non-pattern traffic is visible: per-token clause also hits domain/base_url."""
    from app.services.query_builder import build_all_query

    q = build_all_query(60, 500, search="evil.example")
    must = q["query"]["bool"]["must"]
    assert len(must) == 2  # range clause + search clause
    search_qs = must[1]["query_string"]["query"]
    assert (
        "(url.keyword:*evil.example* OR domain.keyword:*evil.example*"
        " OR base_url.keyword:*evil.example*"
        " OR client_ip.keyword:*evil.example* OR server_ip.keyword:*evil.example*)"
    ) in search_qs

    # No search term → range clause only (flagged path untouched elsewhere).
    plain = build_all_query(60, 500)
    assert len(plain["query"]["bool"]["must"]) == 1
    # Server-side bound: ES times out before the 120s client timeout.
    assert q["timeout"] == "60s"
    assert q["track_total_hits"] is False


def test_build_logs_query_is_scoring_free_and_bounded():
    """Block-pattern clause is a filter (same docs, no scores); ES is bounded."""
    from app.services.query_builder import QUERY_SOURCE_FIELDS

    q = build_logs_query(["*porn*"], 10, 50, search="evil.example")
    bool_q = q["query"]["bool"]
    # Pattern query_string lives in filter (after the range clause).
    assert bool_q["filter"][0]["range"]["@timestamp"]["gte"] == "now-10m"
    assert "*porn*" in bool_q["filter"][1]["query_string"]["query"]
    # must contains no block-pattern clause — only the search clause.
    assert len(bool_q["must"]) == 1
    assert "evil.example" in bool_q["must"][0]["query_string"]["query"]
    # Bounded: ES-side timeout + no exact hit counting.
    assert q["timeout"] == "60s"
    assert q["track_total_hits"] is False
    # Projection plumbing passes the requested fields through.
    assert set(QUERY_SOURCE_FIELDS) >= {"url", "client_ip", "@timestamp"}


def test_build_logs_query_projects_source_fields():
    q = build_logs_query(["*porn*"], 10, 50, fields=["url"])
    assert q["_source"] == ["url"]


def test_build_client_session_query_shape():
    from app.services.query_builder import build_client_session_query

    q = build_client_session_query("10.0.0.1", 60, 200)

    # Size and sort
    assert q["size"] == 200
    assert q["sort"] == [{"@timestamp": {"order": "asc"}}]

    # Filter-only: range + term on client_ip, no query_string
    bool_q = q["query"]["bool"]
    assert "must" not in bool_q or bool_q.get("must") == []
    filters = bool_q["filter"]
    assert len(filters) == 2
    assert filters[0] == {"range": {"@timestamp": {"gte": "now-60m", "lte": "now"}}}
    assert filters[1] == {"term": {"client_ip": "10.0.0.1"}}


# ── URL-OR-DOMAIN block-pattern match (2026-09-25) ─────────────────────────
# A block pattern used to match the `url` field only, so a flagged destination
# reached through many paths contributed only the paths whose full URL happened
# to contain the pattern text. The match is now URL-OR-DOMAIN (the domain being
# the scheme/port-stripped authority persisted as `base_url`), with the `url`
# arm kept verbatim so nothing that matched before is lost. These pin the
# behaviour through the two public surfaces: the ES clause and the pandas
# annotation `build_items` writes into `blocked_by`.


def test_block_pattern_matches_the_domain_not_only_the_url():
    """A domain-only match is flagged, and shows up in ``blocked_by``."""
    from app.services.result_processor import build_items

    # No URL contains "indoxxi" — only the destination domain does.
    df = pd.DataFrame(
        [
            {
                "url": "https://cdn.example/a",
                "base_url": "indoxxi.foo",
                "client_ip": "10.0.0.1",
                "action": "ALLOW",
                "@timestamp": "2026-09-25T10:00:00Z",
            }
        ]
    )
    items = build_items(
        df,
        50,
        block_patterns=["*indoxxi*"],
        whitelist_regex="",
        blacklist_urls=set(),
        blacklist_ips=set(),
    )
    assert items[0]["blocked_by"] == ["*indoxxi*"]


def test_block_pattern_still_matches_the_url():
    """No regression: a URL match is still flagged."""
    from app.services.result_processor import build_items

    df = pd.DataFrame(
        [
            {
                "url": "https://mirror.example/indoxxi/watch",
                "base_url": "mirror.example",
                "client_ip": "10.0.0.1",
                "action": "ALLOW",
                "@timestamp": "2026-09-25T10:00:00Z",
            }
        ]
    )
    items = build_items(
        df,
        50,
        block_patterns=["*indoxxi*"],
        whitelist_regex="",
        blacklist_urls=set(),
        blacklist_ips=set(),
    )
    assert items[0]["blocked_by"] == ["*indoxxi*"]


def test_block_pattern_domain_match_is_glob_and_case_insensitive():
    """Glob semantics apply to the domain exactly as to the URL."""
    from app.services.query_builder import build_pattern_match_predicate

    predicate = build_pattern_match_predicate(["*indoxxi*"])
    # Case-insensitive, and `*` is a wildcard on the domain.
    assert predicate({"url": "https://x.example/p", "base_url": "WWW.Indoxxi.Foo"})
    # An unrelated domain does NOT match.
    assert not predicate(
        {"url": "https://other.example/x", "base_url": "other.example"}
    )
    # `?` matches exactly one character — "in?oxxi.com" matches "indoxxi.com"
    # but not the same name with the "d" dropped.
    one_char = build_pattern_match_predicate(["in?oxxi.com"])
    assert one_char({"url": "https://x/y", "base_url": "indoxxi.com"})
    assert not one_char({"url": "https://x/y", "base_url": "inoxxi.com"})
    # Everything but `*`/`?` is literal: the `.` in a domain pattern is a dot,
    # not "any character", so "a.example" does not match "axexample".
    literal_dot = build_pattern_match_predicate(["a.example"])
    assert literal_dot({"url": "https://x/y", "base_url": "sub.a.example"})
    assert not literal_dot({"url": "https://x/y", "base_url": "axexample"})


def test_build_logs_query_clause_matches_url_or_base_url():
    """The ES clause names both fields, at the same filter position as before."""
    q = build_logs_query(["*indoxxi*"], 10, 50)
    filters = q["query"]["bool"]["filter"]
    # Same shape: one query_string filter, after the range clause.
    assert filters[0]["range"]["@timestamp"]["gte"] == "now-10m"
    assert (
        filters[1]["query_string"]["query"]
        == "(url : *indoxxi* OR base_url : *indoxxi*)"
    )
    assert filters[1]["query_string"]["analyze_wildcard"] is True


def test_extract_domain_whitespace_base_url_falls_back_to_url():
    """A whitespace-ONLY `base_url` must NOT win over the url authority.

    WHY this pins a real disagreement, not a cosmetic one: `base_url` is read
    first and a bare ``"   "`` is TRUTHY, so an unstripped ``or`` would make the
    row's domain whitespace instead of ``indoxxi.foo``. The ES clause matches
    the row on ``url OR base_url``, so the Python side must resolve the SAME
    domain or the two express different rules for one row — the exact drift the
    one-expression design exists to prevent. A non-blank `base_url` still wins,
    so this only closes the blank hole.
    """
    from app.services.result_processor import extract_domain

    # Whitespace-only base_url → the url's authority answers.
    assert (
        extract_domain({"url": "https://indoxxi.foo/a", "base_url": "   "})
        == "indoxxi.foo"
    )
    # Genuinely empty/None behaves as before (unchanged legacy fallback).
    assert (
        extract_domain({"url": "https://indoxxi.foo/a", "base_url": ""})
        == "indoxxi.foo"
    )
    assert extract_domain({"url": "https://indoxxi.foo/a"}) == "indoxxi.foo"
    # A non-blank base_url still wins over the url.
    assert (
        extract_domain(
            {"url": "https://cdn.example/a", "base_url": "indoxxi.foo"}
        )
        == "indoxxi.foo"
    )


def test_block_pattern_clause_skips_blank_patterns():
    """A blank pattern contributes NO clause term — it must not be emit-able.

    WHY: `glob_to_regex('   ')` returns ``''`` and
    `build_pattern_match_predicate` SKIPS the blank pattern, so if the ES clause
    escaped-and-emitted a degenerate ``(url : \\ \\ \\  OR base_url : \\ \\ \\ )``
    term the two surfaces would express different rules for the same input.
    Non-blank patterns are untouched, and the shape per surviving pattern is
    unchanged, so callers that pin the clause keep passing.
    """
    from app.services.query_builder import build_block_pattern_clause

    assert build_block_pattern_clause(["   "]) == ""
    assert build_block_pattern_clause(["   ", "\t", ""]) == ""
    # A blank alongside a real pattern contributes nothing, and the real
    # pattern keeps its exact ``(url : <p> OR base_url : <p>)`` shape.
    assert (
        build_block_pattern_clause(["   ", "*indoxxi*"])
        == "(url : *indoxxi* OR base_url : *indoxxi*)"
    )
    assert (
        build_block_pattern_clause(["*porn*", "\t", "*nonton*"])
        == "(url : *porn* OR base_url : *porn*)"
        " OR (url : *nonton* OR base_url : *nonton*)"
    )
