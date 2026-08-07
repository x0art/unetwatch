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
    assert "(url:*1.2.3.4* OR client_ip:*1.2.3.4* OR server_ip:*1.2.3.4*)" in search_qs
    assert "(url:*bad.example* OR client_ip:*bad.example* OR server_ip:*bad.example*)" in search_qs

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
    assert search_qs.count("(url:*tok") == 20
    assert "(url:*tok39*" not in search_qs


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


def test_apply_filters_no_whitelist_keeps_all_allow():
    out = apply_filters(_df(), "")
    assert list(out["url"]) == [
        "http://evil.example/a",
        "http://safe-porn-ads.example/b",
    ]
