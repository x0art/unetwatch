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
    qs = q["query"]["bool"]["must"][0]["query_string"]["query"]
    assert "*porn*" in qs  # wildcard preserved
    assert "bad\\+site" in qs  # operator escaped
    assert "http\\:\\/\\/x\\/" in qs  # field delimiters escaped
    assert q["query"]["bool"]["filter"][0]["range"]["@timestamp"]["gte"] == "now-10m"
    assert q["size"] == 50


def test_build_logs_query_narrows_matches_when_search_given():
    q = build_logs_query(["*porn*"], 10, 50, search=" 1.2.3.4   bad.example ")
    must = q["query"]["bool"]["must"]
    # Tokenized, whitespace-collapsed, and escaped — must never break grammar.
    assert len(must) == 2  # block-pattern clause + search clause
    search_qs = must[1]["query_string"]["query"]
    assert "(url.keyword:*1.2.3.4* OR client_ip.keyword:*1.2.3.4* OR server_ip.keyword:*1.2.3.4*)" in search_qs
    assert "(url.keyword:*bad.example* OR client_ip.keyword:*bad.example* OR server_ip.keyword:*bad.example*)" in search_qs

    # No search term → only the block-pattern clause.
    plain = build_logs_query(["*porn*"], 10, 50)
    assert len(plain["query"]["bool"]["must"]) == 1


def test_build_logs_query_caps_search_tokens():
    # 20 tokens max — 60 wildcard clauses stay far below ES's max_clause_count.
    long_search = " ".join(f"tok{i}" for i in range(40))
    q = build_logs_query(["*porn*"], 10, 50, search=long_search)
    must = q["query"]["bool"]["must"]
    assert len(must) == 2
    search_qs = must[1]["query_string"]["query"]
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
