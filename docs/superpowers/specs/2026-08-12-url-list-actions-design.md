# Row-level list actions for Traffic & Query URL tables

Date: 2026-08-12
Status: Approved (autopilot)

## Goal

From any URL row on the Traffic page (Access flows table) and the Query page (results
table), an operator can add that URL's host to the **Blacklist** or to a **Whitelist
pattern** with at most two clicks.

## Scope decisions

- **Two lists, not three.** "Blocklist" in the original request is a synonym for the
  existing Blacklist (`blacklist_entries` table, `kind = url|ip`, feeds `/api/blacklist/*.txt`
  to nginx/fail2ban). "Whitelist" targets the existing *patterns* system
  (`pattern_type = "whitelist"` in the patterns table). No new list, table, endpoint,
  or feed is introduced.
- **Blacklist stores the bare host.** `normalize_blacklist_value` already reduces any
  URL to its bare host, matching the Blacklist page's documented behavior
  ("Entries are stored as bare hosts"). The action sends the row's `base_url` (already
  an FQDN on both pages) to `POST /api/blacklist/`.
- **Whitelist opens the existing `AddPatternDialog`**, prefilled with the host as the
  pattern and `pattern_type` preselected to `"whitelist"`. The operator can widen the
  pattern (e.g. `*.example.com`) before saving — identical UX to the Findings page's
  whitelist action.
- **No sankey popover actions.** Traffic sankey nodes merge multiple flows and are
  aggressively recentered/zoomed; menus there conflict with drag/tooltip hit areas.
  The flows table covers the same hosts. Deferred (YAGNI).
- **No bulk selection in this round.** Per-row actions first; a bulk action bar can
  layer on later if mass triage becomes a real need.

## Components

### 1. `admin-ui/src/components/ListActionDropdown.tsx` (new)

Payload prop: `{ baseUrl: string }`.

- Renders a compact icon button (`Ban` icon with `ChevronDown` suffix, matching the Blacklist page iconography) opening a menu with:
  - **Add host to Blacklist** — calls `addBaseUrlToBlacklist(baseUrl)` (existing helper
    in `admin-ui/src/api.ts`). Toast feedback via existing `useToast`:
    - `added.length > 0` → success: "`<host>` added to blacklist"
    - `added.length === 0` (duplicate, HTTP 200) → info: "`<host>` already on blacklist"
    - HTTP 400 → error toast with server `detail`.
  - **Whitelist this host…** — opens `AddPatternDialog` with `pattern = baseUrl` and
    `initialPatternType = "whitelist"` (new optional prop, see below). On successful
    creation the dialog already toasts; the dropdown closes it.
- Owns its pending state (the blacklist button/menu item is disabled while a request
  is in flight) and the dialog's open state, so host pages drop in a single element.
- Built from the same primitives the UI kit already uses (`DropdownMenu` from
  radix, `lucide-react` icons) to match existing look/feel.

### 2. `admin-ui/src/components/AddPatternDialog.tsx` (one-line change)

- New optional prop `initialPatternType?: "block" | "whitelist"` (default `"block"`).
- Applied in the open/reset `useEffect` alongside `setPattern("")`, so a fresh dialog
  preselects the requested type. All existing callers (which don't pass the prop) are
  unaffected.

### 3. `admin-ui/src/components/TrafficPage.tsx`

- Access flows table gains a narrow rightmost "Actions" column.
- Each flow row renders `<ListActionDropdown baseUrl={flow.base_url} />` alongside the
  existing `CopyUrlButton`. `flow.base_url` is already grouped-by-host FQDN (per recent
  commits d1d5844/7afd7fc), so what the operator sees is what gets stored.

### 4. `admin-ui/src/components/QueryPage.tsx`

- Results table gains the same Actions column, per `QueryDoc` row, using `doc.base_url`.
- After a successful blacklist add, that row's local state is updated
  (`blacklisted: true, blacklist_source: "url"`) so the existing shield badge flips
  immediately without re-running the ES query.
- The `whitelisted` flag is NOT flipped locally after a whitelist add — it reflects
  live ES pattern matching and only updates on query re-run. (Honest behavior; no
  stale-state risk.)

### 5. Traffic sankey (`TrafficSankey.tsx`)

No changes this round (see Scope decisions).

## Data flow

```
Traffic/Query row (baseUrl = FQDN)
  ├─ "Add host to Blacklist" → POST /api/blacklist/ {value: baseUrl}
  │    → normalize_blacklist_value → (kind=url, bare host)
  │    → INSERT OR IGNORE blacklist_entries → sync_regenerate(urls.txt)
  │    → toast (+ QueryPage local badge flip)
  └─ "Whitelist this host…" → AddPatternDialog(pattern=baseUrl, type=whitelist)
       → POST /api/patterns/ {pattern, pattern_type: "whitelist"} → toast
```

## Error handling

- Blacklist duplicate → informational toast, not an error.
- Blacklist invalid value (400) → error toast with server detail.
- Whitelist duplicate pattern → handled by the patterns endpoint/dialog as today.
- Network/session failure → error toast; no partial local state changes.

## Testing

- Backend: no new endpoints or models → existing `pytest` suite and `ruff check` must
  stay green.
- Frontend: `npm run build` (tsc) must be clean.
- Manual verification checklist:
  1. Traffic flows row → Add to Blacklist → entry appears on Blacklist page URL feed
     and in `GET /api/blacklist/urls.txt`.
  2. Query results row → Add to Blacklist → row's blacklist badge flips immediately.
  3. Both pages → Whitelist action → dialog opens prefilled with host and type
     "whitelist"; saving creates a whitelist pattern visible on the Patterns page.
  4. Re-adding the same host → "already on blacklist" info toast, no duplicate row.

## Explicitly out of scope

- New third list ("Blocklist" as distinct entity), new endpoints, DB migrations,
  feed/monitor logic changes.
- Bulk row selection / bulk add-to-list.
- Sankey node context menus.
