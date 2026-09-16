"""Jaillist value normalization: inputs are reduced to single-host CIDR.

A jaillist entry stores a single client (source) IP as a canonical host
CIDR — IPv4 ``ip/32``, IPv6 ``ip/128``. No kinds, no CIDR ranges, no
hostnames. Shared by the API route and the upstream sync.
"""

import ipaddress


def normalize_jaillist_value(value: str) -> str:
    """Normalize a jaillist input into a canonical single-host CIDR string.

    The stored form is ALWAYS ``ip/32`` for IPv4 and ``ip/128`` for IPv6 —
    a single host with its single-address prefix length, ready for the
    jail feed (firewall / fail2ban expect CIDR notation).

    Accepts a bare IP (``1.2.3.4`` → ``1.2.3.4/32``), an IPv4 with an
    optional single ``:port`` suffix (``1.2.3.4:5678`` → ``1.2.3.4/32``),
    or a single-host CIDR already carrying the correct prefix
    (``1.2.3.4/32``, ``2001:db8::1/128``). Any other mask (e.g.
    ``10.0.0.0/24``) is rejected — a range is not a single host.

    Raises ``ValueError`` for anything that is not a single IP host
    (empty, whitespace, hostnames, URLs, CIDR ranges…).
    """
    v = value.strip()
    if not v:
        raise ValueError("value must not be empty")
    if " " in v:
        raise ValueError("value must be a single IP address")

    candidate = v
    # Strip an optional :port suffix on IPv4 (1.2.3.4:5678); IPv6 has more
    # than one colon so it is never treated as host:port here.
    if candidate.count(":") == 1 and "." in candidate:
        host, port = candidate.rsplit(":", 1)
        if port.isdigit():
            candidate = host

    # Split an optional single-host CIDR mask.
    mask: str | None = None
    if "/" in candidate:
        candidate, _, mask = candidate.partition("/")

    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        raise ValueError("value must be a single IP address")

    # Only the family's single-host prefix is accepted; anything else is a
    # range (silently rewriting a range to a host would lose enforcement).
    # NOTE: IPv6 gets /128, not /32 — a literal /32 on IPv6 is a
    # whole /32 range, not one host. Pass a one-liner override if you truly
    # want /32 on everything (not recommended).
    host_prefix = "128" if ip.version == 6 else "32"
    if mask is not None and mask != host_prefix:
        raise ValueError(
            f"value must be a single host (/{host_prefix}), not a CIDR range"
        )
    return f"{ip}/{host_prefix}"
