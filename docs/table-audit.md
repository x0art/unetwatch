# Table-component audit — `admin-ui/src/`

Scope: every page/component in `admin-ui/src/components/` that renders a tabular
surface, plus the shared `DataTable` and the table primitives in `ui.tsx`.
Every claim below is anchored to a `file:line` quote. Sizes are `wc -l`.

All paths are relative to `admin-ui/src/components/` unless stated otherwise.

---

## 1. Inventory

| # | File | Uses shared `DataTable`? | Table code lines | Markup kind | `wc -l` |
|---|------|--------------------------|------------------|-------------|---------|
| 1 | `DataTable.tsx` | — (it *is* the shared table) | `764-950` `<table>`; column model `76-99`; filter engine `592-641` | shared | 972 |
| 2 | `PatternTable.tsx` | ✅ `import { DataTable … }` L21, `<DataTable>` L355-395 | columns `52-127` | shared | 490 |
| 3 | `BlacklistPage.tsx` | ❌ none (no `<table>`) | `FeedCard` `<ul>` `211-250` (def `95-276`) | hand-rolled `<ul>` list | 692 |
| 4 | `JaillistPage.tsx` | ❌ none (renders `FeedCard`) | `<FeedCard …>` L304-325 | hand-rolled `<ul>` via `FeedCard` | 386 |
| 5 | `WhitelistDomainPage.tsx` | ❌ hand-rolled | `180-264` | `<table>` (edit-review list) | 305 |
| 6 | `BlockDomainPage.tsx` | ❌ hand-rolled | `203-287` | `<table>` (edit-review list) | 327 |
| 7 | `RedirectsPage.tsx` | ✅ L40, `<DataTable>` L806-847 | columns `95-212` | shared | 932 |
| 8 | `LogsPage.tsx` | ✅ L42, `<DataTable>` L700-734; **plus** hand-rolled `<table>` L475-496 | columns `84-244` | shared + hand-rolled | 980 |
| 9 | `QueryPage.tsx` | ✅ L48, `<DataTable>` L1120-1172 | columns `154-414` | shared | 1191 |
| 10 | `FindingsPage.tsx` | ✅ L42, `<DataTable>` L638-676 | columns `85-284` | shared | 718 |
| 11 | `HostInspectorPage.tsx` | ✅ L19, `<DataTable>` ×5 at L1160-1178, L1219, L1222, L1227, L1241 | columns `678`, `863`, `870`, `875`, `885` | shared | 1248 |
| 12 | `AttckFleetPage.tsx` | ❌ hand-rolled | `209-259`, `267-308` | two `<table>`s | 338 |
| 13 | `ReportPage.tsx` | ❌ hand-rolled (`IndicatorTable`) | `63-100` (impl), instances `404`, `418`, `431`, `455` | `<table>` | 588 |
| 14 | `AnalyticsPage.tsx` | ✅ L30, `<DataTable>` L700, L715, L764 | columns `258`, `306`, `350` | shared | 787 |
| 15 | `TopDestinations.tsx` | ❌ hand-rolled | `71-116`, `135-164` | two `<table>`s | 169 |
| 16 | `ui.tsx` — `RankedTable` | ❌ hand-rolled primitive | `641-683` | `<table>` | 781 |
| 17 | `ui.tsx` — `Pagination` | N/A (shared pager) | `728-768` | none | 781 |

Also contains a `DataTable` but not on the task list: `UrlInvestigationPage.tsx`
L35 import, `<DataTable>` L342, columns L189, 496 lines.

`<table>` tags appear only in: `DataTable.tsx:764`, `LogsPage.tsx:475`,
`WhitelistDomainPage.tsx:180`, `BlockDomainPage.tsx:203`, `AttckFleetPage.tsx:209/267`,
`ReportPage.tsx:77`, `TopDestinations.tsx:71/135`, `ui.tsx:647`.

---

## 2. Column inventory (current on-screen left→right order)

Column ids/labels are quoted exactly as written in code. The shared `DataTable`
prepends a checkbox column when `selectable` (`DataTable.tsx:767-775`).

### 2.1 `DataTable`-based

**PatternTable** (`PATTERNS_COLUMNS`, `PatternTable.tsx:52-125`)
1. `id` / "ID" — row primary key; mono int.
2. `pattern` / "Pattern" — the block/whitelist pattern string.
3. `pattern_type` / "Type" — Badge Block vs Whitelist.
4. `created_at` / "Created" — creation date, `toLocaleDateString()`.
5. `actions` / sr-only "Actions" — edit + delete icon buttons.

**RedirectsPage** (`REDIRECTS_COLUMNS`, `RedirectsPage.tsx:95-212`)
1. `id` / "ID" — PK.
2. `url` / "URL" — tracked source URL + copy.
3. `status` / "Status" — `STATUS_META[i.status]` badge.
4. `http_status` / "HTTP" — last HTTP code.
5. `final_url` / "Final URL" — resolved target (— when same as source).
6. `source` / "Source" — manual/finding/auto badge.
7. `last_checked_at` / "Last checked" — relative check time.
8. `history_count` / "Targets" — number of distinct targets seen.
9. `actions` / sr-only "Actions" — check/history/delete menu.

**LogsPage** (`LOGS_COLUMNS`, `LogsPage.tsx:84-244`)
1. `started_at` / "Time" — run timestamp.
2. `kind` / "Type" — Poll vs Query badge.
3. `minutes` / "Window" — window length in minutes (— when null).
4. `matches` / "Hits" — ES match count.
5. `stored` / "Stored" — stored rows (— for query kind).
6. `suppressed` / "Suppressed" — `suppressed_rows` count.
7. `monitored_dests` / "Monitored dests" — `suppressed_blacklisted` count.
8. `flagged` / "Flagged URLs" — first flagged URL + `+n` badge.
9. `webhook_status` / "Webhook" — `WebhookBadge`.
10. `duration_ms` / "Duration" — formatted run duration.
11. `error` / "Outcome" — error text or green "OK".
12. `actions` / sr-only "Actions" — view-detail button.

**QueryPage** (`QUERY_COLUMNS`, `QueryPage.tsx:154-414`)
1. `timestamp` / "Timestamp" — event time.
2. `client_ip` / "Client IP" — source IP + jailed badge.
3. `server_ip` / "Server IP" — dest IP.
4. `url` / "URL" — full URL.
5. `base_url` / "Base URL" — base_url, falling back to `category`.
6. `bytes_downloaded` / "↓ Bytes" — formatted download size.
7. `bytes_uploaded` / "↑ Bytes" — formatted upload size.
8. `duration` / "Duration" — `duration_seconds` in seconds.
9. `action` / "Action" — ALLOW/DENY badge.
10. `accounting_tag` / "Type" — Enforcement vs New.
11. `domain` / "Dest domain" — `getDestDomain(d)`.
12. `pattern` / "Pattern" — `blocked_by[]` joined.
13. `coverage` / "Lists" — Blacklist risk / Whitelist / Blacklist / None.
14. `actions` / sr-only "Actions" — `ListActionCell` menu.

**FindingsPage** (`FINDINGS_COLUMNS`, `FindingsPage.tsx:85-284`)
1. `id` / "ID" — PK.
2. `client_ip` / "Client IP" — source IP + jailed badge.
3. `server_ip` / "Server IP" — dest IP.
4. `url` / "URL" — full URL.
5. `base_url` / "Base URL" — base_url + list badges.
6. `pattern` / "Pattern" — parsed `matched_patterns`.
7. `accounting_tag` / "Type" — Enforcement vs New.
8. `log_timestamp` / "Detected" — detection time.
9. `actions` / sr-only "Actions" — action menu (+track/jail/delete).

**HostInspectorPage**
- `logColumns` (L678) — 1. `timestamp`/Timestamp · 2. `url`/"Full URL / dest domain" · 3. `dest_ip`/Dest IP · 4. `method`/Method · 5. `status`/Status · 6. `bytes`/"↓/↑ Bytes" · (continues to L~800).
- `domainColumns` (L863) — 1. `domain`/Domain · 2. `count`/Requests · 3. `volume`/Volume · 4. `pct`/"% total".
- `patternColumns` (L870) — 1. `pattern`/Pattern · 2. `hits`/Hits.
- `urlColumns` (L875) — 1. `url`/URL · 2. `count`/Hits.
- `rawColumns` (L885) — 1. `log_timestamp`/Timestamp · 2. `url`/URL · 3. `base_url`/Domain · 4. `pattern`/Pattern · 5. `volume`/Volume (Real/Estimated badge).

**AnalyticsPage**
- `domainColumns` (L258) — 1. `domain`/Domain · 2. `count`/Requests · 3. `volume`/Volume · 4. `pct`/"% total".
- `clientsColumns` (L306) — 1. `client_ip`/Client IP · 2. `count`/Requests · 3. `last_seen`/Last seen.
- `rawColumns` (L350) — 1. `log_timestamp`/Timestamp · 2. `client_ip`/Client IP · 3. `url`/URL · 4. `base_url`/Domain · 5. `action`/Action · 6. `pattern`/Pattern · 7. `volume`/Volume (L~470).

### 2.2 Hand-rolled

**BlacklistPage `FeedCard`** (`BlacklistPage.tsx:212-260`) — not a column model; a
single-value `<li>` row: `[checkbox?] · value (EDL-formatted for url kind) · CopyUrlButton · delete`.
**JaillistPage** reuses the identical `FeedCard` (`JaillistPage.tsx:312`).

**WhitelistDomainPage** (`180-264`)
1. "#" — `idx + 1` ordinal.
2. "Pattern" — value, editable inline.
3. "Actions" — Save/Cancel or Edit/Remove.

**BlockDomainPage** (`203-287`) — identical: "#", "Value", "Actions".

**AttckFleetPage** table 1 (`209-259`): "Technique ID", "Name", "Severity",
"Hosts", "Example hosts".
Table 2 (`267-308`): "Host", "Requests", "Risk share", "Techniques".

**ReportPage `IndicatorTable`** (`ReportPage.tsx:63-100`; instances L404/418/431/455)
- "Top domains" (L404): Domain, Count(right), Share(right).
- "Top patterns" (L418): Pattern, Hits(right).
- "Top URLs" (L431): URL, Count(right).
- "Clients" (L455): Client IP, Accesses(right), Last seen.

**LogsPage backup preview** (`475-496`): "Section", "Would add"/"Added", "Skipped".

**TopDestinations** table 1 (`71-116`): "#", "Domain", "Share".
Table 2 (`135-164`): "Pattern", "Hits".

**`ui.RankedTable`** (`ui.tsx:641-683`): "#", "Label", "Count".

---

## 3. Breakage evidence

### 3.1 CONFIRMED BUG — AnalyticsPage raw table paginates twice; pages ≥ 2 render empty

`AnalyticsPage.tsx:185-205` fetches exactly one server page:

```
191:      const res = await getFindings({
192:        search: rawSearch.trim() || undefined,
193:        minutes: RANGE_MINUTES[range] ?? 1440,
194:        limit: rawPageSize,
195:        offset: rawPage * rawPageSize,
196:      })
```

but the table is mounted with `internalPagination` (`AnalyticsPage.tsx:768`):

```
765:            data={rawUniqueDomains ? dedupeByDomain(raw) : raw}
769:            internalPagination
770:            total={rawTotal}
771:            page={rawPage}
772:            pageSize={rawPageSize}
```

With `internalPagination`, `DataTable` slices the already-page-sized array
(`DataTable.tsx:707-711`):

```
707:    if (!internalPagination || !hasPagination) return sortedData
708:    const size = pageSize ?? 25
709:    return sortedData.slice(page! * size, (page! + 1) * size)
```

On `rawPage = 1`, `raw` holds 50 rows (server rows 50–99) and the slice is
`slice(50,100)` → `[]`, so `data.length === 0` (`DataTable.tsx:887`) and the
empty state renders (`DataTable.tsx:887-898`) even though `rawTotal` is non-zero.

Pages ≥ 2 are unreachable in the UI. `HostInspectorPage`'s equivalent raw table
passes the same two props *without* `internalPagination`
(`HostInspectorPage.tsx:1241`), which is the correct server-mode usage — proving
the AnalyticsPage mount is the outlier.

### 3.2 CONFIRMED BUG — `Pagination` "Last page" button is a dead control in server mode without `total`

`ui.tsx:734` computes `totalPages = hasTotal ? … : 0`, and the last-page button
(`ui.tsx:764`) calls `go(totalPages - 1)`:

```
734:  const totalPages = hasTotal ? Math.max(1, Math.ceil(total! / pageSize)) : 0
764:        <Button … disabled={!canNext} onClick={() => go(totalPages - 1)} aria-label="Last page">
```
`go` guards `p < 0` (`ui.tsx:740`), so when `total` is absent the button calls
`go(-1)` and does nothing. No current caller omits `total` (all pass it:
`LogsPage.tsx:724`, `FindingsPage.tsx:678`, `HostInspectorPage.tsx:1175`), so
this is latent, not user-visible today.

### 3.3 CONFIRMED INCONSISTENCY — LogsPage "Stored" sorts/filters on a value it hides for query rows

Accessor is unconditional (`LogsPage.tsx:130-134`):

```
130:    id: "stored",
131:    header: "Stored",
132:    filterType: "number",
134:    accessor: (l) => l.stored,
```
but the cell renders `—` for `kind !== "poll"` (`LogsPage.tsx:136`):

```
136:        {l.kind === "poll" ? l.stored.toLocaleString() : "—"}
```
Sorting by "Stored" therefore orders rows by a numeric value the UI hides, and a
numeric range filter admits rows whose cell shows "—". (The neighbouring
`minutes`/`suppressed`/`monitored_dests` columns are *not* affected: their cells
hide only `null`/`undefined`, which is exactly what their accessors return, so
sort and filter agree with the display — `LogsPage.tsx:108-121`, `143-166`.)

### 3.4 POTENTIAL — QueryPage row id is not guaranteed unique (React key / selection collision)

`queryRowId` is a 3-field composite (`QueryPage.tsx:120-122`):

```
120:function queryRowId(d: QueryDoc): string {
121:  return `${d.timestamp}|${d.client_ip}|${d.url}`
122:}
```
`QueryDoc` carries `accounting_tag`, so one request can produce both a `new` and
an `enforcement` row with identical timestamp+client+url (`api.ts:208-237`).
Two such rows yield the same `key` (`DataTable.tsx:914` `const id = rowId(row)`,
`:919` `key={id}`) and the same `rowId` fed to selection
(`DataTable.tsx:932` `onChange={() => toggleSelectOne(id)}`) — colliding React
keys and a checkbox that toggles both rows at once. Provable from the data model;
I did not observe a runtime instance.

### 3.5 NOTE (not a defect) — module-scope column state mutated during render

`PATTERNS_UI`/`LOGS_UI`/`REDIRECTS_UI`/`queryUI` are written in the render body,
e.g. `PatternTable.tsx:316-318`, `LogsPage.tsx:628-629`,
`RedirectsPage.tsx:633-637`, `QueryPage.tsx:587-595`. This is a deliberate
"referentially-stable columns" pattern and it works (TypeScript is clean), but
it is a render-phase side effect that React Strict Mode double-invokes; not
user-visible breakage.

### 3.6 Tables that render correctly

All of the following are internally consistent (accessors match the declared
types, filter types match the data, sort comparisons are type-correct):
`PatternTable` (accessors `p.id/p.pattern/p.pattern_type/p.created_at` vs
`Pattern`), `RedirectsPage` (`TrackedUrl`, incl. `STATUS_META`/`SOURCE_META`
keyed by the union at `RedirectsPage.tsx:47-64` vs `api.ts:143-154`),
`FindingsPage`, `QueryPage`, `HostInspectorPage` (log/domain/pattern/url/raw),
`AnalyticsPage` `domainColumns`/`clientsColumns`, `LogsPage` main table,
`BlacklistPage`/`JaillistPage` `FeedCard`, `WhitelistDomainPage`,
`BlockDomainPage`, `AttckFleetPage` (both tables — `FleetHostSummary.risk_share`
is non-optional at `api.ts:2365`, so `risk_share * 100` is safe),
`ReportPage.IndicatorTable`, `TopDestinations`, `ui.RankedTable`.
`tsc --noEmit -p tsconfig.app.json` exits 0 — **no TypeScript errors**.

---

## 4. Consistency matrix

Legend: ✅ present · ❌ absent · N/A not applicable.

Feature keys: **Sort** = sortable columns · **Filt** = per-column header filters ·
**Vis** = column visibility toggling · **Rsz** = column resizing ·
**Reord** = column reordering · **Sel** = row selection · **Bulk** = bulk-action bar ·
**Pag** = pagination · **Stky** = sticky header · **Dens** = density control ·
**Exp** = row expansion · **CSV** = CSV export · **View** = saved views ·
**Keys** = keyboard navigation.

| Table | Sort | Filt | Vis | Rsz | Reord | Sel | Bulk | Pag | Stky | Dens | Exp | CSV | View | Keys |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `DataTable` (shared) | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ header buttons/aria-sort only |
| PatternTable | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| RedirectsPage | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| LogsPage (main) | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| QueryPage | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ (internal) | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ + row click |
| FindingsPage | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| HostInspector (log) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| HostInspector (dom/pat/url/raw) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ (raw: ✅) | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| Analytics (dom/clients) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| Analytics (raw) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (broken, §3.1) | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| BlacklistPage `FeedCard` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | N/A (capped list) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| JaillistPage `FeedCard` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| WhitelistDomainPage | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | N/A | ❌ | ❌ | ❌ (inline edit) | ❌ | ❌ | ❌ |
| BlockDomainPage | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | N/A | ❌ | ❌ | ❌ (inline edit) | ❌ | ❌ | ❌ |
| AttckFleetPage (t1) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| AttckFleetPage (t2) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ReportPage `IndicatorTable` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ (`.slice(0,10/25)`) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| LogsPage backup preview | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | N/A | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| TopDestinations (t1/t2) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `ui.RankedTable` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (Enter/Space when `onRowClick`) |

Notes on "keyboard navigation": no table implements roving-row focus or arrow-key
navigation. `DataTable` header buttons are real `<button>`s (tabbable) and expose
`aria-sort` (`DataTable.tsx:788-793`) and focus rings; `RankedTable` rows are
`tabIndex={0}` with Enter/Space handling (`ui.tsx:673-676`); the LogsPage backup
preview's `<th>` elements carry `scope="col"` (`LogsPage.tsx:478-482`). Nothing
offers full grid keyboard support, hence ⚠️/❌.

No table anywhere in the codebase has: column visibility toggles, resizing,
reordering, sticky headers, density control, row expansion panels (QueryPage row
click opens `EventInspectorSidebar`, not an in-row expansion), CSV export, or
saved views. CSV export and saved views do not exist in the shared `DataTable`
API at all (`DataTableProps`, `DataTable.tsx:110-165`).

---

## 5. Reuse map — hand-rolled tables that could migrate to `DataTable`

For each target, the `DataTableColumn<T>[]` shape and the props required.

### 5.1 High value — AttckFleetPage (two tables)

`AttckFleetPage.tsx:209-259` (`FleetTechnique`) and `:267-308`
(`FleetHostSummary`). Both are pure `<table>`s over typed arrays with no
selection/pagination.

- `FleetTechniqueColumns: DataTableColumn<FleetTechnique>[]` — `technique_id`
  (text), `name` (text, cell shows `tech.name` with `title={tech.description}`),
  `severity` (enum → falls back to `Badge`), `host_count` (number, right),
  `example_hosts` (cell renders the clickable IP chips + `+n more`).
- `FleetHostColumns: DataTableColumn<FleetHostSummary>[]` — `client_ip` (cell
  with `openHost` button), `total_requests` (number, right),
  `risk_share` (number, cell `(risk_share*100).toFixed(1)%`), `techniques`
  (cell renders `Badge` list).
- Props needed: `columns`, `data={mapping.techniques}` /
  `data={mapping.host_summaries.filter(h => h.techniques.length > 0)}`,
  `rowId={(t) => t.technique_id}` / `rowId={(h) => h.client_ip}`,
  `empty={{ icon: ShieldCheck, title: … }}`. No `selectable`, no pagination.
- Gains: sortable severity/host_count/requests/risk_share, enum + numeric header
  filters (e.g. filter fleet techniques by severity), consistent empty state.
- Blocker: none — `example_hosts`/`techniques` are rendered in a `cell` function.

### 5.2 High value — ReportPage `IndicatorTable` (4 instances)

`ReportPage.tsx:404/418/431/455`. The component already exists precisely to
deduplicate four near-identical tables (`ReportPage.tsx:59-62`), so it is the
clearest candidate. Four generic mounts:

- `Column<ClientReportTopDomain>` — `domain` (text), `count` (number, right,
  `toLocaleString`), `pct` (number, right, `pct.toFixed(1)+"%"`).
- `Column<ClientReportTopPattern>` — `pattern` (text), `hits` (number, right).
- `Column<ClientReportTopUrl>` — `url` (text, truncate w/ title), `count` (number, right).
- `Column<UrlClientCount>` — `client_ip` (text), `count` (number, right),
  `last_seen` (datetime).
- Props: same four `data=` arrays currently passed (`report.data.top_domains`,
  `top_patterns`, `top_urls`; `breakdown.data.clients`), `rowId` per entity,
  `empty={{ icon: …, title: "No data in window" }}`.
- Caveat: the current instances `.slice(0, 10)` / `.slice(0, 25)`
  (`ReportPage.tsx:406, 420, 433, 457`). Migrating as-is preserves the cap; to
  gain real pagination, drop the slice and pass `internalPagination` +
  `pageSize`. Type-only change otherwise. `IndicatorTable` can then be deleted.

### 5.3 Medium value — TopDestinations (two tables)

`TopDestinations.tsx:71-116` and `:135-164`. These are "ranked" visual tables
with an inline bar (`TopDestinations.tsx:98-105`, `146-153`) and a rank prefix
(`String(i+1).padStart(2,"0")`, `TopDestinations.tsx:83`). They map cleanly onto
the existing `ui.RankedTable` (`ui.tsx:641-683`), which already does #/Label/Count
+ bar — **except** `TopDestinations` needs a third "Share" column with a
percentage and a "Flagged" badge, and `RankedTable` hard-codes its three columns
and a single-series bar.

- Option A (low churn): migrate to `DataTable` with
  `Column<TopDomain>` — `rank` (cell `String(i+1)`; needs the index, which
  `DataTable.cell` does not pass — would have to pre-compute rank into the row),
  `domain` (cell with flagged badge + bar), `pct` (number, right). This requires
  pre-derived row objects (`{...d, rank, shareLabel}`), since `DataTableColumn.cell`
  receives only `row` (`DataTable.tsx:83` `cell?: (row: T) => ReactNode`), not the index.
- Option B (better): generalize `ui.RankedTable` to accept a `columns` prop and
  an optional bar accessor, then use it for both `TopDestinations` halves and its
  existing call sites.
- Blocker: index-dependent render cells — do not migrate naively to `DataTable`.

### 5.4 Low value / not worth migrating

- **WhitelistDomainPage / BlockDomainPage** (`180-264` / `203-287`): these are
  inline-editing review lists (edit-in-place `Input` at
  `WhitelistDomainPage.tsx:204-212`, Save/Cancel), not data grids. `DataTable` has
  no inline-edit cell concept. Keep hand-rolled; the only shared win would be
  replacing the outer markup, which is not worth the edit-surface risk.
- **LogsPage backup preview** (`475-496`): a fixed 3-column summary of a fixed
  `BACKUP_SECTIONS` list with no row identity — a `<table>` is the right tool.
- **BlacklistPage / JaillistPage** (`FeedCard` `<ul>`, `BlacklistPage.tsx:212-260`):
  a single-value list, not a column table. `DataTable` would need one column and
  would still not express the EDL display transform / copy-delete affordances
  better. Leave as-is (it is already shared between the two pages).
- **`ui.RankedTable`**: already the shared primitive; leave, or generalize per §5.3.

### 5.5 Net recommendation

Migrate **AttckFleetPage** and **ReportPage.IndicatorTable** to `DataTable` first
(both are pure, typed, selection-free, and gain sorting + filters for free).
Then fix the **AnalyticsPage raw mount** (§3.1) by *removing* `internalPagination`
so it matches `HostInspectorPage.tsx:1241`. Do not move
`WhitelistDomainPage`/`BlockDomainPage`/`TopDestinations` without first adding an
index-aware `cell` or an inline-edit concept to `DataTable`.
