"""Jaillist value normalization: inputs are reduced to a canonical IP string.

A jaillist entry stores a single client (source) IP — no kinds, no CIDR
ranges, no hostnames. Shared by the API route and the upstream sync.
"""

import ipaddress


def normalize_jaillist_value(value: str) -> str:
    """Normalize a jaillist input into a canonical IP string.

    Strips whitespace, accepts an optional single ``:port`` suffix on IPv4
    (``1.2.3.4:5678`` → ``1.2.3.4``), and validates with
    ``ipaddress.ip_address`` — the stored form is ``str(ip)`` (compresses
    IPv6).

    Raises ``ValueError`` for anything that is not a single IP address
    (empty, whitespace, hostnames, URLs, CIDR ranges…).
    """
    v = value.strip()
    if not v:
        raise ValueError("value must not be empty")
    if " " in v:
        raise ValueError("value must be a single IP address")
    if "/" in v:
        raise ValueError("value must be a single IP address (not a CIDR range or URL)")

    candidate = v
    if candidate.count(":") == 1 and "." in candidate:
        host, port = candidate.rsplit(":", 1)
        if port.isdigit():
            candidate = host

    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        raise ValueError("value must be a single IP address")
    return str(ip)
