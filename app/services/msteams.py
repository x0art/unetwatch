"""Microsoft Teams Workflows Webhook integration.

Sends Adaptive Card notifications when the monitor poll detects
threat activity (block-pattern matches after filtering).

The card template follows the Microsoft Teams Workflows (Power Automate)
Outgoing Webhook format:
  https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using
"""

import logging
from datetime import UTC, datetime

log = logging.getLogger("unetwatch.msteams")


def build_adaptive_card(
    timestamp: str,
    client_ip: str,
    pattern_match: str,
    target_domains: list[str],
    destination_urls: list[str],
    base_url: str = "",
) -> dict:
    """Build a Microsoft Teams Workflows Adaptive Card payload.

    The card includes:
      - Security Alert header (red/Attention)
      - Timestamp, Client IP, Pattern Match as facts
      - Target domains (monospace, in an emphasis container)
      - Destination URLs (monospace, in an emphasis container)
      - Action buttons: Block Source IP, Block Domain, Add to Whitelist
    """
    # Truncate long lists for readability
    domains_text = "\n".join(target_domains[:20])
    if len(target_domains) > 20:
        domains_text += f"\n… +{len(target_domains) - 20} more"

    urls_text = "\n".join(destination_urls[:20])
    if len(destination_urls) > 20:
        urls_text += f"\n… +{len(destination_urls) - 20} more"

    # Build action URLs using the base_url from settings
    block_ip_url = f"{base_url}/blockDomain?url={client_ip}" if base_url else ""
    block_domain_url = (
        f"{base_url}/blockDomain?url={','.join(target_domains[:10])}"
        if base_url and target_domains
        else ""
    )
    whitelist_url = (
        f"{base_url}/whitelistDomain?url={','.join(destination_urls[:10])}"
        if base_url and destination_urls
        else ""
    )

    actions = []
    if block_ip_url:
        actions.append({
            "type": "Action.OpenUrl",
            "title": "Block Source IP",
            "style": "destructive",
            "url": block_ip_url,
        })
    if block_domain_url:
        actions.append({
            "type": "Action.OpenUrl",
            "title": "Block Domain",
            "style": "destructive",
            "url": block_domain_url,
        })
    if whitelist_url:
        actions.append({
            "type": "Action.OpenUrl",
            "title": "Add to Whitelist",
            "style": "positive",
            "url": whitelist_url,
        })

    card = {
        "type": "AdaptiveCard",
        "version": "1.5",
        "body": [
            {
                "type": "TextBlock",
                "text": "Security Alert",
                "weight": "Bolder",
                "size": "Large",
                "color": "Attention",
            },
            {
                "type": "TextBlock",
                "text": "Policy Violation & Outbound Threat Detected",
                "isSubtle": True,
                "wrap": True,
                "spacing": "None",
            },
            {
                "type": "FactSet",
                "spacing": "Medium",
                "facts": [
                    {"title": "Timestamp:", "value": timestamp},
                    {"title": "Source Client IP:", "value": client_ip},
                    {"title": "Pattern Match:", "value": pattern_match},
                ],
            },
            {
                "type": "TextBlock",
                "text": "Target Domains",
                "weight": "Bolder",
                "size": "Medium",
                "spacing": "Medium",
            },
            {
                "type": "Container",
                "style": "emphasis",
                "items": [
                    {
                        "type": "TextBlock",
                        "text": domains_text or "None",
                        "fontType": "Monospace",
                        "wrap": True,
                    }
                ],
            },
            {
                "type": "TextBlock",
                "text": "Destination URLs",
                "weight": "Bolder",
                "size": "Medium",
                "spacing": "Medium",
            },
            {
                "type": "Container",
                "style": "emphasis",
                "items": [
                    {
                        "type": "TextBlock",
                        "text": urls_text or "None",
                        "fontType": "Monospace",
                        "size": "Small",
                        "wrap": True,
                    }
                ],
            },
        ],
    }

    if actions:
        card["actions"] = actions

    return card


async def send_msteams_alert(
    webhook_url: str,
    timestamp: str,
    client_ip: str,
    pattern_match: str,
    target_domains: list[str],
    destination_urls: list[str],
    base_url: str = "",
) -> int:
    """Send an Adaptive Card to Microsoft Teams Workflows webhook.

    Returns the HTTP status code from the webhook response.
    """
    import aiohttp

    card = build_adaptive_card(
        timestamp=timestamp,
        client_ip=client_ip,
        pattern_match=pattern_match,
        target_domains=target_domains,
        destination_urls=destination_urls,
        base_url=base_url,
    )

    # Teams Workflows webhooks expect the Adaptive Card content directly
    # at the top level (not wrapped in an attachments array, which is the
    # format for Office/Outlook connectors).
    payload = card

    async with aiohttp.ClientSession() as session:
        async with session.post(webhook_url, json=payload, timeout=15) as response:
            status = response.status
            if status == 200:
                log.info("MS Teams alert sent successfully")
            else:
                body = await response.text()
                log.warning("MS Teams webhook returned %s: %s", status, body)
            return status
