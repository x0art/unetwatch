"""Raw-line parser for the operator's proxy documents (spec §j.7 recovery path).

The flat fields logstash emits flatten the line's positional structure away:
``bytes_downloaded`` is ``0`` whether the response size was genuinely zero or
the ``-`` NOT-RECORDED sentinel (spec §j.5 — a measured zero in a share
denominator makes ``upload/(upload+download)`` vacuously ``1.0``), and
``category`` carries the SNI even when the line's own category slot is ``-``.
``message`` carries the raw line, a strict superset of the flat fields, so
this parser recovers the positional facts the flat schema loses — most
importantly WHICH response-size slots were actually recorded.

This is a *recovery* path, not a detector: everything it derives re-states
what the line already flattens, so it lives behind a pure, fully-tested
parser and is never read by a technique predicate (spec §e.7 — provenance
and raw structure buy context, never a technique).

Grammar contract (whitespace-delimited, quoted fields kept whole):

    [01/Sep/2026:06:59:11 +0700] 172.21.122.6 172.21.122.6 57.144.192.3
    "facebook.com" 0.01 - https://z-m-gateway.facebook.com/ - 0 215 DENY
    RN190,SNI,BS BE "facebook.com"

    bracket block  [DD/Mon/YYYY:HH:MM:SS +ZZZZ]  -> local_timestamp, tz_offset
    slot  0  client_ip
    slot  1  user_id        (an IP when the request is unauthenticated)
    slot  2  server_ip
    slot  3  sni_host       (quoted)
    slot  4  duration_seconds
    slot  5  response_size  (``-`` = NOT-RECORDED — the §j.5 sentinel)
    slot  6  url
    slot  7  category       (``-`` = not recorded; the flat carries the SNI)
    slot  8  http_status    (``0`` = no upstream response on DENY)
    slot  9  request_size
    slot 10  action
    slot 11  rule_codes     (comma-separated, undecoded — spec §j.3)
    slot 12  country_code
    slot 13  sni_echo       (quoted)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# A quoted field (kept whole, quotes intact) or a bare run of non-space.
# ``[^"]*`` tolerates an unterminated quote by falling back to \S+ — it
# degrades to a bare token instead of losing the rest of the line.
_TOKEN = re.compile(r'"[^"]*"|\S+')

# The bracket block anchors the line: [DD/Mon/YYYY:HH:MM:SS +ZZZZ]. Matched by
# regex, not strptime: ``%b`` is locale-dependent and the parse must be
# deterministic everywhere it runs.
_TIMESTAMP = re.compile(
    r"^\[(\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]$"
)

# Slots the grammar defines after the timestamp block. A shorter line is a
# different format and must fail loudly (ok=False) rather than misparse;
# longer lines are tolerated — trailing extras past sni_echo do not shift
# any defined slot, and rejecting them would disable the recovery path the
# day the operator appends a field.
_MIN_SLOTS = 14


@dataclass
class LogLine:
    """One parsed raw line. ``None`` on a numeric slot means NOT-RECORDED.

    ``response_size_recorded`` is the load-bearing fact: it distinguishes a
    genuinely zero response size from the ``-`` sentinel logstash collapses
    to ``bytes_downloaded: 0`` (spec §j.5). ``error`` is set and ``ok`` False
    when the line is not the operator's grammar; the parser never raises.
    """

    ok: bool
    error: str | None
    local_timestamp: str = ""
    tz_offset: str = ""
    client_ip: str = ""
    user_id: str = ""
    server_ip: str = ""
    sni_host: str = ""
    duration_seconds: float | None = None
    response_size: int | None = None
    response_size_recorded: bool = False
    url: str = ""
    category: str | None = None
    http_status: int | None = None
    request_size: int | None = None
    action: str = ""
    rule_codes: list[str] = field(default_factory=list)
    country_code: str = ""
    sni_echo: str = ""


def parse_rule_codes(raw: str) -> list[str]:
    """Split a comma-separated rule-code set, stripped, empties dropped."""
    return [part.strip() for part in raw.split(",") if part.strip()]


def _int_slot(token: str) -> tuple[int | None, bool]:
    """A numeric slot: ``(value, ok)``.

    ``-`` -> ``(None, True)`` — the sentinel is part of the grammar (a
    not-recorded counter, never a measured zero); garbage -> ``(None,
    False)`` — not the operator's line, and a corrupt parse must be visible.
    """
    if token == "-":
        return None, True
    try:
        return int(token), True
    except ValueError:
        return None, False


def _float_slot(token: str) -> tuple[float | None, bool]:
    """Same contract as :func:`_int_slot` for a float slot."""
    if token == "-":
        return None, True
    try:
        return float(token), True
    except ValueError:
        return None, False


def _flat_int(flats: dict | None, key: str) -> int | None:
    """A flat counter coerced to int, or None when absent/unparseable."""
    if not flats or key not in flats or flats[key] is None:
        return None
    try:
        return int(flats[key])
    except (TypeError, ValueError):
        return None


def _flat_float(flats: dict | None, key: str) -> float | None:
    """A flat float coerced, or None when absent/unparseable."""
    if not flats or key not in flats or flats[key] is None:
        return None
    try:
        return float(flats[key])
    except (TypeError, ValueError):
        return None


def _flat_str(flats: dict | None, key: str) -> str | None:
    """A flat text value stripped, or None when absent/blank."""
    if not flats or key not in flats or flats[key] is None:
        return None
    value = str(flats[key]).strip()
    return value or None


def parse_line(raw_line: str, flats: dict | None = None) -> LogLine:
    """Parse one raw line into positional facts; never raises.

    ``flats`` (an ES ``_source`` dict, optional) validates the parse: where a
    flat exists it is the authoritative value field — the pipeline derives
    those from this same line — while ``response_size_recorded`` always comes
    from the parse, so a ``-`` sentinel collapsed to ``bytes_downloaded: 0``
    can never pass for a measured zero (spec §j.5).
    """
    tokens = _TOKEN.findall(raw_line or "")
    if not tokens or not tokens[0].startswith("["):
        return LogLine(ok=False, error="line does not start with a [timestamp] block")
    if len(tokens) < 2 or not tokens[1].endswith("]"):
        return LogLine(ok=False, error="truncated [timestamp] block")
    stamp = f"{tokens[0]} {tokens[1]}"
    stamp_match = _TIMESTAMP.match(stamp)
    if stamp_match is None:
        return LogLine(ok=False, error=f"unparseable timestamp block: {stamp}")
    slots = tokens[2:]
    if len(slots) < _MIN_SLOTS:
        return LogLine(
            ok=False,
            error=f"expected >= {_MIN_SLOTS} slots after the timestamp, got {len(slots)}",
        )

    (
        client_ip, user_id, server_ip, sni_tok, duration_tok, response_tok,
        url, category_tok, status_tok, request_tok, action, codes_raw,
        country_code, echo_tok,
    ) = slots[:_MIN_SLOTS]

    duration, duration_ok = _float_slot(duration_tok)
    response_size, size_ok = _int_slot(response_tok)
    status, status_ok = _int_slot(status_tok)
    request_size, request_ok = _int_slot(request_tok)
    if not (duration_ok and size_ok and status_ok and request_ok):
        return LogLine(ok=False, error="non-numeric value in a numeric slot")

    # Flat counters, when supplied, are the authoritative value fields (the
    # pipeline derives them from this same line); the parse's sentinel stays
    # in ``response_size_recorded`` so a collapsed ``bytes_downloaded: 0``
    # can never pass for a measured zero (§j.5).
    response_size_recorded = response_tok != "-"
    flat_response = _flat_int(flats, "bytes_downloaded")
    if flat_response is not None:
        response_size = flat_response
    flat_duration = _flat_float(flats, "duration_seconds")
    if flat_duration is not None:
        duration = flat_duration
    flat_status = _flat_int(flats, "http_status_code")
    if flat_status is not None:
        status = flat_status
    flat_request = _flat_int(flats, "bytes_uploaded")
    if flat_request is not None:
        request_size = flat_request
    category = _flat_str(flats, "category")
    if category is None:
        category = None if category_tok == "-" else category_tok.strip('"')

    return LogLine(
        ok=True,
        error=None,
        local_timestamp=stamp_match.group(1),
        tz_offset=stamp_match.group(2),
        client_ip=client_ip,
        user_id=user_id,
        server_ip=server_ip,
        sni_host=sni_tok.strip('"'),
        duration_seconds=duration,
        response_size=response_size,
        response_size_recorded=response_size_recorded,
        url=url,
        category=category,
        http_status=status,
        request_size=request_size,
        action=action,
        rule_codes=parse_rule_codes(codes_raw),
        country_code=country_code,
        sni_echo=echo_tok.strip('"'),
    )
