"""Blacklist value normalization: inputs are reduced to bare FQDN / IP.

A blacklist entry is stored as the bare host — protocol, port, path, query and
fragment are stripped so the plain-text feeds are always clean FQDNs or IPv4
addresses. Shared by the API route and the startup migration.
"""

import ipaddress


def normalize_blacklist_value(value: str) -> tuple[str, str]:
    """Normalize a blacklist input into ``(kind, value)``.

    Returns ``("url", fqdn)`` for anything whose host contains a dot (protocol,
    userinfo, port, path, query and fragment stripped; lowercased) and
    ``("ip", address)`` for a bare IPv4 address (optionally with a port).

    Raises ``ValueError`` for inputs that are neither a URL nor an IPv4
    address (empty, whitespace, no dot in the host…).
    """
    v = value.strip()
    if not v:
        raise ValueError("value must not be empty")
    if " " in v:
        raise ValueError("value must be a URL (http://...) or IPv4 address")

    authority = v.split("://", 1)[-1].split("/", 1)[0]
    host = authority.rsplit("@", 1)[-1].split(":", 1)[0]
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        if "." not in host:
            raise ValueError("value must be a URL (http://...) or IPv4 address")
        return ("url", host.lower())
    return ("ip", host)
