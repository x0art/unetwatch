"""Operator-timezone helpers — the single place UTC↔local is converted.

The proxy feed emits UTC (``@timestamp``, persisted verbatim into
``findings.log_timestamp``), but the operator's calendar is local. Every
calendar-day bucket on the Analytics page and in the client report must
therefore be derived from the **local** date, not the UTC date string — a
request made at local 06:59 on 1 September (+07:00) is
``2026-08-31T23:59:11Z`` in UTC and belongs in the **1 Sep** bucket.

The zone is configured via ``Settings.display_tz`` (env ``DISPLAY_TZ``). When
that is **unset**, the zone follows the *host's* system zone (``TZ``, then
``/etc/timezone``, then the ``/etc/localtime`` symlink) so a box whose clock is
``Asia/Jakarta`` renders ``Asia/Jakarta`` without an explicit setting — an
explicit ``DISPLAY_TZ`` always wins. Resolution is deliberately
failure-tolerant: an unknown/invalid *configured* zone warns once and falls back
to UTC, and a host zone we cannot read falls back to UTC silently — neither
raises, so a typo in the environment (or an exotic host) cannot 500 every
analytics endpoint. ``tzdata`` dependency is declared: on Linux (the Docker
image) and macOS the IANA database ships with the OS, so ``zoneinfo`` resolves
names on its own. The ``tzdata`` PyPI package is only required on Windows or a
stripped image with no system zoneinfo — see ``pyproject.toml`` for the
documented floor.
"""

import os
from datetime import UTC, datetime, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_COMPONENTS = ("display_tz", "DISPLAY_TZ")

# Warn once per distinct bad value instead of once per row/request — the
# aggregations call this in a loop over up to 20 000 findings rows.
_warned: set[str] = set()

# System-zone detection reads the environment/filesystem; memoise it because
# every row in a 20 000-row aggregation would otherwise stat /etc/localtime.
_system_zone_cache: str | None = None
_system_zone_resolved = False


def _warn_once(value: str) -> None:
    if value in _warned:
        return
    _warned.add(value)
    print(
        f"[WARN] DISPLAY_TZ={value!r} is not a known IANA timezone "
        "(e.g. 'Asia/Bangkok' or '+07:00'); falling back to UTC."
    )


def _from_settings() -> tzinfo:
    # Imported lazily: app.config imports nothing from here, but keeping the
    # import inside the function keeps this module import-cycle-free and cheap
    # for callers that pass an explicit zone.
    from app.config import get_settings

    for name in _COMPONENTS:
        value = getattr(get_settings(), name, None)
        if value:
            return parse_timezone(str(value))
    # Nothing configured: follow the host clock rather than silently reading
    # every timestamp in UTC. `system_zone_name()` is validated and falls back
    # to UTC on its own, so this never raises.
    return parse_timezone(system_zone_name())


def _zone_from_localtime() -> str:
    """The IANA name behind ``/etc/localtime``, or ``""``.

    On Linux ``/etc/localtime`` is normally a symlink into
    ``/usr/share/zoneinfo/<Area>/<City>``; the portion after ``zoneinfo/`` is
    the IANA key. A regular file (a copy, not a link) yields nothing — we
    refuse to guess from its bytes.
    """
    try:
        target = os.path.realpath("/etc/localtime")
    except OSError:  # pragma: no cover — defensive
        return ""
    marker = "/zoneinfo/"
    idx = target.find(marker)
    return target[idx + len(marker):] if idx != -1 else ""


def system_zone_name() -> str:
    """The host's IANA zone name, or ``""`` when it cannot be determined.

    Precedence: the ``TZ`` environment variable, then ``/etc/timezone``, then
    the ``/etc/localtime`` symlink. Every candidate is validated against
    ``zoneinfo`` (POSIX ``TZ`` forms such as ``WIB-7`` are rejected), so a
    caller either gets a name ``ZoneInfo`` can resolve or an empty string —
    never a bogus value that would later raise. Memoised: the caller is often a
    per-row loop.
    """
    global _system_zone_cache, _system_zone_resolved
    if _system_zone_resolved:
        return _system_zone_cache or ""

    candidates = [os.environ.get("TZ", "")]
    try:
        with open("/etc/timezone", encoding="utf-8") as fh:
            candidates.append(fh.read().strip())
    except OSError:
        pass
    candidates.append(_zone_from_localtime())

    for candidate in candidates:
        name = (candidate or "").strip()
        if not name:
            continue
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            continue
        _system_zone_cache = name
        _system_zone_resolved = True
        return name

    _system_zone_cache = ""
    _system_zone_resolved = True
    return ""


def reset_system_zone_cache() -> None:
    """Clear the memoised system-zone lookup (test hook)."""
    global _system_zone_cache, _system_zone_resolved
    _system_zone_cache = None
    _system_zone_resolved = False


def parse_timezone(name: str) -> tzinfo:
    """Resolve an IANA name (``Asia/Bangkok``) or fixed offset (``+07:00``).

    Never raises: an unknown or malformed value degrades to UTC and logs once.
    """
    value = (name or "").strip()
    if not value:
        return UTC
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        pass
    # Offset form ("+07:00") is accepted for operators who only know their
    # offset — ZoneInfo rejects it, so parse it explicitly.
    try:
        return datetime.fromisoformat(f"2000-01-01T00:00:00{value}").tzinfo or UTC
    except ValueError:
        _warn_once(value)
        return UTC


def operator_tz() -> tzinfo:
    """The configured operator zone, or UTC when the setting is absent/invalid."""
    return _from_settings()


def _parse_utc(ts: str) -> datetime | None:
    """Parse a feed timestamp into an aware UTC datetime, or ``None``.

    The feed emits ``...Z``; a naive value (no offset) is read as UTC because
    that is the feed's contract. Returns ``None`` for empty/unparseable input
    so callers can preserve their existing "skip" behaviour.
    """
    raw = (ts or "").strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def local_day(ts: str) -> str:
    """The operator-local ``YYYY-MM-DD`` for a UTC ISO timestamp.

    Returns ``""`` for an empty or unparseable timestamp so callers keep their
    existing "skip empty day" behaviour (the row is dropped, not bucketed
    under a bogus date).
    """
    dt = _parse_utc(ts)
    if dt is None:
        return ""
    return dt.astimezone(operator_tz()).strftime("%Y-%m-%d")


def local_hour_bucket(ts: str) -> str:
    """The operator-local hour bucket (``YYYY-MM-DDTHH:00:00``) for a UTC ISO ts."""
    dt = _parse_utc(ts)
    if dt is None:
        return ""
    return dt.astimezone(operator_tz()).strftime("%Y-%m-%dT%H:00:00")


def zone_label(tz: tzinfo | None = None) -> str:
    """A short, honest label for the active zone: ``UTC``, ``+07:00``, ``Asia/Bangkok``.

    Prefers the IANA key. A fixed-offset zone has no key, and ``tzname()``
    synthesises a ``"UTC+07:00"``-style string for those — so the offset is
    formatted explicitly instead of being echoed back.
    """
    zone = tz or operator_tz()
    key = getattr(zone, "key", None)
    if key:
        return str(key)
    offset = zone.utcoffset(None)
    if offset is None or offset.total_seconds() == 0:
        return "UTC"
    total = int(offset.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    hours, minutes = divmod(total // 60, 60)
    return f"{sign}{hours:02d}:{minutes:02d}"


def utc_offset_minutes(tz: tzinfo | None = None) -> int:
    """The zone's UTC offset **right now**, in minutes (e.g. 420 for ``+07:00``).

    Fixed-offset zones report their constant offset; IANA zones report the
    offset in effect at the current instant (DST-aware). Resolves through
    :func:`operator_tz` when ``tz`` is omitted, so a misconfigured
    ``DISPLAY_TZ`` degrades to 0 exactly like every other helper here.
    """
    zone = tz or operator_tz()
    offset = datetime.now(UTC).astimezone(zone).utcoffset()
    return int(offset.total_seconds() // 60) if offset else 0


def format_peak(dt_value: datetime, tz: tzinfo | None = None) -> str:
    """Format an instant as ``'Tue 14:00 +07:00'`` in the configured zone.

    Naive inputs are read as UTC (the feed's contract). The label is derived
    from the zone actually used — never a hardcoded name.
    """
    zone = tz or operator_tz()
    if dt_value.tzinfo is None:
        dt_value = dt_value.replace(tzinfo=UTC)
    local = dt_value.astimezone(zone)
    weekday = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[local.weekday()]
    return f"{weekday} {local.strftime('%H:%M')} {zone_label(zone)}"


def format_peak_iso(ts: str) -> str:
    """``format_peak`` for an ISO string. Unparseable input is returned as-is.

    Accepts both a full timestamp (``2026-08-31T23:59:11Z``) and a bare
    pre-truncated hour bucket (``2026-08-31T23:00:00``) so the ES and findings
    paths share one formatter.
    """
    raw = (ts or "").strip()
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return ts
    return format_peak(dt)


def reset_warning_cache() -> None:
    """Clear the once-per-value warning memo (test hook)."""
    _warned.clear()
