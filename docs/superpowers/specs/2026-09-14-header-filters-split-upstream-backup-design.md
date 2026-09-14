# Design: header-embedded type-aware table filters, split upstream feeds, JSON backup/restore

Approved in chat (sections 1–4 + defaults: cut old env var immediately, exclude
credentials from backup). Classification: architectural (new subsystem: backup/restore;
shared-component interface change: DataTable header/filter contract).

## 1. Header-embedded popover filters (replaces the second filter row)

**Problem.** The per-column filter row below the header shows a distinct-values
dropdown per column. Timestamp columns explode into one option per row — unfilterable.

**Design.** Delete the second filter `<tr>` entirely. Each filterable `th` renders:
label + sort arrow (unchanged) + a small filter icon button. Click opens a popover
anchored in the header cell with the type-matched control + Clear/Apply. Active
filter = filled primary icon (keep the existing header filter-dot signal), focus
ring, `aria-label="Filter by X"`. Client-side filtering over current `data` before
sort/pagination (unchanged semantics); page-0 reset stays pagination-gated.
Non-filterable columns (checkbox, row actions, badge-only) render no icon.

**Interface.** `DataTableColumn<T>` gains optional
`filterType?: 'enum' | 'text' | 'datetime' | 'number'` (default `'enum'` preserves
current behavior where sensible; pages opt columns into the right type):

- `datetime` → from/to datetime-local inputs; row matches when accessor timestamp
  falls in `[from, to]` (open-ended when one side empty). Parse with `Date.parse`;
  non-parseable cell values never match an active datetime filter.
- `number` → min/max numeric inputs; same open-ended semantics.
- `enum` → distinct-values dropdown (the only place the current combobox survives:
  action, status, rule, pattern_type — low-cardinality columns).
- `text` → substring input (URL, IP, domain, hostname — case-insensitive).

**Annotation pass.** Set `filterType` on every table's columns once: Query
(timestamp→datetime, counts/durations→number, action→enum, url/ip/domain→text),
Findings, Patterns, Logs, Redirects, Analytics panels (top-clients: requests→number,
last_seen→datetime), Host/URL drill-downs. Blacklist page uses a custom card list
with its own search — out of scope, left as-is.

**Files.** `admin-ui/src/components/DataTable.tsx` (mechanism); per-page files gain
only `filterType` annotations. Taste: Notion tokens, sentence case, focus rings.

## 2. Split upstream feeds: domains + IPs

**Design.** Replace `UPSTREAM_BLACKLIST_URL` / `upstream_blacklist_url` with two
independent feeds (old var cut immediately — single consumer):

- `UPSTREAM_BLACKLIST_URLS` → `upstream_blacklist_urls: str = ""` (domains/hosts)
- `UPSTREAM_BLACKLIST_IPS` → `upstream_blacklist_ips: str = ""` (IPv4s)

Each empty value = that feed disabled. `sync_upstream_blacklist()` fetches every
configured feed (sequential, same 15s timeout + `uNetWatch-upstream-sync/1.0` UA +
1 MiB body cap per feed via the existing `_fetch_text`), normalizes each line,
`INSERT OR IGNORE ... source='upstream'` (existing `UNIQUE(kind, value)` dedups
across feeds and against manual entries — a host listed in both feeds or already
added manually is skipped, never duplicated). `sync_regenerate` on touched kinds.
Cross-feed duplicates reported in `skipped`, not errors.

**Status.** `get_upstream_status()` returns per-feed stats:
`{ enabled, urls_configured, ips_configured, last_sync, last_added, last_skipped,
last_errors, last_error, upstream_count, feeds: { urls: {...}, ips: {...} } }`.
Keep `enabled` + `url_configured` (back-compat alias) keys.

**Scheduler.** One 5-min job (`id="upstream-blacklist-sync", coalesce=True,
max_instances=1`) syncing both feeds + best-effort boot sync (unchanged pattern).

**Files.** `app/config.py`, `app/services/upstream_blacklist.py`,
`app/routes/blacklist.py` (sync/status routes unchanged in shape), `app/main.py`
(unchanged unless job wiring needs it), `.env.example` (document both vars),
`tests/test_upstream_blacklist.py` (rewrite env-var setup for two feeds + a
cross-feed-dedup test).

## 3. JSON backup/restore (no SQL, no credentials)

**Scope.** Admin-only backup of operator data as a downloaded JSON file:

- `GET /api/backup/export` (verify_admin) → `application/json` attachment
  `unetwatch-backup-YYYYMMDD-HHMMSS.json`, body:
  `{ version: 1, exported_at, patterns: [{pattern, pattern_type}],
    whitelist: [{pattern}], findings: [full rows minus id],
    blacklist: [{kind, value, source}], tracked_urls: [rows minus id],
    redirect_edges: [rows minus id] }`.
  Excluded: `monitor_logs` (noise), session tokens, and **all credentials**
  (ADMIN_*, API_KEY, ES creds, webhooks live in `.env`, restored via `.env`).
- `POST /api/backup/import` (verify_admin, JSON body, same shape +
  optional `dry_run: true`) → restores with `INSERT OR IGNORE` per table
  (natural UNIQUEs dedup: pattern, (client_ip,url,log_timestamp), (kind,value),
  url, (source_url,target_url)); returns `{ dry_run, added: {...}, skipped: {...} }`
  per section. Unknown `version` → 400. Never deletes.
- New `app/routes/backup.py`, mounted with `dependencies=[Depends(verify_admin)]`
  in `app/main.py`. Cap request body (~10 MiB) to bound import size.
- Frontend (`admin-ui/src/api.ts` + Logs page System area panel "Backup & restore"):
  Export button (downloads via blob, same pattern as Analytics CSV export),
  Restore file picker + dry-run preview (per-section counts) + confirm apply.
  Sentence case, Notion tokens, error toasts.
- Tests: export shape test (seeded rows appear, no secrets keys, monitor_logs
  absent), import round-trip (export→wipe→import→counts match), dry-run writes
  nothing, bad version 400, idempotent re-import (second import adds 0).

## 4. Verification

- `.venv/bin/python -m pytest -q` → all pass (207 baseline + new).
- `npm run build --prefix admin-ui`, `npm run lint --prefix admin-ui` clean.
- `ruff check` on touched backend files at pre-existing baseline.
- No commit in executors; driver commits + pushes after QA/validation.
