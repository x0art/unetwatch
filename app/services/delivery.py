"""Unified alert delivery: n8n webhook + MS Teams Workflows.

Handles payload construction, HTTP delivery, retry-payload storage, and
status recording for both providers. Extracted from the inline blocks in
``fetch_logs()`` to create a single deep module for all delivery concerns.
"""

import json
from datetime import UTC, datetime

import aiohttp

from app.config import get_settings


async def send_logs(webhook_url: str, n_item: int, payload: dict) -> int:
    """Deliver the alert payload to the n8n webhook; returns the HTTP status."""
    async with aiohttp.ClientSession() as session:
        async with session.post(webhook_url, json=payload, timeout=15) as response:
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] Found {n_item} rows."
            )
            result_msg = (
                "Success on"
                if response.status == 200
                else f"Error {response.status} while"
            )
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] "
                f"{result_msg} sending."
            )
            return response.status


async def deliver_msteams(
    log: dict,
    result: list[dict],
    matched_patterns: list[str],
    block_patterns: list[str],
    *,
    webhook_url: str | None = None,
) -> None:
    """Build and send the MS Teams Workflows Adaptive Card.

    Mutates ``log`` in-place to record ``msteams_preview``, ``msteams_payload``,
    ``msteams_status``, and ``msteams_error``. All failures are caught and
    logged — a Teams delivery failure must never break the poll.

    ``webhook_url`` (optional) is the System Settings override — it wins over
    the env var so a webhook configured in the UI actually drives delivery.
    """
    settings = get_settings()
    if not webhook_url:
        webhook_url = settings.msteams_webhook_url
    if not webhook_url:
        return

    try:
        from app.services.msteams import build_adaptive_card, send_msteams_alert

        # Collect unique domains and URLs from the grouped results
        all_domains: list[str] = []
        all_urls: list[str] = []
        first_client_ip = ""
        for doc in result:
            if not first_client_ip:
                first_client_ip = doc["client_ip"]
            all_domains.extend(doc.get("base_url", []))
            all_urls.extend(doc.get("url", []))
        # Deduplicate while preserving order
        seen_domains: set[str] = set()
        unique_domains: list[str] = []
        for d in all_domains:
            if d not in seen_domains:
                seen_domains.add(d)
                unique_domains.append(d)
        seen_urls: set[str] = set()
        unique_urls: list[str] = []
        for u in all_urls:
            if u not in seen_urls:
                seen_urls.add(u)
                unique_urls.append(u)

        # Show only patterns that actually matched, not the full DSL list
        effective_patterns = matched_patterns or block_patterns
        pattern_names = ", ".join(effective_patterns[:3])
        if len(effective_patterns) > 3:
            pattern_names += f" +{len(effective_patterns) - 3} more"

        log["msteams_preview"] = {
            "url": webhook_url[:60] + "..."
            if len(webhook_url) > 60
            else webhook_url,
            "client_ip": first_client_ip,
            "pattern_match": pattern_names,
            "domains_count": len(unique_domains),
            "urls_count": len(unique_urls),
            "base_url": settings.base_url or "(not set)",
        }
        print(
            f"[{datetime.now(UTC).isoformat()}][INFO] "
            f"MS Teams alert → {len(unique_domains)} domains, "
            f"{len(unique_urls)} urls, pattern={pattern_names}"
        )

        # Build and store MS Teams payload for retry
        msteams_card = build_adaptive_card(
            timestamp=datetime.now(UTC).isoformat(),
            client_ip=first_client_ip,
            pattern_match=pattern_names,
            target_domains=unique_domains,
            destination_urls=unique_urls,
            base_url=settings.base_url,
        )
        msteams_full_payload = {
            "type": "message",
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "contentUrl": None,
                    "content": msteams_card,
                }
            ],
        }
        try:
            log["msteams_payload"] = json.dumps(
                msteams_full_payload, default=str
            )
        except (TypeError, ValueError):
            pass

        msteams_status = await send_msteams_alert(
            webhook_url=settings.msteams_webhook_url,
            timestamp=datetime.now(UTC).isoformat(),
            client_ip=first_client_ip,
            pattern_match=pattern_names,
            target_domains=unique_domains,
            destination_urls=unique_urls,
            base_url=settings.base_url,
        )
        log["msteams_status"] = msteams_status
        print(
            f"[{datetime.now(UTC).isoformat()}][INFO] "
            f"MS Teams webhook response: status={msteams_status}"
        )
    except Exception as e:
        log["msteams_error"] = str(e)
        print(f"[{datetime.now(UTC).isoformat()}][WARN] MS Teams alert failed: {e}")


async def deliver_n8n(
    log: dict,
    payload: dict,
    total_sum: int,
    *,
    webhook_url: str | None = None,
) -> None:
    """Deliver the alert payload to the n8n webhook.

    Mutates ``log`` in-place to record ``webhook_status`` and ``webhook_error``.

    ``webhook_url`` (optional) is the System Settings override — it wins over
    the env var so a webhook configured in the UI actually drives delivery.
    """
    settings = get_settings()
    if not webhook_url:
        webhook_url = settings.webhook_url
    if not webhook_url:
        log["webhook_reason"] = "Webhook URL not configured — nothing sent"
        print(
            f"[{datetime.now(UTC).isoformat()}][INFO] "
            "Webhook URL not configured, skipping delivery."
        )
        return

    try:
        log["webhook_status"] = await send_logs(
            webhook_url, total_sum, payload
        )
    except Exception as e:
        log["webhook_error"] = str(e)
        print(f"[{datetime.now(UTC).isoformat()}][WARN] Webhook failed: {e}")
