# Jailed badges + upstream fetch — implementation plan

## Context

uNetWatch jail/upstream feature follow-up. Backend already exposes
`POST /api/jaillist/upstream-sync`, `GET /api/jaillist/upstream-status` and
the blacklist equivalents (5-min scheduler + boot sync in `app/main.py`).
Frontend `admin-ui/src/api.ts` already has upstream helpers +
`getJaillistSet()`. `FindingsPage` already shows a `Jailed` badge.
Manual partial work on `main` (dirty): api helpers, `FeedCard` upstream
props + blacklist/jaillist wiring, broken QueryPage edit.

## Global Constraints

- No backend changes; reuse existing `POST /upstream-sync` + `GET /upstream-status` endpoints.
- `Badge variant="destructive"` for `Jailed`, matching `FindingsPage`.
- `FeedCard` upstream props are optional; existing select/copy/delete flows unchanged.
- Upstream status load is best-effort; feed lists render regardless.
- Combined sync call for blacklist (both feeds atomically); per-card status from `status.feeds[urls|ips]`.
- Verification: `pytest tests/test_upstream_jaillist.py tests/test_upstream_blacklist.py`, `npm run build` (`tsc`) in `admin-ui/`.
- No new deps. Follow existing patterns (`getJaillistSet`, `FeedCard`, toast).
- Commit per task. No subagents from implementers; implementer never spawns reviewers.

## Task 1 — Repair QueryPage and complete Jailed badge

Files: `admin-ui/src/components/QueryPage.tsx` (only; treat `admin-ui/src/api.ts` as read-only — helpers already exist).

Current breakage (from `git diff`): duplicated `useState` declarations for
`result/loading/error/drawerRow` and a broken Sankey collapse effect after a
bad edit around the QueryPage component head. The module-scope `queryUI`
already has `jailedIndex` and the `client_ip` cell already renders the badge.

Change:
1. Remove the duplicated `const [result...]`, `const [loading...]`, `const [error...]`, `const [drawerRow...]` block inserted before `esSearch`, keeping the original declarations.
2. Restore the Sankey auto-collapse `useEffect` on `timeRange` and the `queryUI.setResult`/`queryUI.jailedIndex` sync lines in correct order.
3. Keep: `getJaillistSet` import, `jailedIndex` state + best-effort load effect on mount, `queryUI.jailedIndex` sync, `Badge variant="destructive"` in `client_ip` cell.
4. Do not touch any other file.

Acceptance:
- `cd admin-ui && npm run build` passes (`tsc` clean, vite build succeeds).
- QueryPage shows `Jailed` badge for jailed client_ip; rows render when jaillist fetch fails.

## Task 2 — Verify Blacklist/Jaillist upstream fetch wiring

Files: `admin-ui/src/components/BlacklistPage.tsx`, `admin-ui/src/components/JaillistPage.tsx` (read-only on `admin-ui/src/api.ts` except to fix import/type errors if `tsc` reports them).

Current state: `FeedCard` has optional `upstream/upstreamSyncing/onFetchUpstream` props, status line, and Fetch button; `BlacklistPage` loads `getBlacklistUpstreamStatus()` and passes per-feed `UpstreamFeedState`; `JaillistPage` mirrors with `getJaillistUpstreamStatus()`.

Change:
1. Fix any `tsc` errors in these two files only (imports, types, props).
2. Ensure single combined load effect per page (no duplicate `load()` calls), `Fetch upstream` per card disabled when that feed unconfigured, toast + reload list + status after sync.
3. Do not change behavior of select/copy/delete flows.

Acceptance:
- `cd admin-ui && npm run build` passes.
- Each feed card shows Fetch upstream + status line; disabled with "not configured" hint when env empty; after sync the list and status refresh.

## Task 3 — HostInspector + URL investigation Jailed badges

Files: `admin-ui/src/components/HostInspectorPage.tsx`, `admin-ui/src/components/HostEntityCard.tsx`, `admin-ui/src/components/UrlInvestigationPage.tsx` (read-only on `admin-ui/src/api.ts` — use existing `getJaillistSet()`).

Change:
1. HostInspector: best-effort `getJaillistSet()` lookup for the inspected IP; show `Badge variant="destructive"` labeled `Jailed` in the header next to the IP (both live and findings branches). Fail-closed to no badge.
2. UrlInvestigationPage: best-effort jailed index; add `Jailed` badge next to `client_ip` in the per-URL clients table.
3. Reuse the Findings/Query badge pattern; no new endpoints.

Acceptance:
- `cd admin-ui && npm run build` passes.
- Jailed host shows badge in HostInspector header; jailed client_ip rows show badge in URL investigation; unjailed shows nothing; pages render when jaillist fetch fails.
