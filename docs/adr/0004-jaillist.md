# ADR 0004 — Jaillist (client-IP jail list)

**Status:** Accepted
**Date:** 2026-09-14

## Context

The blacklist answers "which **destinations** should the firewall block?" — it stores bare hosts and IPv4 destinations (`kind ∈ url, ip`). It cannot express the opposite decision: "which **source host** should be jailed?" An operator looking at a Findings row that a client IP produced repeatedly had no first-class way to record that client as a jail target, and no feed to hand to fail2ban.

The existing blacklist machinery already had everything needed for a second list: a normalizer, a UNIQUE-keyed table, atomic CRLF feed files regenerated on every mutation, a public plain-text feed route, upstream gist sync with per-feed stats, and JSON backup/restore. Reusing that shape keeps the operator's mental model ("a list, a feed, a gist") intact instead of inventing a parallel concept.

## Decision

- **A jaillist is a flat list of client IPs.** No `kind` column — sources are always IPs, so a `url` variant would be dead weight. The table is `jaillist_entries(id, value UNIQUE, source, finding_id, created_at)`.
- **Separate table and separate feed file** (`jail-ips.txt` at `/api/jaillist/ips.txt`) rather than a third `kind` on `blacklist_entries`. Mixing them would have forced every consumer of the destination feeds (`urls.txt`, `ips.txt`) to filter out source entries, and one compromised or wrong-signed list would be able to pollute the other's feed.
- **Normalization is IP-only and strict**: whitespace stripped, a single `:port` on IPv4 dropped, `ipaddress.ip_address` validation, canonical storage (IPv6 compressed). Hostnames, URLs, and CIDR ranges are rejected with `ValueError` → HTTP 400. Single IPs only — CIDR ranges are not supported, because the downstream consumers here (fail2ban / per-host nginx deny) act on addresses.
- **Upstream is a mirror of the blacklist's, one feed instead of two**: `UPSTREAM_JAILLIST_URLS` (a GitHub gist raw URL in practice), every 5 minutes, plus a best-effort boot sync. Shared fetch/parse helpers are imported from `upstream_blacklist` rather than duplicated, and its entries land with `source='upstream'` under `INSERT OR IGNORE` — idempotent, and manual/finding rows are never touched or deleted.
- **Add paths are global and contextual**: a header "Add Jail" dialog for anywhere-in-the-app capture, and a per-row **Jail client IP** action in Findings (plus a `Jailed` badge and a shared index) so the decision can be made at the moment the operator sees the client.
- **Backup carries the list** as a `jaillist` section with natural key `("value",)`. Unknown sources in a crafted file are coerced to `manual`, never trusted as `upstream` — same rule the blacklist section already applied.

## Consequences

- New: `app/services/jaillist.py`, `app/services/upstream_jaillist.py`, `app/routes/jaillist.py`, `JaillistPage.tsx`, `AddJaillistDialog.tsx`, plus one extracted component (`FeedCard` is exported from `BlacklistPage.tsx` and reused rather than copied).
- Sidebar Management group gains **Jaillist** after Blacklist; `View` union, stored-view allowlist, backup section list, and `CONTEXT.md` vocabulary/storage/pages sections all gain an entry — the same five places every list-like feature touches.
- Not in scope: a Query-page "exclude jailed" filter, analytics panels, and Host Inspector integration. The list is deliberately a data-plane primitive first; consumers can opt in later.
- Jails are enforcement-intent only. Nothing in the app yet verifies that a jailed IP actually stopped being seen — the feed is the contract.
