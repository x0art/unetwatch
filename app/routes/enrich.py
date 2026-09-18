"""Network-enrichment API routes. Always 200 — never 500."""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.services.enrich import enrich_host, enrich_url

router = APIRouter(prefix="/api/enrich", tags=["enrich"])


@router.get("/host/{ip}")
async def enrich_host_route(
    ip: str,
    timeout_s: float = Query(3.0, ge=0.5, le=10.0),
):
    """Enrich a single IP literal. Always returns 200."""
    try:
        return enrich_host(ip, timeout_s)
    except Exception as e:  # noqa: BLE001 — never-500 guarantee
        return {
            "entity": {"kind": "host", "value": ip},
            "checked_at": None,
            "ip_version": "unknown",
            "reverse_dns": {"status": "unavailable", "hostname": None, "error": str(e) or repr(e)},
            "forward_dns": {"status": "skipped", "addresses": [], "error": None},
            "rdap": {
                "status": "unavailable",
                "handle": None,
                "org": None,
                "country": None,
                "abuse_contact": None,
                "raw_url": None,
                "error": str(e) or repr(e),
            },
            "notes": [f"enrichment degraded: {e}"],
        }


@router.get("/url/{url:path}")
async def enrich_url_route(
    url: str,
    timeout_s: float = Query(3.0, ge=0.5, le=10.0),
    probe: bool = Query(True),
):
    """Enrich a URL. Always returns 200."""
    try:
        return enrich_url(url, timeout_s, probe)
    except Exception as e:  # noqa: BLE001 — never-500 guarantee
        return {
            "entity": {"kind": "url", "value": url},
            "checked_at": None,
            "host": "",
            "is_ip_literal": False,
            "resolved_ips": [],
            "reverse_dns": {"status": "skipped", "hostname": None, "error": None},
            "tls": {
                "status": "skipped",
                "subject": None,
                "issuer": None,
                "not_after": None,
                "san": [],
                "error": None,
            },
            "http": {
                "status": "skipped",
                "status_code": None,
                "server": None,
                "final_url": None,
                "redirects": 0,
                "error": None,
            },
            "rdap": {
                "status": "skipped",
                "handle": None,
                "org": None,
                "country": None,
                "abuse_contact": None,
                "raw_url": None,
                "error": None,
            },
            "notes": [f"enrichment degraded: {e}"],
        }
