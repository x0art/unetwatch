# ADR 0002 — Page Consolidation

**Status:** Accepted
**Date:** 2026-09-04

## Context

The app accumulated overlapping surfaces. Live Monitor and Query both showed live traffic with similar filters. The Traffic/Graph page embedded two drill-downs (per-client radial and per-URL view). Client drill-down duplicated what Host Inspector was built to do. URL investigation was buried inside the Graph page. Analytics carried a host-group/department selector that was a no-op, and had no raw-data view. Host Inspector showed IP→person identity (MAC, dept, user) that the product explicitly does not want.

## Decision

- **Live Monitor removed** — Query becomes the single live/traffic surface and inherits Live Monitor's unique features: auto-refresh, the 4-column flow Sankey, and row inspection (InspectionDrawer).
  - Query's 4-column Sankey column order is fixed as **Pattern → Sources → Domain → Destinations** (replacing the earlier Sources → Patterns → Domains → Destinations).
- **Traffic/Graph page removed** — its aggregate diagram is superseded by Query's flow view + the URL Investigation page.
- **Client drill-down removed** — superseded by Host Inspector.
- **New URL Investigation page** (Deep Dive group) — paste/search a URL → every client that hit it (when, action, risk status, whitelist/blacklist status), actions to whitelist/blacklist it, each client cross-links into Host Inspector. Absorbs the Graph per-URL view, `GET /api/findings/url/{url}`, and the per-URL client-IPs table.
- **Host Inspector enhanced** — identity card removed (host = IP + hostname only); per-host risk summary (ALLOW risks vs enforced/denied) + bandwidth; ranked URL list linking to URL Investigation; keep timeline/anomaly, top destinations, rule matches, log table, export; per-host whitelist/blacklist actions; backed by a real `GET /api/hosts/{ip}`.
- **Analytics** — drop the host-group/department selector; add a raw-data table (filterable + exportable); align the date-range control with the app's presets; reframe DENY as "Enforcements (handled)".
- **Identity**: no IP→person/department/MAC attribution anywhere. The `HostEntityCard` identity row and its synthetic fallbacks are deleted.

## Consequences

- Sidebar becomes: **Monitor** (Dashboard, Query) · **Deep Dive** (Host Inspector, URL Investigation, Analytics) · **Management** (Patterns, Findings, Redirects, Blacklist) · **System** (Logs).
- Removed pages: `LiveMonitorPage`, `GraphPage`; `MetricCards`, `SankeyDiagram` (4-col) move into Query; `InspectionDrawer`/`LogInspector` stay on Query.
- Backend: analytics host-group no-op removed; new hosts + URL-investigation endpoints.
