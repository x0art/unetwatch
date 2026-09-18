"""Network enrichment (stdlib only): reverse/forward DNS, RDAP, TLS, HTTP.

Every external call is short-timeout, best-effort, and offline-safe.
No function here ever raises for expected bad input — each lookup section
catches ALL exceptions and returns a status dict.
"""

from __future__ import annotations

import concurrent.futures
import http.client
import ipaddress
import json
import socket
import ssl
import urllib.parse
import urllib.request
from datetime import datetime, timezone

_RDAP_URLS = (
    "https://rdap.arin.net/registry/ip/{ip}",
    "https://rdap.db.ripe.net/ip/{ip}",
)

_SKIPPED_RDAP = {
    "status": "skipped",
    "handle": None,
    "org": None,
    "country": None,
    "abuse_contact": None,
    "raw_url": None,
    "error": None,
}

_USER_AGENT = "uNetWatch-enrich/1.0"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _with_timeout(fn, secs: float):
    """Run ``fn()`` with a hard wall-clock bound of ``secs`` seconds."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(fn)
        try:
            return fut.result(timeout=secs)
        except concurrent.futures.TimeoutError as e:
            fut.cancel()
            raise TimeoutError(str(e) or "timed out") from e


def _is_special_ip(ip_obj) -> bool:
    return bool(
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_unspecified
    )


def _reverse_dns(ip: str, timeout_s: float) -> dict:
    try:
        hostname = _with_timeout(lambda: socket.gethostbyaddr(ip)[0], timeout_s)
        return {"status": "ok", "hostname": str(hostname), "error": None}
    except TimeoutError as e:
        return {"status": "timeout", "hostname": None, "error": str(e) or "timed out"}
    except Exception as e:  # noqa: BLE001 — best-effort probe, never propagates
        return {"status": "unavailable", "hostname": None, "error": str(e) or repr(e)}


def _forward_dns(host: str, timeout_s: float) -> dict:
    try:
        infos = _with_timeout(lambda: socket.getaddrinfo(host, None), timeout_s)
        addrs: list[str] = []
        for info in infos or []:
            try:
                addr = info[4][0]
            except Exception:  # noqa: BLE001 — skip malformed entries
                continue
            if addr and addr not in addrs:
                addrs.append(str(addr))
        return {"status": "ok", "addresses": addrs, "error": None}
    except TimeoutError as e:
        return {"status": "timeout", "addresses": [], "error": str(e) or "timed out"}
    except Exception as e:  # noqa: BLE001 — best-effort probe, never propagates
        return {"status": "unavailable", "addresses": [], "error": str(e) or repr(e)}


def _parse_vcard(vcard_array) -> tuple:
    """Best-effort jCard parse → (fn, org, email). Never raises."""
    fn = org = email = None
    try:
        if not isinstance(vcard_array, list) or len(vcard_array) < 2:
            return fn, org, email
        fields = vcard_array[1]
        if not isinstance(fields, list):
            return fn, org, email
        for entry in fields:
            try:
                if not isinstance(entry, list) or len(entry) < 4:
                    continue
                label = str(entry[0]).lower()
                value = entry[3]
            except Exception:  # noqa: BLE001 — skip bad vcard rows
                continue
            try:
                if label == "fn" and fn is None:
                    fn = value if isinstance(value, str) else str(value)
                elif label == "org" and org is None:
                    if isinstance(value, str):
                        org = value
                    elif isinstance(value, list) and value:
                        org = str(value[0])
                    elif value is not None:
                        org = str(value)
                elif label == "email" and email is None:
                    if isinstance(value, str):
                        email = value
                    elif isinstance(value, list) and value:
                        email = str(value[0])
                    elif value is not None:
                        email = str(value)
            except Exception:  # noqa: BLE001 — keep parsing other rows
                continue
    except Exception:  # noqa: BLE001 — parse failure yields Nones
        pass
    return fn, org, email


def _parse_country(vcard_array) -> str | None:
    """Best-effort country from a jCard adr entry. Never raises."""
    try:
        if not isinstance(vcard_array, list) or len(vcard_array) < 2:
            return None
        fields = vcard_array[1]
        if not isinstance(fields, list):
            return None
        for entry in fields:
            try:
                if not isinstance(entry, list) or len(entry) < 4:
                    continue
                if str(entry[0]).lower() != "adr":
                    continue
                params = entry[1]
                value = entry[3]
                if isinstance(params, dict):
                    cc = params.get("cc")
                    if isinstance(cc, str) and cc:
                        return cc
                    # params values are sometimes lists
                    if isinstance(cc, list) and cc and isinstance(cc[0], str):
                        return cc[0]
                if isinstance(value, list) and len(value) >= 7:
                    candidate = value[6]
                    if isinstance(candidate, str) and candidate:
                        return candidate
                elif isinstance(value, str) and value:
                    return value
            except Exception:  # noqa: BLE001 — keep scanning rows
                continue
    except Exception:  # noqa: BLE001 — best effort only
        pass
    return None


def _parse_rdap_payload(data: dict) -> tuple:
    """Best-effort (handle, org, country, abuse_contact). Never raises."""
    handle = org = country = abuse_contact = None
    try:
        if not isinstance(data, dict):
            return handle, org, country, abuse_contact
        raw_handle = data.get("handle")
        if raw_handle is not None:
            handle = str(raw_handle)
        top_country = data.get("country")
        if isinstance(top_country, str) and top_country:
            country = top_country
        entities = data.get("entities")
        if not isinstance(entities, list):
            entities = []
        # Org: first entity with a registrant-ish role.
        for ent in entities:
            try:
                if not isinstance(ent, dict):
                    continue
                roles = ent.get("roles") or []
                if not any(r in ("registrant", "administrative", "technical", "abuse") for r in roles):
                    continue
                fn, org_val, _email = _parse_vcard(ent.get("vcardArray"))
                if org is None and (org_val or fn):
                    org = org_val or fn
                if country is None:
                    candidate = _parse_country(ent.get("vcardArray"))
                    if candidate:
                        country = candidate
                break
            except Exception:  # noqa: BLE001 — try next entity
                continue
        # Abuse contact: entity with the abuse role (incl. one nested level).
        for ent in entities:
            try:
                if not isinstance(ent, dict):
                    continue
                roles = ent.get("roles") or []
                if "abuse" not in roles:
                    continue
                _fn, _o, email = _parse_vcard(ent.get("vcardArray"))
                if email:
                    abuse_contact = email
                    break
                for nested in ent.get("entities") or []:
                    try:
                        if not isinstance(nested, dict):
                            continue
                        _f2, _o2, nemail = _parse_vcard(nested.get("vcardArray"))
                        if nemail:
                            abuse_contact = nemail
                            break
                    except Exception:  # noqa: BLE001 — try next nested entity
                        continue
                if abuse_contact:
                    break
            except Exception:  # noqa: BLE001 — try next entity
                continue
        if org is None:
            name = data.get("name")
            if isinstance(name, str) and name:
                org = name
    except Exception:  # noqa: BLE001 — parse failure yields Nones
        pass
    return handle, org, country, abuse_contact


def _fetch_rdap_json(url: str, timeout_s: float) -> dict:
    def _do():
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/rdap+json", "User-Agent": _USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    return _with_timeout(_do, timeout_s)


def _rdap_lookup(ip: str, timeout_s: float) -> dict:
    try:
        ip_obj = ipaddress.ip_address(ip)
    except Exception as e:  # noqa: BLE001 — invalid literal, no query possible
        return {
            "status": "unavailable",
            "handle": None,
            "org": None,
            "country": None,
            "abuse_contact": None,
            "raw_url": None,
            "error": f"invalid IP address: {e}",
        }
    if _is_special_ip(ip_obj):
        return {
            "status": "skipped",
            "handle": None,
            "org": None,
            "country": None,
            "abuse_contact": None,
            "raw_url": None,
            "error": "private address — no public registration data",
        }
    last_error: str | None = None
    saw_timeout = False
    timeout_msg: str | None = None
    for template in _RDAP_URLS:
        url = template.format(ip=ip)
        try:
            data = _fetch_rdap_json(url, timeout_s)
        except TimeoutError as e:
            saw_timeout = True
            timeout_msg = str(e) or "timed out"
            last_error = timeout_msg
            continue
        except Exception as e:  # noqa: BLE001 — transport failure, try fallback
            # socket.timeout surfaces here (not via _with_timeout); treat as timeout.
            if isinstance(e, socket.timeout):
                saw_timeout = True
                timeout_msg = str(e) or "timed out"
            last_error = str(e) or repr(e)
            continue
        try:
            handle, org, country, abuse_contact = _parse_rdap_payload(data)
        except Exception:  # noqa: BLE001 — parse failure still yields ok+Nones
            handle, org, country, abuse_contact = None, None, None, None
        return {
            "status": "ok",
            "handle": handle,
            "org": org,
            "country": country,
            "abuse_contact": abuse_contact,
            "raw_url": url,
            "error": None,
        }
    if saw_timeout and last_error == timeout_msg:
        return {
            "status": "timeout",
            "handle": None,
            "org": None,
            "country": None,
            "abuse_contact": None,
            "raw_url": None,
            "error": timeout_msg or "timed out",
        }
    return {
        "status": "unavailable",
        "handle": None,
        "org": None,
        "country": None,
        "abuse_contact": None,
        "raw_url": None,
        "error": last_error or "RDAP lookup failed",
    }


def _dn_to_str(dn) -> str | None:
    """Format a getpeercert() DN tuple as an RFC4514-ish string. Never raises."""
    try:
        if not dn:
            return None
        parts: list[str] = []
        for rdn in dn:
            try:
                attrs = []
                for attr in rdn:
                    try:
                        attrs.append(f"{attr[0]}={attr[1]}")
                    except Exception:  # noqa: BLE001 — skip bad attr
                        continue
                if attrs:
                    parts.append("+".join(attrs))
            except Exception:  # noqa: BLE001 — skip bad RDN
                continue
        return ",".join(parts) if parts else None
    except Exception:  # noqa: BLE001 — best effort only
        return None


def _tls_probe(host: str, port: int, timeout_s: float) -> dict:
    def _do():
        context = ssl.create_default_context()
        sock = socket.create_connection((host, port), timeout=timeout_s)
        try:
            with context.wrap_socket(sock, server_hostname=host) as tls_sock:
                return tls_sock.getpeercert()
        except Exception:
            try:
                sock.close()
            except Exception:  # noqa: BLE001 — close best effort
                pass
            raise

    try:
        cert = _with_timeout(_do, timeout_s)
        try:
            subject = _dn_to_str(cert.get("subject"))
            issuer = _dn_to_str(cert.get("issuer"))
            not_after = cert.get("notAfter")
            if not_after is not None:
                not_after = str(not_after)
            san: list[str] = []
            for entry in cert.get("subjectAltName") or ():
                try:
                    if entry[0] == "DNS":
                        san.append(str(entry[1]))
                except Exception:  # noqa: BLE001 — skip bad SAN entries
                    continue
        except Exception:  # noqa: BLE001 — parse failure still yields ok+Nones
            subject = issuer = not_after = None
            san = []
        return {
            "status": "ok",
            "subject": subject,
            "issuer": issuer,
            "not_after": not_after,
            "san": san,
            "error": None,
        }
    except TimeoutError as e:
        return {
            "status": "timeout",
            "subject": None,
            "issuer": None,
            "not_after": None,
            "san": [],
            "error": str(e) or "timed out",
        }
    except Exception as e:  # noqa: BLE001 — best-effort probe, never propagates
        if isinstance(e, socket.timeout):
            return {
                "status": "timeout",
                "subject": None,
                "issuer": None,
                "not_after": None,
                "san": [],
                "error": str(e) or "timed out",
            }
        return {
            "status": "unavailable",
            "subject": None,
            "issuer": None,
            "not_after": None,
            "san": [],
            "error": str(e) or repr(e),
        }


def _http_probe(url: str, timeout_s: float, max_redirects: int = 3) -> dict:
    def _single_request(current_url: str):
        parts = urllib.parse.urlsplit(current_url)
        if parts.scheme not in ("http", "https"):
            raise ValueError(f"unsupported scheme: {parts.scheme!r}")
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(host, port, timeout=timeout_s)
        try:
            conn.request("HEAD", path, headers={"User-Agent": _USER_AGENT, "Connection": "close"})
            resp = conn.getresponse()
            status_code = resp.status
            server = resp.getheader("Server")
            location = resp.getheader("Location")
            try:
                resp.read()
            except Exception:  # noqa: BLE001 — body drain best effort
                pass
            return status_code, server, location
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 — close best effort
                pass

    current_url = url
    redirects = 0
    try:
        for _ in range(max_redirects + 1):
            try:
                status_code, server, location = _with_timeout(
                    lambda u=current_url: _single_request(u), timeout_s
                )
            except TimeoutError:
                raise
            if status_code in (301, 302, 303, 307, 308) and location and redirects < max_redirects:
                redirects += 1
                current_url = urllib.parse.urljoin(current_url, location)
                continue
            return {
                "status": "ok",
                "status_code": status_code,
                "server": server,
                "final_url": current_url,
                "redirects": redirects,
                "error": None,
            }
        return {
            "status": "ok",
            "status_code": None,
            "server": None,
            "final_url": current_url,
            "redirects": redirects,
            "error": None,
        }
    except TimeoutError as e:
        return {
            "status": "timeout",
            "status_code": None,
            "server": None,
            "final_url": current_url,
            "redirects": redirects,
            "error": str(e) or "timed out",
        }
    except Exception as e:  # noqa: BLE001 — best-effort probe, never propagates
        if isinstance(e, socket.timeout):
            return {
                "status": "timeout",
                "status_code": None,
                "server": None,
                "final_url": current_url,
                "redirects": redirects,
                "error": str(e) or "timed out",
            }
        return {
            "status": "unavailable",
            "status_code": None,
            "server": None,
            "final_url": current_url,
            "redirects": redirects,
            "error": str(e) or repr(e),
        }


def _skipped_forward() -> dict:
    return {"status": "skipped", "addresses": [], "error": None}


def _skipped_reverse() -> dict:
    return {"status": "skipped", "hostname": None, "error": None}


def _skipped_tls() -> dict:
    return {
        "status": "skipped",
        "subject": None,
        "issuer": None,
        "not_after": None,
        "san": [],
        "error": None,
    }


def _skipped_http() -> dict:
    return {
        "status": "skipped",
        "status_code": None,
        "server": None,
        "final_url": None,
        "redirects": 0,
        "error": None,
    }


def _skipped_rdap() -> dict:
    return dict(_SKIPPED_RDAP)


def enrich_host(ip: str, timeout_s: float = 3.0) -> dict:
    """Enrich a single IP literal. NEVER raises."""
    checked_at = _utc_now_iso()
    notes: list[str] = []
    try:
        try:
            ip_obj = ipaddress.ip_address(ip)
            ip_version = f"v{ip_obj.version}"
            is_special = _is_special_ip(ip_obj)
        except Exception:
            ip_version = "unknown"
            is_special = False
            notes.append(f"invalid IP address: {ip!r} — results limited")

        try:
            reverse_dns = _reverse_dns(ip, timeout_s)
        except Exception as e:  # noqa: BLE001 — section must never propagate
            reverse_dns = {"status": "unavailable", "hostname": None, "error": str(e) or repr(e)}

        try:
            hostname = reverse_dns.get("hostname")
            if reverse_dns.get("status") == "ok" and hostname:
                forward_dns = _forward_dns(hostname, timeout_s)
            else:
                forward_dns = _skipped_forward()
        except Exception as e:  # noqa: BLE001 — section must never propagate
            forward_dns = {"status": "unavailable", "addresses": [], "error": str(e) or repr(e)}

        try:
            rdap = _rdap_lookup(ip, timeout_s)
        except Exception as e:  # noqa: BLE001 — section must never propagate
            rdap = {
                "status": "unavailable",
                "handle": None,
                "org": None,
                "country": None,
                "abuse_contact": None,
                "raw_url": None,
                "error": str(e) or repr(e),
            }

        if ip_version != "unknown" and is_special:
            notes.append("private address — registration data not applicable")

        return {
            "entity": {"kind": "host", "value": ip},
            "checked_at": checked_at,
            "ip_version": ip_version,
            "reverse_dns": reverse_dns,
            "forward_dns": forward_dns,
            "rdap": rdap,
            "notes": notes,
        }
    except Exception as e:  # noqa: BLE001 — outer never-raise guarantee
        return {
            "entity": {"kind": "host", "value": ip},
            "checked_at": checked_at,
            "ip_version": "unknown",
            "reverse_dns": {"status": "unavailable", "hostname": None, "error": str(e) or repr(e)},
            "forward_dns": _skipped_forward(),
            "rdap": {
                "status": "unavailable",
                "handle": None,
                "org": None,
                "country": None,
                "abuse_contact": None,
                "raw_url": None,
                "error": str(e) or repr(e),
            },
            "notes": notes + [f"enrichment degraded: {e}"],
        }


def enrich_url(url: str, timeout_s: float = 3.0, probe: bool = True) -> dict:
    """Enrich a URL. NEVER raises."""
    checked_at = _utc_now_iso()
    notes: list[str] = []
    try:
        parse_target = url
        try:
            has_scheme = bool(urllib.parse.urlsplit(url).scheme)
        except Exception:  # noqa: BLE001 — unparseable input treated as schemeless
            has_scheme = False
        if not has_scheme:
            parse_target = "http://" + url
            notes.append("no scheme — assumed http:// for parsing")

        try:
            parts = urllib.parse.urlsplit(parse_target)
            scheme = (parts.scheme or "").lower()
            host = parts.hostname or ""
        except Exception as e:  # noqa: BLE001 — parse failure → degraded shape
            return {
                "entity": {"kind": "url", "value": url},
                "checked_at": checked_at,
                "host": "",
                "is_ip_literal": False,
                "resolved_ips": [],
                "reverse_dns": _skipped_reverse(),
                "tls": _skipped_tls(),
                "http": _skipped_http(),
                "rdap": _skipped_rdap(),
                "notes": notes + [f"could not parse host from URL: {e}"],
            }

        if not host:
            return {
                "entity": {"kind": "url", "value": url},
                "checked_at": checked_at,
                "host": "",
                "is_ip_literal": False,
                "resolved_ips": [],
                "reverse_dns": _skipped_reverse(),
                "tls": _skipped_tls(),
                "http": _skipped_http(),
                "rdap": _skipped_rdap(),
                "notes": notes + ["could not parse host from URL"],
            }

        try:
            ipaddress.ip_address(host)
            is_ip_literal = True
        except Exception:  # noqa: BLE001 — not an IP literal
            is_ip_literal = False

        literal_is_special = False
        if is_ip_literal:
            try:
                literal_is_special = _is_special_ip(ipaddress.ip_address(host))
            except Exception:  # noqa: BLE001 — best effort only
                literal_is_special = False

        try:
            if is_ip_literal:
                resolved_ips = [host]
            else:
                fwd = _forward_dns(host, timeout_s)
                resolved_ips = list(fwd.get("addresses") or [])
        except Exception as e:  # noqa: BLE001 — section must never propagate
            resolved_ips = []
            notes.append(f"DNS resolution degraded: {e}")

        try:
            if resolved_ips:
                reverse_dns = _reverse_dns(resolved_ips[0], timeout_s)
            else:
                reverse_dns = _skipped_reverse()
        except Exception as e:  # noqa: BLE001 — section must never propagate
            reverse_dns = {"status": "unavailable", "hostname": None, "error": str(e) or repr(e)}

        if literal_is_special:
            notes.append("private address — TLS/HTTP probing skipped")

        try:
            if scheme == "https" and probe and host and not literal_is_special:
                tls = _tls_probe(host, 443, timeout_s)
            else:
                tls = _skipped_tls()
        except Exception as e:  # noqa: BLE001 — section must never propagate
            tls = {
                "status": "unavailable",
                "subject": None,
                "issuer": None,
                "not_after": None,
                "san": [],
                "error": str(e) or repr(e),
            }

        try:
            if scheme in ("http", "https") and probe and not literal_is_special:
                http_result = _http_probe(parse_target, timeout_s)
            else:
                http_result = _skipped_http()
        except Exception as e:  # noqa: BLE001 — section must never propagate
            http_result = {
                "status": "unavailable",
                "status_code": None,
                "server": None,
                "final_url": parse_target,
                "redirects": 0,
                "error": str(e) or repr(e),
            }

        try:
            if resolved_ips:
                first = resolved_ips[0]
                try:
                    first_is_special = _is_special_ip(ipaddress.ip_address(first))
                except Exception:  # noqa: BLE001 — unparseable → treat as public attempt
                    first_is_special = False
                if first_is_special:
                    rdap = _skipped_rdap()
                    if not any("registration data" in n for n in notes):
                        notes.append("private address — registration data not applicable")
                else:
                    rdap = _rdap_lookup(first, timeout_s)
            else:
                rdap = _skipped_rdap()
        except Exception as e:  # noqa: BLE001 — section must never propagate
            rdap = {
                "status": "unavailable",
                "handle": None,
                "org": None,
                "country": None,
                "abuse_contact": None,
                "raw_url": None,
                "error": str(e) or repr(e),
            }

        return {
            "entity": {"kind": "url", "value": url},
            "checked_at": checked_at,
            "host": host,
            "is_ip_literal": is_ip_literal,
            "resolved_ips": resolved_ips,
            "reverse_dns": reverse_dns,
            "tls": tls,
            "http": http_result,
            "rdap": rdap,
            "notes": notes,
        }
    except Exception as e:  # noqa: BLE001 — outer never-raise guarantee
        return {
            "entity": {"kind": "url", "value": url},
            "checked_at": checked_at,
            "host": "",
            "is_ip_literal": False,
            "resolved_ips": [],
            "reverse_dns": _skipped_reverse(),
            "tls": _skipped_tls(),
            "http": _skipped_http(),
            "rdap": _skipped_rdap(),
            "notes": notes + [f"enrichment degraded: {e}"],
        }
