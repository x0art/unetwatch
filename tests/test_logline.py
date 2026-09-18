"""Unit tests for app/services/logline.py — the raw-line recovery parser.

Pins the grammar contract from docs/attck-mapping-spec.md §j.7: the
operator's verbatim line parses slot-by-slot, a ``-`` response-size slot is a
NOT-RECORDED sentinel (never a measured zero — §j.5), quoted fields stay
whole, and a malformed line degrades to a failure state instead of raising.
"""

from app.services.logline import parse_line, parse_rule_codes

# Verbatim operator line (spec §j.0/§j.7): the response-size slot is `-`
# (logstash collapsed it to bytes_downloaded: 0) and the category slot is `-`
# (the flat category carries the SNI from the quotes).
_VERBATIM = (
    "[01/Sep/2026:06:59:11 +0700] 172.21.122.6 172.21.122.6 57.144.192.3 "
    '"facebook.com" 0.01 - https://z-m-gateway.facebook.com/ - 0 215 DENY '
    'RN190,SNI,BS BE "facebook.com"'
)


def test_verbatim_line_parses_slot_by_slot():
    r = parse_line(_VERBATIM)
    assert r.ok and r.error is None
    assert r.local_timestamp == "01/Sep/2026:06:59:11"
    assert r.tz_offset == "+0700"
    assert r.client_ip == "172.21.122.6"
    assert r.user_id == "172.21.122.6"
    assert r.server_ip == "57.144.192.3"
    assert r.sni_host == "facebook.com"
    assert r.duration_seconds == 0.01
    assert r.url == "https://z-m-gateway.facebook.com/"
    assert r.http_status == 0  # no upstream response on DENY, not a 404
    assert r.request_size == 215
    assert r.action == "DENY"
    assert r.rule_codes == ["RN190", "SNI", "BS"]
    assert r.country_code == "BE"
    assert r.sni_echo == "facebook.com"


def test_unrecorded_response_size_is_sentinel_not_zero():
    """Parse-only: a `-` slot is NOT-RECORDED, never a measured 0 (§j.5)."""
    r = parse_line(_VERBATIM)
    assert r.response_size is None
    assert r.response_size_recorded is False


def test_flat_collapsed_sentinel_keeps_recorded_false():
    """With flats, the value field reads the flat (0) but the parse's
    sentinel stays in response_size_recorded — a collapsed zero can never
    pass for a measured one (§j.5).
    """

    r = parse_line(_VERBATIM, flats={"bytes_downloaded": 0})
    assert r.response_size == 0
    assert r.response_size_recorded is False


def test_flat_values_win_when_present():
    """Flats are the authoritative value fields where they exist; the
    recorded flag still tracks the LINE's slot, not the flat's presence.
    """
    # The verbatim line's size slot is `-`: the flat wins the value, the
    # parse's sentinel stays in response_size_recorded (§j.5).
    r = parse_line(_VERBATIM, flats={
        "bytes_downloaded": 512,
        "duration_seconds": 0.02,
        "http_status_code": 200,
        "bytes_uploaded": 300,
        "category": "facebook.com",
    })
    assert r.response_size == 512
    assert r.response_size_recorded is False
    assert r.duration_seconds == 0.02
    assert r.http_status == 200
    assert r.request_size == 300
    assert r.category == "facebook.com"

    # The same flats against a line whose size slot carries a number: the
    # flag reads the parse.
    recorded = _VERBATIM.replace(" 0.01 - https", " 0.01 512 https", 1)
    r2 = parse_line(recorded, flats={"bytes_downloaded": 512})
    assert r2.response_size == 512
    assert r2.response_size_recorded is True


def test_recorded_slots_are_measured():
    """A line whose size/category/status slots carry numbers measures them."""
    recorded = (
        "[01/Sep/2026:06:59:11 +0700] 172.21.122.6 172.21.122.6 57.144.192.3 "
        '"facebook.com" 0.01 512 https://z-m-gateway.facebook.com/ '
        'facebook.com 200 215 DENY RN190,SNI,BS BE "facebook.com"'
    )
    r = parse_line(recorded)
    assert r.response_size == 512
    assert r.response_size_recorded is True
    assert r.category == "facebook.com"  # slot 7 recorded this time
    assert r.http_status == 200


def test_quoted_field_with_space_stays_whole():
    """Tokenising must not split a quoted value across its spaces."""
    quoted = _VERBATIM.replace('"facebook.com" 0.01', '"facebook page" 0.01', 1)
    r = parse_line(quoted)
    assert r.ok
    assert r.sni_host == "facebook page"
    # The token count is intact: the url slot did not shift into the SNI.
    assert r.url == "https://z-m-gateway.facebook.com/"
    assert r.response_size_recorded is False


def test_rule_codes_split_drops_empties():
    assert parse_rule_codes("RN190,SNI,BS") == ["RN190", "SNI", "BS"]
    assert parse_rule_codes("RN190,,SNI,") == ["RN190", "SNI"]
    assert parse_rule_codes(" RN190 , SNI ") == ["RN190", "SNI"]
    assert parse_rule_codes("") == []
    assert parse_rule_codes(",,,") == []


def test_malformed_lines_degrade_not_raise():
    """Anything that is not the operator's grammar is ok=False + error."""
    for bad in (
        "",
        "   ",
        "not a log line at all",
        "[01/Sep/2026:06:59:11 +0700]",
        "[01/Sep/2026:06:59:11 +0700] 1.2.3.4",
        "[garbage] 1.2.3.4 1.2.3.4 5.6.7.8 s d u c a t a c o b",
        _VERBATIM.replace(" 0.01 - https", " XX - https"),
        _VERBATIM.replace("215 DENY", "abc DENY"),
    ):
        r = parse_line(bad)
        assert not r.ok, f"{bad!r} must not parse"
        assert r.error, f"{bad!r} must carry an error"


def test_parse_line_never_raises_on_arbitrary_input():
    # Spot-check pathological inputs: the parser returns a failure state.
    for weird in ("[", "]", '""', "-" * 100, "[x y]", "\x00\x01"):
        parse_line(weird)


def test_short_line_is_malformed_not_partial():
    """A line shorter than the grammar is a different format, not a prefix.

    A partial parse that guessed the missing tail would corrupt the slots the
    aggregate reads; it must fail loudly instead.
    """
    truncated = " ".join(_VERBATIM.split()[:-1])  # drops the sni_echo token
    r = parse_line(truncated)
    assert not r.ok


def test_extra_trailing_slots_are_tolerated():
    """Trailing extras past sni_echo do not shift any defined slot.

    Rejecting them would disable the recovery path the day the operator
    appends a field; the defined slots are positional and unaffected.
    """
    extended = _VERBATIM + " extra_field"
    r = parse_line(extended)
    assert r.ok
    assert r.response_size is None and r.response_size_recorded is False
    assert r.sni_echo == "facebook.com"


def test_unquoted_timestamp_without_space_is_malformed():
    """The grammar's bracket block contains a space before the offset."""
    r = parse_line(_VERBATIM.replace("+0700]", "+0700 ]", 1).replace(
        "[01/Sep/2026:06:59:11 +0700 ", "[01/Sep/2026:06:59:11+0700", 1
    ))
    assert not r.ok
