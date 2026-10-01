# uNetWatch — Grid & Table Revamp: Design Specification

Status: **Design only — no source file has been modified by this document.**
Scope owner: `admin-ui/src/components/DataTable.tsx` (the shared grid) plus every
tabular surface it does or should own.
Authoritative input: `docs/table-audit.md` (cited throughout as **Audit §n**).
North star: a **Palo Alto Networks PAN-OS / Strata-style security grid** — the
log viewer under *Monitor > Logs* and the object browser under
*Objects > Address Groups*. Dense, toolbar-led, filter-first, keyboard-literate,
with a details surface for the selected row.

All file paths are relative to `admin-ui/src/` unless stated otherwise. Column
ids are quoted exactly as they appear in `DataTableColumn<T>` today.

---

## 1. Problem statement

The audit establishes that the shared `DataTable` is *structurally* sound — sort,
per-column filters, selection, bulk bar, skeletons, empty states and a pagination
slot all work, and `tsc --noEmit` is clean (Audit §3.6). The problems are
**affordance gaps, column-order drift, density, and four concrete defects**. Each
bullet below is tied to evidence.

- **P1 — No column visibility, resize, reorder, or saved views on any table.**
  The consistency matrix (Audit §4) shows `Vis ❌ Rsz ❌ Reord ❌ View ❌ CSV ❌`
  for *every* table including the shared one. A 14-column grid (`QUERY_COLUMNS`,
  `QueryPage.tsx:154-414`) cannot be shaped to the operator's task. PAN-OS lets
  the analyst pick columns from a catalog and save the layout; here the layout is
  hard-coded in the module scope of each page.

- **P2 — Column order is "append order", not "read order".** In `QueryPage` the
  *policy verdict* (`action`, `QueryPage.tsx:280`) sits at slot **9 of 14**, after
  five identifiers and three measures; the *volume* columns (`bytes_downloaded`,
  `bytes_uploaded`, `duration`) sit **between** the destination and the verdict.
  In `FindingsPage` the *evidence* (`pattern`, `FindingsPage.tsx:186`) sits at slot
  **6**, before the *verdict* (`accounting_tag`, `FindingsPage.tsx:225`). The eye
  has to jump left-right-left to answer "was this blocked?".

- **P3 — Identity/anchor is inconsistent across grids, so nothing is scannable
  in the same place twice.** `PatternTable`/`RedirectsPage` lead with a numeric
  surrogate `id` PK (`PatternTable.tsx:54`, `RedirectsPage.tsx:99`); `QueryPage`
  and `AnalyticsPage` lead with a timestamp; `AttckFleetPage` table 1 leads with
  `technique_id`; `ReportPage.IndicatorTable` leads with a business key
  (`domain`/`pattern`/`url`/`client_ip`). The audit's inventory (Audit §2) lists
  seven distinct first-column semantics for seventeen surfaces.

- **P4 — Density is fixed at `px-4 py-3` and is not a preference.** Rows are
  ~44px tall (`DataTable.tsx:940`); a 14-column Query grid fits ~15 rows in a
  1080p viewport. Between `DataTable` and `ui.RankedTable` there are already
  *two* densities in the app (`RankedTable` is deliberately `px-3 py-2`,
  `ui.tsx:645` comment) with no user control. PAN-OS ships a row-density control;
  this app has none.

- **P5 — Filters are hidden behind per-column popovers; there is no persistent
  filter surface and no active-filter summary except in `QueryPage`.** The
  `HeaderFilter` is a `Filter` icon inside each `th` (Audit §4, `Filt ✅`), and
  the only "N filters active · Clear" affordance in the whole app is the bespoke
  chip at `QueryPage.tsx:1109-1117`. Every other page gives the operator no way
  to see *what* is filtered or to clear all at once.

- **P6 — No row context menu and no in-place detail surface outside QueryPage.**
  `onRowClick` exists (`DataTable.tsx:148`) and `QueryPage` uses it to open
  `EventInspectorSidebar` (Audit §4, `QueryPage … ✅ + row click`), but right-click
  does nothing anywhere, and grids like Findings/Redirects that have rich row
  entities have no detail panel at all. PAN-OS opens a row-detail pane on
  double-click and a context menu on right-click; here the "actions" column is a
  dropdown (`ListActionCell`) that duplicates what a context menu should do.

- **P7 — Keyboard support is header-only.** "Nothing offers full grid keyboard
  support" (Audit §4 notes). Header buttons are tabbable and expose `aria-sort`
  (`DataTable.tsx:791-810`); rows are not focusable, there is no roving
  tabindex, and `QueryPage`'s row activation requires a mouse. Only
  `ui.RankedTable` makes rows focusable at all (`ui.tsx:673-676`).

- **P8 — DEFECT D1 (blocking): `AnalyticsPage` raw grid paginates twice; page ≥ 2
  renders empty.** `AnalyticsPage.tsx:768` mounts the raw table with
  `internalPagination` while `:185-205` already fetched exactly one server page
  with `limit/offset`. `DataTable.tsx:707-711` then slices the already-sliced
  array: at `rawPage=1`, `slice(50,100)` of 50 rows → `[]`, so the empty state
  renders (`DataTable.tsx:887-898`) despite `rawTotal > 0` (Audit §3.1). The
  correct sibling is `HostInspectorPage.tsx:1241`, which omits the flag.

- **P9 — DEFECT D2 (latent): `Pagination` "Last page" is a dead control when
  `total` is absent.** `ui.tsx:764` calls `go(totalPages - 1)` where
  `totalPages = 0` when `!hasTotal` (`ui.tsx:734`), and `go` drops negative
  values (`ui.tsx:740`). No current caller omits `total`, so it is latent today
  — but a streamed/cursor grid (an explicit goal) will hit it immediately
  (Audit §3.2).

- **P10 — DEFECT D3: `LogsPage` "Stored" sorts and filters on a value it hides.**
  The accessor is unconditional (`LogsPage.tsx:130-134`) but the cell renders
  `—` for `kind !== "poll"` (`:136`). Sorting "Stored" therefore orders by a
  hidden number and a numeric range filter admits rows whose cell reads "—"
  (Audit §3.3).

- **P11 — DEFECT D4: `QueryPage` row id is not unique.** `queryRowId` is
  `${timestamp}|${client_ip}|${url}` (`QueryPage.tsx:120-122`), but one request
  can yield both a `new` and an `enforcement` row with identical
  timestamp+client+url (Audit §3.4). Two such rows share a React key
  (`DataTable.tsx:919`) and a selection id (`:932`) — colliding keys and a
  checkbox that toggles both rows.

- **P12 — Seven hand-rolled tables cannot share any of the fixes.** The audit's
  reuse map (Audit §5) identifies `AttckFleetPage` (2 grids) and
  `ReportPage.IndicatorTable` (4 mounts) as pure, typed, selection-free grids
  that would gain sorting + filters "for free" — yet each re-implements
  `<thead>`/`<tbody>` by hand (Audit §5.1-5.2).

---

## 2. Design principles

Seven principles, distilled from PAN-OS log/object grids and applied to this
domain. Every column-order decision in §3 and every interaction in §5 traces to
one of these.

1. **Verdict before verbosity — but never before identity.** A security grid
   answers one question first: *did the policy act on this?* So the enforcement
   verdict (`action`, `accounting_tag`, `status`, `severity`) is promoted to
   the left of the evidence and measures — but it stays to the **right of the
   subject/destination**, because a verdict about "something" is unreadable
   until the "something" is on screen. This is PA's own ordering: source →
   destination → application → **action**.

2. **Identifiers left, measures right, actions last and fixed.** Identity/anchor
   columns occupy the frozen left edge; every quantity that can be summed or
   charted (counts, bytes, durations, percentages) is right-aligned into a
   numeric bucket; the row-action affordance is pinned to the far right,
   non-sortable, non-filterable, and (new) sticky. The eye enters at the left,
   scans the verdict in the middle, and never hunts for the actions.

3. **Filters are always visible, never hidden behind a modal.** The persistent
   filter builder sits *above* the grid and the active-filter summary is always
   on screen with a one-click Clear-all — generalizing the bespoke
   `QueryPage.tsx:1109-1117` chip into the shared toolbar. Per-column popovers
   remain as a *shortcut*, never as the only path.

4. **A row is a work item with a detail surface.** Selecting a row opens a
   details panel (the existing `EventInspectorSidebar` idiom) rather than forcing
   a navigation. Actions that mutate the row live in a right-click context menu
   *and* the actions column, sharing one command list.

5. **Density is a user preference, not a stylesheet constant.** Two densities —
   *Comfortable* (today's `px-4 py-3`) and *Compact* (PA-like `px-3 py-1.5`) —
   selectable in the toolbar and persisted per user, defaulting to today's look.

6. **Column order is a contract, not a per-page opinion.** One grammar (P2 + P3)
   governs every grid; each table declares only its *slot assignments*, and the
   renderer derives the order. A new column cannot be appended to the right of
   actions by accident; it must claim a slot.

7. **The grid is honest about what it is showing.** Totals that are only
   estimates say so ("500+"), a page count that cannot be known is not faked
   (D2), a sort/filter key that is hidden for a row is disabled for that row
   (D3), and every row has a genuinely unique key (D4). No affordance silently
   lies.

---

## 3. The canonical column order contract

### 3.1 The grammar

Every grid is assembled from **seven ordered slots**. A column belongs to exactly
one slot. The renderer concatenates slots left→right and ignores declaration
order; the **checkbox/selection slot prepends** everything, the **actions slot
appends** last and is pinned.

```
┌─ 0. SELECT ─┬─ 1. IDENTITY ─┬─ 2. SUBJECT ─┬─ 3. OBJECT/DEST ─┬─ 4. VERDICT ─┬─ 5. EVIDENCE ─┬─ 6. MEASURES ─┬─ 7. ACTIONS ─┐
│  checkbox   │  anchor key   │  who/from    │  what/to         │  policy act  │  patterns /  │  numeric      │  command   │
│  (fixed     │  (time | id)  │  client/source│  dest ip/domain │  ALLOW/DENY  │  lists /     │  bucket,      │  menu,     │
│   left)     │               │              │  URL             │  severity    │  coverage    │  right-align  │  fixed right│
└─────────────┴───────────────┴──────────────┴─────────────────┴──────────────┴──────────────┴───────────────┴─────────────┘
        non-sortable /            sortable, filterable     ◄── sortable+filterable ──►      sortable+filterable    non-sortable
        non-filterable                                                                      (numeric filters)      non-filterable
```

Justification of each slot:

- **Slot 0 — Select.** A 48px checkbox column, always first, never sortable or
  filterable, sticky with Identity when selection is enabled. PA puts the row
  selector at the far left of every log table.

- **Slot 1 — Identity / anchor.** Exactly one column that answers "which row is
  this?". Two admissible anchors: **(a) event time** (`timestamp`,
  `log_timestamp`, `started_at`) for event/stream grids, or **(b) business key**
  (the domain/pattern/URL/IP that the row is *about*) for entity/aggregate grids.
  A surrogate numeric PK (`id`) is **never** the anchor; it is demoted to
  Evidence or hidden by default. Locked at the left edge so time-ordering reads
  top-down. *Default sort key for every event grid.*

- **Slot 2 — Subject (who / from).** The client/source. `client_ip`,
  source host, the host in a host-summary row. Left of the destination because
  attribution ("who did this") precedes target ("to what") in both PA's log view
  and incident triage.

- **Slot 3 — Object / destination (what / to).** `server_ip`, `url`, `base_url`,
  `dest domain`, `dest_ip`, `final_url`. The URL/domain columns truncate with a
  `title` and carry the `QuickNavCell`/`CopyCell` affordances already present.

- **Slot 4 — Verdict (policy action / enforcement).** `action` (ALLOW/DENY),
  `accounting_tag` (Enforcement/New), `status` (redirect status), `severity`
  (ATT&CK), `webhook_status`. This is the column the operator scans for after
  identity. Sorted ascending by default so `DENY`/`enforcement`/terminal states
  group. Distinct from Evidence.

- **Slot 5 — Evidence (why / what matched).** `pattern`, `blocked_by`, `Lists`
  coverage, `matched_patterns`, `techniques`, `name` (technique name). These
  explain the verdict; they are text-heavy and belong *after* it so the verdict
  column keeps a stable x-position.

- **Slot 6 — Measures (numeric bucket, right-aligned).** All counts, bytes,
  durations, percentages, ranks. **Internal order inside the bucket is fixed
  too**: `count/requests → hits → volume/bytes (↓ then ↑) → duration → pct/risk
  share → window/last-checked/targets`. Rationale: cardinality (how many) before
  magnitude (how big) before rate (how long / how fast) before share (what % of
  total) before recency/bookkeeping. Every measure column is `align: "right"`
  with `tabular-nums` and a `number` filter type.

- **Slot 7 — Actions.** Icon button(s) or a `ListActionCell` menu. `align:
  "right"`, `enableSorting: false`, `enableColumnFilter: false`, sticky right,
  width fixed. Never counts toward the "columns" the operator reorders.

Slots 1–6 are the *operator-visible* order; slot 0 and 7 are structural.

### 3.2 Rename conventions (applied uniformly)

| old label | new label | why |
|---|---|---|
| `Type` (accounting_tag) | **`Enforcement`** | "Type" collides with `LogsPage.kind` "Type"; the values are Enforcement/New |
| `Hits` / `Requests` / `Count` | **`Requests`** for requests, **`Hits`** for pattern matches | one noun per concept across grids |
| `↓ Bytes` / `↑ Bytes` | **`Downloaded`** / **`Uploaded`** | arrow glyphs are not screen-reader labels |
| `% total` | **`Share`** | matches `ReportPage.IndicatorTable` ("Share"); 12 chars shorter |
| `Dest domain` / `Domain` | **`Destination`** (domain-level) | one noun; "Domain" and "Dest domain" were two names for one thing |
| `Lists` | **`List match`** | states that it is the list/coverage evidence |
| `Flagged URLs` | **`Flagged`** | the +n badge implies URLs |
| `Monitored dests` | **`Dests monitored`** | noun-first for sorting scannability |
| `#` (ordinal) | **`Rank`** | `#` is ambiguous with an id PK |
| `Targets` (history_count) | **`Redirects`** | matches the page name; `history_count` is the count of distinct targets |

### 3.3 Per-table specification

Legend for "moves": **`was n → now m`** means the column occupied position *n*
left→right before (per Audit §2) and now occupies *m*. `—` means position
unchanged. Column ids are the current code ids (they are stable across the
revamp so call sites and tests keep working). Every table states: selectable,
sort key, direction, default page size, default-visible columns.

---

#### 3.3.1 Patterns — `PatternTable.tsx` (`PATTERNS_COLUMNS`, `PatternTable.tsx:52-125`)

Entity grid (an object browser, not an event stream) → anchored on the business
key `pattern`. Surrogate `id` demoted to Evidence and hidden by default.

| # | id | header (new) | slot | notes | moves |
|---|----|--------------|------|-------|-------|
| 1 | `pattern` | **Pattern** | Identity | the anchor; mono, truncate 260px | `was 2 → now 1` — anchor is the pattern itself |
| 2 | `pattern_type` | **Type** | Verdict | Block / Whitelist badge | `was 3 → now 2` — verdict precedes bookkeeping |
| 3 | `created_at` | **Created** | Measures (bookkeeping tail) | date | `was 4 → now 3` — only measure; follows verdict |
| 4 | `id` | **ID** | Evidence/hidden | surrogate PK; `defaultHidden: true` | `was 1 → now 4` — PK is not an anchor |
| 5 | `actions` | *(sr-only)* | Actions | edit + delete | `was 5 → now 5` — already last |

- `selectable: true` (already bulk-deletes).
- default sort: **`pattern` asc** (it is an alphabetical object list).
- default page size: **50** (unchanged; `PatternTable.tsx:32`).
- default visible: `pattern`, `pattern_type`, `created_at`, `actions`. `id`
  hidden (recoverable via column chooser and via the detail panel).

---

#### 3.3.2 Findings — `FindingsPage.tsx` (`FINDINGS_COLUMNS`, `FindingsPage.tsx:85-284`)

Event grid → anchored on `log_timestamp` **only if** it sorts by default desc; but
the primary scan target is the *client*, and the finding is *about* a URL. Anchor
= `client_ip` is rejected (PA anchors log rows on time); we keep time but promote
the verdict ahead of evidence.

| # | id | header (new) | slot | notes | moves |
|---|----|--------------|------|-------|-------|
| — | — | *(checkbox)* | Select | | — |
| 1 | `log_timestamp` | **Detected** | Identity | time anchor; desc default | `was 8 → now 1` — event grids anchor on time |
| 2 | `client_ip` | **Client IP** | Subject | + inspect/copy/jailed badge | `was 2 → now 2` — already one measure early; now slot-correct |
| 3 | `server_ip` | **Server IP** | Object | + copy | `was 3 → now 3` | — |
| 4 | `url` | **URL** | Object | + inspect/copy | `was 4 → now 4` | — |
| 5 | `base_url` | **Base URL** | Object | + list badges | `was 5 → now 5` | — |
| 6 | `accounting_tag` | **Enforcement** | Verdict | Enforcement/New badge — renamed | `was 7 → now 6` — verdict before evidence |
| 7 | `pattern` | **Pattern** | Evidence | parsed `matched_patterns` | `was 6 → now 7` — evidence after verdict |
| 8 | `id` | **ID** | Evidence/hidden | surrogate PK | `was 1 → now 8` — PK demoted; defaultHidden |
| 9 | `actions` | *(sr-only)* | Actions | track/jail/delete | `was 9 → now 9` | — |

- `selectable: true`.
- default sort: **`log_timestamp` desc** (currently `id desc`,
  `FindingsPage.tsx:665-666`; the change is intentional — findings are read
  newest-first).
- default page size: **25** (unchanged).
- default visible: all except `id` (hidden).

> Judgment call for requester: switching the default sort from `id desc` to
> `log_timestamp desc` changes the landing order. `id` is append-monotonic with
> ingest, `log_timestamp` is event time; they can differ when the poll is delayed.
> Flagged in the summary.

---

#### 3.3.3 Query — `QueryPage.tsx` (`QUERY_COLUMNS`, `QueryPage.tsx:154-414`)

The flagship grid; 14 columns, the one the density switch exists for.

| # | id | header (new) | slot | notes | moves |
|---|----|--------------|------|-------|-------|
| — | — | *(checkbox)* | Select | | — |
| 1 | `timestamp` | **Timestamp** | Identity | desc default | — (`was 1`) |
| 2 | `client_ip` | **Client IP** | Subject | + jailed badge | — (`was 2`) |
| 3 | `server_ip` | **Server IP** | Object | | — (`was 3`) |
| 4 | `domain` | **Destination** | Object | `getDestDomain` — renamed | `was 11 → now 4` — the *what* belongs beside the *who* |
| 5 | `url` | **URL** | Object | full URL, truncate | `was 4 → now 5` — domain is the readable summary of the URL |
| 6 | `base_url` | **Base URL** | Object | | `was 5 → now 6` |
| 7 | `action` | **Action** | Verdict | ALLOW/DENY badge | `was 9 → now 7` — verdict promoted ahead of evidence+measures |
| 8 | `accounting_tag` | **Enforcement** | Verdict | renamed | `was 10 → now 8` |
| 9 | `pattern` | **Pattern** | Evidence | `blocked_by[]` | `was 12 → now 9` |
| 10 | `coverage` | **List match** | Evidence | renamed from "Lists" | `was 13 → now 10` |
| 11 | `bytes_downloaded` | **Downloaded** | Measures | renamed | `was 6 → now 11` — measures collected into one bucket |
| 12 | `bytes_uploaded` | **Uploaded** | Measures | renamed | `was 7 → now 12` |
| 13 | `duration` | **Duration** | Measures | | `was 8 → now 13` |
| 14 | `actions` | *(sr-only)* | Actions | `ListActionCell` | `was 14 → now 14` |

Measure sub-order inside the bucket: `Downloaded → Uploaded → Duration`
(cardinality/magnitude → rate). `client_ip`/`server_ip` stay in Subject/Object
even though they have no measure.

- `selectable: true` (bulk Blacklist / Copy URLs).
- default sort: **`timestamp` desc** (unchanged).
- default page size: **25**; density default **Comfortable**, switchable.
- default visible: `timestamp`, `client_ip`, `server_ip`, `domain`, `url`,
  `action`, `accounting_tag`, `pattern`, `bytes_downloaded`, `duration`,
  `actions`. Hidden by default: `base_url`, `coverage`, `bytes_uploaded` (the
  three the compact bandwidth of a 14-col grid cannot afford at 1280px).
- **D4 fix is mandatory here** (see §5/§8): `rowId` must include
  `accounting_tag` so the composite is unique.

---

#### 3.3.4 Logs — `LogsPage.tsx` (`LOGS_COLUMNS`, `LogsPage.tsx:84-244`)

Operational audit grid (runs, not events) → anchor `started_at`; the run's
*outcome* is the verdict.

| # | id | header (new) | slot | notes | moves |
|---|----|--------------|------|-------|-------|
| — | — | *(checkbox)* | Select | | — |
| 1 | `started_at` | **Time** | Identity | desc default | — (`was 1`) |
| 2 | `kind` | **Type** | Subject (verb of the row) | Poll/Query badge | — (`was 2`) |
| 3 | `error` | **Outcome** | Verdict | error text or green OK | `was 11 → now 3` — "did the run work?" is the verdict |
| 4 | `webhook_status` | **Webhook** | Verdict | `WebhookBadge` | `was 9 → now 4` |
| 5 | `flagged` | **Flagged** | Evidence | first URL + `+n` | `was 8 → now 5` — what was found, before how much |
| 6 | `matches` | **Hits** | Measures | | `was 4 → now 6` |
| 7 | `stored` | **Stored** | Measures | **D3 fix: `enableSorting/filter disabled` when `kind!=="poll"`** | `was 5 → now 7` |
| 8 | `suppressed` | **Suppressed** | Measures | | `was 6 → now 8` |
| 9 | `monitored_dests` | **Dests monitored** | Measures | renamed | `was 7 → now 9` |
| 10 | `minutes` | **Window** | Measures | | `was 3 → now 10` |
| 11 | `duration_ms` | **Duration** | Measures | | `was 10 → now 11` |
| 12 | `actions` | *(sr-only)* | Actions | view detail | `was 12 → now 12` |

Measure sub-order: `Hits → Stored → Suppressed → Dests monitored → Window →
Duration`. `kind` is a Subject-ish classifier (it names what the row *is*), kept
immediately after Time.

- `selectable: true` (bulk Delete).
- default sort: **`started_at` desc** (unchanged).
- default page size: **25**.
- default visible: all except `monitored_dests` and `suppressed` (hidden).

---

#### 3.3.5 Redirects — `RedirectsPage.tsx` (`REDIRECTS_COLUMNS`, `RedirectsPage.tsx:95-212`)

Entity grid anchored on the tracked `url`.

| # | id | header (new) | slot | notes | moves |
|---|----|--------------|------|-------|-------|
| — | — | *(checkbox)* | Select | | — |
| 1 | `url` | **URL** | Identity | the tracked entity | `was 2 → now 1` |
| 2 | `final_url` | **Final URL** | Object | resolved target | `was 5 → now 2` — the resolved target sits beside the source URL it resolves |
| 3 | `status` | **Status** | Verdict | `STATUS_META` badge | `was 3 → now 3` |
| 4 | `http_status` | **HTTP** | Verdict | last code | `was 4 → now 4` |
| 5 | `source` | **Source** | Evidence | manual/finding/auto | `was 6 → now 5` |
| 6 | `id` | **ID** | Evidence/hidden | surrogate PK | `was 1 → now 6`; defaultHidden |
| 7 | `history_count` | **Redirects** | Measures | renamed from "Targets" | `was 8 → now 7` |
| 8 | `last_checked_at` | **Last checked** | Measures | recency tail | `was 7 → now 8` |
| 9 | `actions` | *(sr-only)* | Actions | check/history/delete | `was 9 → now 9` |

> Order note: §3.1 places **Object before Verdict**, so the resolved
> `final_url` sits immediately after the identity `url`, ahead of the
> `status`/`http_status` verdict pair (§3.4 reflects the same). This supersedes
> an earlier draft that had the verdict before the object.

- `selectable: true` (bulk Check / Blacklist / Delete).
- default sort: **`last_checked_at` desc** (currently `id`, `RedirectsPage.tsx:307`;
  "recently checked first" is the operator intent for a monitor list).
- default page size: **25**.
- default visible: all except `id`.

> Judgment call: default sort change `id → last_checked_at desc` (flagged).

---

#### 3.3.6 Host Inspector — 5 grids (`HostInspectorPage.tsx`)

Four of these are aggregate grids with **no selectable**, no pagination; the log
grid is a paged event grid. All become grammar-compliant. (Audit §2/§4.)

**(a) `logColumns` (L678)** — 14 columns, event grid, `pageSize: 50`
(`HostInspectorPage.tsx:345`), no selectable.

| # | id | header (new) | slot | moves |
|---|----|--------------|------|-------|
| 1 | `timestamp` | **Timestamp** | Identity | — |
| 2 | `client_ip` | **Client IP** | Subject | (if rendered; else first subject col) |
| 3 | `dest_ip` | **Dest IP** | Object | — |
| 4 | `url` | **Full URL / dest domain** → **URL** | Object | — |
| 5 | `domain` | **Destination** | Object | `was 11 → now 5` |
| 6 | `method` | **Method** | Object | — |
| 7 | `action` | **Action** | Verdict | `was 12 → now 7` |
| 8 | `status` | **Status** | Verdict | `was 5 → now 8` |
| 9 | `rule` | **Rule** | Verdict | `was 14 → now 9` |
| 10 | `pattern` | **Triggered pattern** | Evidence | `was 13 → now 10` |
| 11 | `category` | **Category** | Evidence | `was 15 → now 11` |
| 12 | `country` | **Country** | Evidence | `was 9 → now 12` |
| 13 | `bytes` | **↓/↑ Bytes** → **Bytes** | Measures | `was 6 → now 13` |
| 14 | `duration` | **Duration** | Measures | `was 7 → now 14` |

- `selectable: false`; sort `timestamp desc`; pageSize **50**; default visible:
  `timestamp`, `client_ip`, `dest_ip`, `url`, `domain`, `method`, `action`,
  `status`, `bytes`, `duration`. Hidden: `rule`, `pattern`, `category`,
  `country`.

**(b) `domainColumns` (L863) / Analytics-style aggregate** —
`Domain → Requests → Volume → Share`.
Grammar: Identity=`domain`; Measures=`Requests → Volume → Share`. Already
compliant. Rename `% total` → **Share**. No selectable, no pagination.

**(c) `patternColumns` (L870)** — `Pattern → Hits`. Identity + measure. Compliant.

**(d) `urlColumns` (L875)** — `URL → Hits`. Identity + measure. Compliant.

**(e) `rawColumns` (L885)** — event grid over `Finding`.

| # | id | header | slot | moves |
|---|----|--------|------|-------|
| 1 | `log_timestamp` | **Timestamp** | Identity | — |
| 2 | `url` | **URL** | Object | — |
| 3 | `base_url` | **Domain** → **Destination** | Object | — |
| 4 | `pattern` | **Pattern** | Evidence | (already after objects) |
| 5 | `volume` | **Volume** | Measures | — |

Already close; only the `Domain → Destination` rename and the `Volume`
badge ("Real/Estimated", Audit §2) moving into the verdict of "how trustworthy"
stay. No selectable, no pagination (passes `internalPagination`? **No** — it uses
server `page/pageSize/total`, `HostInspectorPage.tsx:1241`; keep).

---

#### 3.3.7 Analytics — 3 grids (`AnalyticsPage.tsx`)

**(a) `domainColumns` (L258)** — `Domain → Requests → Volume → Share`.
Compliant; rename `% total` → **Share**. No selectable.

**(b) `clientsColumns` (L306)** — `Client IP → Requests → Last seen`.
Identity(Subject) + Measures. Compliant. No selectable.

**(c) `rawColumns` (L350)** — event grid over `Finding`, server-paged
(`rawPageSize = 50`, `AnalyticsPage.tsx:152`). **D1 lives here.**

| # | id | header | slot | moves |
|---|----|--------|------|-------|
| 1 | `log_timestamp` | **Timestamp** | Identity | — |
| 2 | `client_ip` | **Client IP** | Subject | — |
| 3 | `url` | **URL** | Object | — |
| 4 | `base_url` | **Domain** → **Destination** | Object | — |
| 5 | `action` | **Action** | Verdict | — |
| 6 | `pattern` | **Pattern** | Evidence | — |
| 7 | `volume` | **Volume** | Measures | — |

- `selectable: false`; sort `log_timestamp desc`; pageSize **50**; all visible.
- **D1 fix is mandatory here** (remove `internalPagination`, `AnalyticsPage.tsx:768`).

---

#### 3.3.8 ATT&CK Fleet — 2 grids (`AttckFleetPage.tsx`, hand-rolled → migrate)

**(a) Techniques (`AttckFleetPage.tsx:209-259`)** — `FleetTechnique`:

| # | id | header (new) | slot |
|---|----|--------------|------|
| 1 | `technique_id` | **Technique ID** | Identity |
| 2 | `name` | **Name** | Subject |
| 3 | `severity` | **Severity** | Verdict |
| 4 | `host_count` | **Hosts** | Measures |
| 5 | `example_hosts` | **Example hosts** | Evidence |
| 6 | — | Actions | Actions |

Reason: technique id is the anchor; severity is the verdict; hosts count is the
measure; example hosts are evidence that *supports* the count (moved from last
to slot 5 so the count and its examples are adjacent — a deliberate deviation
from "measures last" only in that the count is the single measure and the
evidence directly annotates it; the count still sits before the action slot).
Actually per grammar, Evidence precedes Measures: order is Identity(1) →
Subject(2) → Verdict(3) → Evidence(5) → Measures(4). Final order: **Technique
ID → Name → Severity → Example hosts → Hosts → Actions**. Mark
`host_count` right-aligned.

**(b) Hosts with techniques (`AttckFleetPage.tsx:267-308`)** — `FleetHostSummary`:

| # | id | header (new) | slot |
|---|----|--------------|------|
| 1 | `client_ip` | **Host** | Subject (anchor) |
| 2 | `techniques` | **Techniques** | Evidence |
| 3 | `risk_share` | **Risk share** | Measures |
| 4 | `total_requests` | **Requests** | Measures |

Grammar: Identity for a host grid = the host key itself (Subject-as-anchor);
Evidence (techniques) before Measures (risk_share, then requests). Final order:
**Host → Techniques → Risk share → Requests**.

Both grids: `selectable: false`, sort default `severity desc` / `risk_share desc`,
`internalPagination` false (arrays are small), pageSize N/A, all visible. Props
per Audit §5.1.

---

#### 3.3.9 Report — `ReportPage.IndicatorTable` ×4 (hand-rolled → migrate)

`IndicatorTable` (`ReportPage.tsx:63-100`) is deleted and each instance becomes a
`DataTable`.

| instance (line) | entity | final order | sort default |
|---|---|---|---|
| Top domains (L404) | `ClientReportTopDomain` | **Domain → Requests → Share** | `count` desc |
| Top patterns (L418) | `ClientReportTopPattern` | **Pattern → Hits** | `hits` desc |
| Top URLs (L431) | `ClientReportTopUrl` | **URL → Requests** | `count` desc |
| Clients (L455) | `UrlClientCount` | **Client IP → Requests → Last seen** | `count` desc |

The current instances `.slice(0, 10)` / `.slice(0, 25)`
(`ReportPage.tsx:406,420,433,457`). Per Audit §5.2, migrating *as-is* preserves
the cap; the contract is to **drop the slice and pass `internalPagination` +
`pageSize` so the grid becomes real** (25 default; 10 for the two in-panel tables
to preserve visual height). `selectable: false`. All columns visible (these are
2–3 column grids; visibility switch is a no-op here and should be suppressed —
see §5a "column chooser hidden when ≤3 columns").

`rowId`: `domain` / `pattern` / `url` / `client_ip` respectively (already the
`rowKey`s at `ReportPage.tsx:407,421,434,456`).

---

### 3.4 Master column-order summary

| table | final left→right |
|---|---|
| Patterns | **Pattern · Type · Created · [ID] · ⚙** |
| Findings | **Detected · Client IP · Server IP · URL · Base URL · Enforcement · Pattern · [ID] · ⚙** |
| Query | **Timestamp · Client IP · Server IP · Destination · URL · Base URL · Action · Enforcement · Pattern · List match · Downloaded · Uploaded · Duration · ⚙** |
| Logs | **Time · Type · Outcome · Webhook · Flagged · Hits · Stored · Suppressed · Dests monitored · Window · Duration · ⚙** |
| Redirects | **URL · Final URL · Status · HTTP · Source · Redirects · Last checked · [ID] · ⚙** |
| HostInspector log | **Timestamp · Client IP · Dest IP · URL · Destination · Method · Action · Status · Rule · Triggered pattern · Category · Country · Bytes · Duration** |
| HostInspector dom/pat/url | **Domain · Requests · Volume · Share** / **Pattern · Hits** / **URL · Hits** |
| HostInspector raw | **Timestamp · URL · Destination · Pattern · Volume** |
| Analytics agg | **Domain · Requests · Volume · Share** / **Client IP · Requests · Last seen** |
| Analytics raw | **Timestamp · Client IP · URL · Destination · Action · Pattern · Volume** |
| ATT&CK techniques | **Technique ID · Name · Severity · Example hosts · Hosts · ⚙** |
| ATT&CK hosts | **Host · Techniques · Risk share · Requests · ⚙** |
| Report (domains/patterns/urls/clients) | **Domain · Requests · Share** / **Pattern · Hits** / **URL · Requests** / **Client IP · Requests · Last seen** |

`[ID]` = present but `defaultHidden`. `⚙` = actions slot (sr-only header).

---


## 4. Shared component API

This is the target `DataTable` API. It is **additive**: no existing prop changes
name or type, and every new capability is opt-in or safely defaulted. The type
sketch below is illustrative TypeScript (≤30 lines per block); it is not a
promise about implementation internals.

### 4.1 Extended `DataTableColumn<T>`

```ts
export type ColumnSlot =
  | "select" | "identity" | "subject" | "object"
  | "verdict" | "evidence" | "measures" | "actions"

export interface DataTableColumn<T> {
  /* ── existing (unchanged) ─────────────────────────────────────── */
  id: string
  header: ReactNode
  accessor?: (row: T) => unknown
  cell?: (row: T) => ReactNode
  enableSorting?: boolean
  enableColumnFilter?: boolean
  filterType?: FilterType                 // "enum" | "text" | "datetime" | "number"
  defaultSortDir?: SortDir
  align?: "left" | "center" | "right"
  className?: string
  headerClassName?: string
  width?: string
  srOnly?: boolean

  /* ── new: order + visibility ─────────────────────────────────── */
  slot?: ColumnSlot          // drives canonical order (§3); default inferred
  hideable?: boolean         // default true; false => pinned in the chooser
  defaultHidden?: boolean    // default false

  /* ── new: sizing ─────────────────────────────────────────────── */
  minWidth?: number          // px floor for drag-resize; default 64
  maxWidth?: number          // px ceiling; default 640
  resizable?: boolean        // default true

  /* ── new: pinning / sortability ──────────────────────────────── */
  sticky?: "left" | "right"  // default: slot "select"/"identity" => left,
                             //          slot "actions" => right
  sortable?: boolean         // alias of enableSorting; explicit wins over slot

  /* ── new: filtering + search ─────────────────────────────────── */
  quickFilter?: boolean      // participates in the toolbar search box
  searchable?: boolean       // alias of quickFilter (kept for readability)
  filterOptions?: string[]   // static enum options (replaces ENUM_FALLBACKS[id])

  /* ── new: presentation + export ──────────────────────────────── */
  cellClass?: string         // merged onto the <td>, not the <th>
  headerTitle?: string       // tooltip on the header label
  exportValue?: (row: T) => string | number | null  // CSV cell; default accessor
  exportHeader?: string      // CSV header; default String(header)
}
```

**Meaning changes to existing props:** none. `enableSorting` and `sortable` are
aliases; if both are set, the *stricter* value wins (`false` beats `true`).
`filterOptions` supersedes the module-level `ENUM_FALLBACKS` map
(`DataTable.tsx:196-200`) but the map is retained as a fallback for one release
so existing call sites keep their enum options without edits.

### 4.2 Extended `DataTableProps<T>`

```ts
export type Density = "comfortable" | "compact"

interface DataTableProps<T> {
  /* ── existing (unchanged) ─────────────────────────────────────── */
  columns: DataTableColumn<T>[]
  data: T[]
  rowId: (row: T) => string | number
  loading?: boolean
  skeletonRows?: number
  selectable?: boolean
  bulkActions?: DataTableBulkAction[]
  busy?: boolean
  onSelectionChange?: (ids: Set<string | number>) => void
  empty?: { icon: LucideIcon; title: string; description?: string; action?: ReactNode } | null
  sortBy?: SortKey | null
  sortDir?: SortDir
  onSortChange?: (key: SortKey, dir: SortDir) => void
  defaultSortBy?: SortKey | null
  defaultSortDir?: SortDir
  columnFilters?: Record<string, ColumnFilterValue>
  onColumnFiltersChange?: (filters: Record<string, ColumnFilterValue>) => void
  enableFiltering?: boolean
  filterSourceData?: T[]
  onRowClick?: (row: T) => void
  page?: number
  pageSize?: number
  total?: number
  hasNext?: boolean
  onPageChange?: (page: number) => void
  onPageSizeChange?: (size: number) => void
  internalPagination?: boolean
  className?: string
  ariaLabel?: string

  /* ── new: capability flags (all default false / off) ─────────── */
  enableColumnVisibility?: boolean   // default true  (opt-out)
  enableReorder?: boolean            // default true  (opt-out)
  enableResize?: boolean             // default true  (opt-out)
  enableExport?: boolean             // default true  (opt-out; CSV button)
  stickyHeader?: boolean             // default true  (opt-out)
  enableContextMenu?: boolean        // default true when rowMenu given
  enableQuickFilter?: boolean        // default false (opt-in search box)
  enableSavedViews?: boolean         // default false (opt-in named views)

  /* ── new: toolbar + surfaces ─────────────────────────────────── */
  density?: Density                              // controlled
  defaultDensity?: Density                       // uncontrolled; default "comfortable"
  onDensityChange?: (d: Density) => void
  toolbar?: ReactNode                            // left cluster, after search
  toolbarRight?: ReactNode                       // right cluster, before built-ins
  filterBuilder?: ReactNode                      // persistent filter row
  viewKey?: string                               // persistence key; enables all persistence
  rowMenu?: (row: T) => ContextMenuItem[]        // right-click menu
  rowDetail?: (row: T) => ReactNode              // side-panel body
  rowDetailOpen?: boolean                        // controlled panel
  onRowDetailOpenChange?: (open: boolean) => void
  onRowActivate?: (row: T) => void               // double-click / Enter
  onExport?: (scope: ExportScope) => Promise<ExportPayload | void>
  exportFilename?: string
  onRefresh?: () => void
  savedViews?: SavedView[]
  onSavedViewsChange?: (views: SavedView[]) => void
  activeViewId?: string | null
  onActiveViewChange?: (id: string | null) => void
}
```

### 4.3 New supporting types

```ts
export interface ContextMenuItem {
  key: string
  label: string
  icon?: LucideIcon
  variant?: "default" | "destructive"
  separator?: boolean
  disabled?: boolean
  onClick: () => void
}

export type ExportScope = "view" | "all-loaded" | "server-all"

export interface ExportPayload {
  columns: { id: string; header: string }[]
  rows: Record<string, string | number | null>[]
}

export interface SavedView {
  id: string                 // stable; uuid or slug
  name: string               // operator label
  sort: { key: SortKey | null; dir: SortDir }
  filters: Record<string, ColumnFilterValue>
  quickFilter: string
  columnOrder: string[]      // column ids, in display order
  columnVisibility: Record<string, boolean>
  columnWidths: Record<string, number>
  density: Density
  pageSize?: number
}

export interface ColumnState {
  order: string[]
  visibility: Record<string, boolean>
  widths: Record<string, number>
}
```

### 4.4 Controlled / uncontrolled contract

Every stateful capability follows one of three rules, consistently:

1. **Controlled if the corresponding `on*Change` prop is present.** Sort already
   does this (`DataTable.tsx:490` `const controlled = !!onSortChange`). Extend the
   same rule to `density` (`onDensityChange`), `rowDetailOpen`
   (`onRowDetailOpenChange`), and `savedViews` (`onSavedViewsChange`).
2. **Uncontrolled with a `default*` prop otherwise.** Mirrors
   `defaultSortBy`/`defaultSortDir` (`DataTable.tsx:493-497`).
3. **Persisted state (`viewKey` set and no controlling prop) is read once from
   `localStorage` under `unetwatch_table_<viewKey>` on mount and written on every
   change.** `viewKey` is the *only* switch that turns on persistence; without a
   key the component is purely in-memory (so existing call sites are unaffected).
   Persistence never overrides a controlled prop.

**Precedence order** (highest first): controlled prop → persisted state →
`default*` prop → built-in default.

### 4.5 Backward-compatibility rule for the ~10 call sites

The existing call sites are: `PatternTable.tsx:355`, `RedirectsPage.tsx:806`,
`LogsPage.tsx:700`, `QueryPage.tsx:1120`, `FindingsPage.tsx:638`,
`HostInspectorPage.tsx:1160/1219/1222/1227/1241`, `AnalyticsPage.tsx:700/715/764`,
and `UrlInvestigationPage.tsx:342` (Audit §1).

**Rule: defaults preserve today's pixels and behaviour exactly.**

| capability | default | effect on existing call sites |
|---|---|---|
| `enableColumnVisibility` | `true` | new chooser icon appears in the toolbar; columns render unchanged |
| `enableReorder` | `true` | drag handles are invisible until header drag; order unchanged |
| `enableResize` | `true` | column widths keep `col.width`; resize only on drag |
| `stickyHeader` | `true` | header sticks; no visual change until scroll |
| `enableExport` | `true` | CSV button appears in the toolbar |
| `density` | `"comfortable"` | identical to today's `px-4 py-3` |
| `enableQuickFilter` | `false` | no search box unless asked |
| `enableSavedViews` | `false` | no views dropdown unless asked |
| `viewKey` | `undefined` | nothing persisted (session-only, as today) |
| `slot` | inferred | if a column omits `slot`, the renderer falls back to **declaration order** — so a table that has not adopted the grammar renders exactly as before |

The **fallback-to-declaration-order** rule is the safety net: a page can ship the
new `DataTable` before its columns are slot-tagged, and nothing moves. Only when
a column sets `slot` does the canonical order engage (and only for tagged
columns; untagged columns sink to the end preserving order — a documented,
non-silent behaviour surfaced in the column chooser as "Unslotted").

**Props whose meaning is sharpened (documented, not changed):**
- `total` — when present, drives `paginationTotal` and page math; when absent,
  the pager now degrades to prev/next with **no dead controls** (D2). Same
  signature, honest behaviour.
- `internalPagination` — unchanged signature; the D1 fix is a *call-site*
  correction, not an API change. The new API additionally **warns in dev**
  (`console.warn`) if `internalPagination` is set together with `total` *and*
  `onPageChange` (the exact D1 combination).

---

## 5. Interaction contract

### 5.1 (a) Toolbar

Two clusters, one row above the table, sticky with the header when both fit.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ LEFT                                        │            RIGHT              │
│ [🔍 search] [filter chips…] [N active · Clear] │ [⟳] [density] [columns] [reset] [views] [export] │
└────────────────────────────────────────────────────────────────────────────┘
```

| cluster | control | behaviour | visible when |
|---|---|---|---|
| left | **Search** (`enableQuickFilter`) | filters rows whose `quickFilter`/`searchable` column accessor contains the needle (case-insensitive substring); debounce 250ms; server-mode calls `onQuickFilterChange` instead | `enableQuickFilter` |
| left | **Filter chips** | one chip per active filter: `Header = value`; click chip → opens that column's filter popover; `×` on chip clears it | ≥1 active filter |
| left | **Active count · Clear all** | `"3 filters active · Clear"`; matches `QueryPage.tsx:1109-1117` | ≥1 active filter |
| left | `toolbar` slot | page-specific controls (e.g. Analytics "Unique domains" toggle at `AnalyticsPage.tsx:744-752`) | prop given |
| right | **Refresh** | calls `onRefresh`; spins while `loading` | `onRefresh` |
| right | **Density** | segmented `Comfortable / Compact`; persists under `viewKey` | always |
| right | **Columns** | opens the column-chooser popover (§5g) | `enableColumnVisibility` && columns > 3 |
| right | **Reset** | clears filters, quick-search, sort, widths, visibility, order → back to declared defaults; **does not** touch selection | any view state non-default |
| right | **Views** | saved/named views dropdown (§5e) | `enableSavedViews` |
| right | **Export** | CSV menu with scope (§5i) | `enableExport` |
| right | `toolbarRight` slot | page-specific right controls | prop given |

The toolbar replaces the bespoke per-page search rows (`AnalyticsPage.tsx:736-746`,
`HostInspectorPage.tsx:1238`). Those rows are deleted in the migration.

### 5.2 (b) Filter controls, tri-state enum, and active-filter summary

Every control commits only on **Apply** (the existing `HeaderFilter` rule,
`DataTable.tsx:204-206` comment: "typing never refilters mid-keystroke"). The
four existing types are kept and extended with tri-state for `enum`.

| `filterType` | control | tri-state? | match semantics |
|---|---|---|---|
| `enum` | searchable checkbox list | **yes — Include / NOT / Off** | Include: row's accessor value ∈ checked; NOT: value ∉ checked; Off: no constraint |
| `text` | single-line input | no | case-insensitive substring (unchanged) |
| `datetime` | from / to inputs | no | open-ended range (unchanged) |
| `number` | min / max inputs | no | open-ended range (unchanged) |

**Tri-state enum** (the one new interaction). Each option row is a three-state
cycle button, plus quick global actions:

```
Filter: Action
┌───────────────────────────┐
│ [ Include ] [ Exclude ]   │  ← mode toggle for new picks
│ ┌───────────────────────┐ │
│ │ ☑ DENY     (Include)  │ │  ← click cycles Off → Include → NOT → Off
│ │ ☐ ALLOW               │ │
│ └───────────────────────┘ │
│          [Clear] [Apply]  │
└───────────────────────────┘
```

- Visual: `Include` = filled check, `NOT` = filled check with a struck-through
  `≠` badge (or the `SquareSlash` icon), `Off` = empty box. Never colour-only.
- Value shape: **`enum` gains an object form** so tri-state is representable
  without breaking the scalar contract:

```ts
export interface EnumFilter {
  include: string[]
  exclude: string[]
}
// ColumnFilterValue = string | DatetimeFilter | NumberFilter | EnumFilter
```

- Backward compatibility: a **plain `string` remains a scalar exact-match**
  (today's behaviour). `isActiveFilter` (`DataTable.tsx:56-60`) is extended to
  treat an `EnumFilter` with both arrays empty as inactive. Existing controlled
  filter objects (e.g. `QueryPage`'s `columnFilters` state) keep working
  untouched.
- Where summarized: the toolbar chip row (§5a) shows `Action ≠ DENY` for a NOT
  filter and `Action: DENY` for an Include filter, so the negation is never
  implicit. The `QueryPage` legend chip (`QueryPage.tsx:1109`) is subsumed.

### 5.3 (c) Sort

| gesture | result |
|---|---|
| click header | cycle `asc → desc → none` **on that column**; entering `none` clears `sortBy` |
| `Shift`+click header | **multi-sort**: append as secondary key; a small `1`/`2` ordinal badge appears next to the arrow |
| `aria-sort` | `"ascending"` / `"descending"` on the active `th`, `undefined` when unsorted; multi-sort sets it only on the primary key |
| indicator | `ArrowUp` active asc, `ArrowDown` active desc, `ArrowUpDown` at 30% opacity inactive (unchanged glyphs, `DataTable.tsx:813-821`) |
| server mode | `onSortChange(key, dir)`; the cycle is truncated to `asc → desc → asc` (no `none`) so the server always has a key |

Multi-sort is **proposed but optional** behind `enableMultiSort` (default
`false`) — it adds real complexity to `sortedData` (`DataTable.tsx:688-697`) and
to server mode, so it ships last. Rendered indicator is the ordinals; the
implementation keeps `sortBy: SortKey | SortKey[]` internally while the public
prop stays `SortKey` until `enableMultiSort` is used.

### 5.4 (d) Selection

| gesture | result |
|---|---|
| click row (anywhere but controls/links) | toggles that row's checkbox **when `selectable` and `singleClickSelect` is on**; otherwise activates the row (§5f) |
| `Ctrl`/`Cmd`+click | add/remove that row from the selection |
| `Shift`+click | range-select from the last anchor to this row **within the current page** |
| header checkbox | select-all **of the current page**; indeterminate when partial |
| select-all scope | page-only by default. A `selectAllScope: "page" | "filter" | "all"` menu appears next to the header checkbox when `total > pageSize`; choosing `filter`/`all` shows the warning below |
| bulk bar | appears above the table when `selected.size > 0` (existing `DataTable.tsx:720-761`); contents: `"N selected"`, the `bulkActions` buttons, `Clear` |
| select-across-pages | **server-side caveat**: selection is keyed by `rowId`, and `DataTable` already prunes ids not present in `data` (`DataTable.tsx:529-536`). In server mode this means an id selected on page 1 is silently dropped when page 2 loads. The contract: the bulk bar shows `"N selected (M on this page)"` when a cross-page selection exists, and `selectAllScope: "filter"` is the *only* way to act on rows the client has not loaded — it requires the page to expose `onSelectAllFiltered`. Until a page implements it, the option is hidden. |

### 5.5 (e) Row activation, context menu, keyboard

| input | behaviour |
|---|---|
| single click | if `onRowClick` given → call it (QueryPage opens the inspector); else no-op |
| double click | calls `onRowActivate`; **default = open the row detail panel** (§5f) when `rowDetail` is present, else same as `onRowClick` |
| `Enter` (row focused) | same as double-click |
| `Right-click` | opens the context menu from `rowMenu(row)`; if absent, the browser menu is suppressed **only** inside the grid and a native-looking fallback menu is shown with `Copy cell` + `Copy row` |
| `Escape` | closes, in order: context menu → filter popover → column chooser → column popover → detail panel. One Escape, one layer. |
| `Space` (row focused) | toggles selection (when `selectable`) |

The context menu is a Radix `DropdownMenu` (already a dependency,
`package.json:15`) anchored at the pointer. Its item list *is* the same command
array as the actions cell, so the two cannot drift; pages pass `rowMenu` once.

### 5.6 (f) Details side panel

- **Opens** on double-click / `Enter` when `rowDetail` is provided, or
  programmatically via `rowDetailOpen`.
- **Reuses** the `EventInspectorSidebar` pattern (`EventInspectorSidebar.tsx:153`):
a Radix `Dialog` sheet, `fixed right-0`, `w-[min(100vw,440px)]`, overlay
`data-[state=open]:animate-in`, `aria-describedby={undefined}` explicitly
relinquished (already done at `EventInspectorSidebar.tsx:166`).
- **Resizable**: a 6px drag handle on the left edge; width persisted under
  `unetwatch_table_<viewKey>_panelWidth`; clamped `[360, 720]`.
- **Keyboard**: `[` closes the panel; `]` toggles it for the focused row;
  `Escape` closes (as above); focus moves to the panel's first focusable control
  on open and returns to the originating row on close (`DialogPrimitive`
  focus-trap handles both).
- **State**: `?row=<id>` is written to the URL when the page's router supports it
  (this app uses a view-state + `localStorage` model, `QueryPage.tsx:591`), so
  the panel state is persisted to `localStorage` under
  `unetwatch_table_<viewKey>_openRow` — the URL param is *not* adopted because
  the app has no URL router for views; documented as a deliberate deviation.
- **Content**: header (title + verdict badges), then the page-provided
  `rowDetail(row)`, then a shared footer with `Copy JSON`, and the row's
  `rowMenu` items rendered as buttons. This is exactly what
  `EventInspectorSidebar` already does for the Query grid.

### 5.7 (g) Column resize / reorder / visibility persistence

| action | gesture | persisted as |
|---|---|---|
| resize | drag the 8px handle on a header's right edge; double-click the handle to reset that column | `columnWidths[id]` |
| reorder | drag a header by its body (5px threshold before it becomes a drag, so a click still sorts); drop indicator = 2px primary line | `columnOrder[]` |
| visibility | column chooser: checkbox list with drag-reorder; `hideable:false` columns render as locked rows | `columnVisibility[id]` |

- **Key**: everything under `unetwatch_table_<viewKey>` (one JSON blob:
`{ order, visibility, widths, density, sort, filters, quickFilter, pageSize }`).
If `viewKey` is absent, state lives in component memory only.
- `slot`,`sticky`,`hideable:false` columns are excluded from reorder and always
  visible; the chooser shows them greyed with a lock icon.
- Reset (§5a) deletes the stored blob.
- The chooser is a Radix `Popover` (`@radix-ui/react-popover` is a dep,
`package.json:17`) — the same primitive the `HeaderFilter` should migrate onto
(it currently hand-rolls a `createPortal` + `role="dialog"`,
`DataTable.tsx:207-430`).

### 5.8 (h) Pagination + page size + the honest-total rule

- Page sizes offered: **25 / 50 / 100 / 200** (existing `Pagination` default
  options, `ui.tsx:749`), plus `10` for the in-panel Report tables.
- **Honest total** (three states):
  1. `total` known and exact → `"Showing 1–25 of 340"` + numbered pages +
  last-page (today's behaviour).
  2. `total` a lower bound / unknown → show `"Showing 1–25"` + prev/next only,
  **no numbered pages and no "Last page"** (this is the D2 fix: the last-page
  button is only rendered when `total` exists, `ui.tsx:764`).
  3. `hasNext=true` with no `total` → `estimateTotal` prop, if supplied, renders
  `"340+"`; otherwise plain prev/next.
- **D2 fix in `ui.tsx`**: change the `hasTotal` branch so the last-page button is
  `{hasTotal && <Button …/>}`; `totalPages` stays `0` when unknown and `go` is
  never called with a negative value. Preserve the existing `p < 0` guard as a
  belt-and-braces.
- **Page-size persistence**: `pageSize` is part of the `viewKey` blob.

### 5.9 (i) Export

CSV only (no XLSX; see §10). Menu with three scopes; availability depends on the
grid's mode.

| scope | what is exported | when available |
|---|---|---|
| **Current view** | the exact rows on screen, in the current column order + visibility, with active filters applied | always |
| **All loaded rows** | every row the page holds in memory (`filterSourceData`), filters + client-side sort applied | when the page holds more than one page |
| **Server-side (full)** | page calls its own fetch-all endpoint via `onExport("server-all")` and returns an `ExportPayload` | only when `onExport` is given |

- **What is exported is stated in the menu label** (`"Current view (25)"`,
  `"All loaded (340)"`, `"All matching (server)"`) so nobody assumes a full
  export from a page-limited button.
- **CSV rules**: RFC 4180; every field wrapped in `"` when it contains `,`, `"`,
  `\n`, or a leading `=`/`+`/`-`/`@` (formula-injection guard) — the guard
  prefixes with a single quote **only for those four leading characters**; `"`
  doubled; `\r\n` line endings; UTF-8 with BOM (Excel compatibility).
- **Cell value**: `exportValue(row)` if given, else the stringified `accessor` —
  **never** the ReactNode from `cell`. This is why `exportValue` exists: badges,
  menus, and `+n` chips must serialize to their underlying value, not `[object
  Object]`.
- **Header row**: `exportHeader ?? String(header)`; `srOnly` columns (actions)
  are excluded.
- **Filename**: `exportFilename ?? \`${viewKey ?? slug(ariaLabel)}-${yyyyMMdd-HHmmss}.csv\``.
- Export runs on `requestIdleCallback`, shows a toast (`useToast`) on completion,
  and is disabled while `loading || busy`.


---

## 6. Responsive & performance rules

### 6.1 Breakpoint degradation

The app shell (`AppShell.tsx`) is a flex row with a fixed `Sidebar`; the content
column is the width the grid lives in. The grid degrades in this order, and the
order is deliberate — **the identity column never leaves; the actions column
never leaves; measures go first.**

| viewport | column behaviour | chrome behaviour |
|---|---|---|
| **≥1536px** | everything visible per the table's `defaultVisible` set; user may add more | full toolbar: search + chips + count + all right-cluster controls |
| **1280–1535px** | columns marked `defaultHidden` stay hidden; measure columns in the bucket may auto-collapse behind a `+n` "more" disclosure **only if** the grid is wider than the viewport | toolbar right cluster collapses into an overflow `⋯` menu (density, columns, reset, views, export); search stays |
| **1024–1279px** | the object slot collapses the URL to its `base_url`/domain summary (cell renders the short form via a responsive `cell`); measures keep the first two of the bucket only (`count`, `volume`) | filter chips become a horizontally-scrollable single row; active-count chip stays |
| **768–1023px** | the horizontal scroll is the primary affordance (`.overflow-x-auto` already wraps the table, `DataTable.tsx:763`); the identity column is sticky-left and the actions column sticky-right so they remain anchored while the middle scrolls | toolbar becomes two rows; the column chooser becomes a bottom sheet |
| **<768px** | the grid is not the primary surface; the page must offer a card/list fallback. **This spec does not design the <768px grid** (see §10) — the grid keeps horizontal scroll as a stopgap, no new work. |

**Sticky column mechanics:** `position: sticky` with a `z-index` above the body
and below the header. Sticky-left cells need an opaque background
(`bg-card`) or the scrolled content shows through; the existing header has
`bg-transparent` (`DataTable.tsx:766`) and must become `bg-card` for the sticky
row to work. A 1px right border marks the sticky-left edge only when
`scrollLeft > 0` (tracked via a `scroll` listener on the `.overflow-x-auto`
container).

### 6.2 Virtualization policy

**Threshold: virtualize at > 200 rendered rows.** Rationale:

- Today the maximum rendered `<tr>` count is the page size. Current defaults are
  `DEFAULT_PAGE_SIZE = 25` (`FindingsPage.tsx:46`, `LogsPage.tsx:46`,
  `RedirectsPage.tsx`, `QueryPage.tsx`) and `50` (`PatternTable.tsx:32`,
  `HostInspectorPage.tsx:345`, `AnalyticsPage.tsx:152`). So the live app renders
  ≤ 50 rows.
- The `Stagger` wrapper (`DataTable.tsx:912`) animates every rendered row; its
  cost scales with the *page* size, not the dataset, precisely because paging
  bounds it (`DataTable.tsx:910-911` comment).
- A 200-row cap equals the largest page-size option (200, `ui.tsx:749`). Below
  that, `content-visibility: auto` (the app already ships a `cv-auto` utility,
  `index.css:169`) on `<tr>` is sufficient and far simpler than a virtual list.
- **Policy:** rows ≤ 200 → no virtualization, rely on `cv-auto` +
  `skeletonRows`; rows > 200 (only reachable if a page opts into
  `internalPagination` with a 500-row dataset, e.g. Host Inspector's ~500
  fetched rows) → window the `<tbody>` with a lightweight
  `@tanstack/react-virtual`-style spacer technique. **This is deferred**, not
  built now: the rule exists so that when a page wants >200 rows it is an
  explicit, reviewed decision with a stated mechanism, not an accident.

### 6.3 Memoization rules for column arrays

The codebase's current pattern is **module-scope columns + a mutable `*_UI`
handle**: `PATTERNS_COLUMNS` + `PATTERNS_UI` (`PatternTable.tsx:52,316-318`),
`LOGS_COLUMNS` + `LOGS_UI` (`LogsPage.tsx:84,628-629`), `REDIRECTS_COLUMNS` +
`REDIRECTS_UI` (`RedirectsPage.tsx:95,633-637`), `QUERY_COLUMNS` + `queryUI`
(`QueryPage.tsx:154,587-595`), `FINDINGS_COLUMNS` + `FINDINGS_UI`
(`FindingsPage.tsx:85,554-559`). The audit calls this a "deliberate
'referentially-stable columns' pattern… it works… but it is a render-phase side
effect that React Strict Mode double-invokes" (Audit §3.5).

**Decision: keep the pattern, harden it, and document its contract.**

| rule | statement |
|---|---|
| R1 | **Columns stay module-scope** for the five page-level grids. The referential stability is load-bearing: `DataTable`'s `sortedData` memo depends on `sortColumn` (found via `columnsRef`), and `filterOptions` depends on `columns` (`DataTable.tsx:579-586,661-686`). Recreating the array per render would re-run both. |
| R2 | **`*_UI` assignment must move out of the render body** into a `useLayoutEffect` (so it runs after commit, not during render). This removes the Strict-Mode double-invoke hazard (`PatternTable.tsx:316-318` etc.) without changing stability: the columns array identity never changes, only the *values* the cells read. |
| R3 | **Columns that depend on component state** (not just the UI handle) must use `useMemo` with the state in deps, exactly as `HostInspectorPage`'s `domainColumns`/`urlColumns` already do (`HostInspectorPage.tsx:863,875`, deps `[openUrlInInvestigation]`). The rule: if a column's `cell` closes over a *function identity that changes*, the array is `useMemo`'d; if it closes over a *handle it reads at call time*, it stays module-scope. |
| R4 | **New reactive columns** (e.g. a column whose `defaultHidden` depends on viewport) must be `useMemo`'d and placed inside the component; they must not be appended to the module-scope array. |
| R5 | **`DataTable` must never depend on `columns` identity for correctness** — the sort column is already read via ref (`DataTable.tsx:579`). Extend the same ref treatment to the new `filterOptions`-like lookups and to slot resolution, so R1–R4 are optimizations, not correctness requirements. |

### 6.4 Other performance rules

- **Row cells**: keep `cell` render functions pure and allocation-light. The
  Audit's concern about `JSON.parse(f.matched_patterns)` inside both `accessor`
  and `cell` (`FindingsPage.tsx:186-224`) is a real double-parse per row per
  render; the revamp adds a memoized `parsedPatterns(row)` helper shared by the
  accessor, the cell, and `exportValue`.
- **Selection pruning** already runs on `data` change (`DataTable.tsx:529-536`);
  keep it but switch the `data.map` to the memoized `ids` (`DataTable.tsx:542`)
  to avoid a second full pass.
- **Filter options** are O(rows × enum-columns) per `filterSourceData` change
  (`DataTable.tsx:661-686`); for the 500-row Host Inspector this is fine, but
  guard with a `Set` per column (already done) and skip `srOnly`/non-enum columns
  (already done).
- **Animation**: keep `Stagger` for the visible page only. With the density
  switch, `Stagger`'s `y: 8` rise must be honoured by `MotionGate`
  (`motion.tsx:24-28`) which reads the OS reduced-motion preference; the CSS
  `html[data-paused]` rule (`index.css:170`) already freezes CSS animations when
  the app is backgrounded.

---

## 7. Accessibility spec

The grid is a real `<table>`; the revamp keeps that (never `role="grid"` unless
the roving-tabindex model below is adopted). Requirements are mandatory unless
marked optional.

### 7.1 Header semantics

| requirement | implementation |
|---|---|
| `scope="col"` on every `<th>` | add to the sortable and non-sortable header cells in `DataTable.tsx:783-794` and `:840`; `ReportPage`/`AttckFleetPage` hand-rolled headers already do this (`ReportPage.tsx:82`, `AttckFleetPage.tsx:212`) — preserve on migration |
| sort button semantics | the header label stays a real `<button type="button">` (already `DataTable.tsx:803`), never a `<div onClick>`; its `aria-label` already reads `"Sort by X, currently ascending"` (`:810`) |
| `aria-sort` | valid values only `"ascending"` / `"descending"`; **omit the attribute entirely when unsorted** (already the case, `DataTable.tsx:791-793`). With multi-sort, set it only on the primary key and expose the secondary via the ordinal badge's accessible text |
| filter affordance | the `Filter` icon button keeps `aria-expanded` and `aria-pressed` (`DataTable.tsx:84-85`) and gains `aria-haspopup="dialog"` |
| column header title | when truncated, `headerTitle` renders `title` (mouse) **and** a visually-hidden full label inside the button so screen readers get the untruncated header |

### 7.2 Tri-state filter checkbox representation

A three-state cycle cannot be a native `<input type="checkbox">` (which is
binary and has no NOT state). Contract:

```tsx
<button
  role="switch"                        // NOT a checkbox — three states
  aria-checked={state === "off" ? false : true}
  aria-label={`Action: DENY — ${state === "include" ? "included"
              : state === "exclude" ? "excluded" : "not filtered"}`}
  onClick={cycle}                       // off → include → exclude → off
>
  {/* glyph: ☐ (off) · ☑ (include) · ☑̸ (exclude) */}
</button>
```

- `role="switch"` + `aria-checked` communicates the on/off axis; the
  **included/excluded distinction is carried in `aria-label`**, not colour.
- The mode toggle (`Include`/`Exclude`) is a `role="radiogroup"` with two
  `role="radio"` options.
- A live region (`aria-live="polite"`) announces the resulting row count when a
  filter is applied: `"14 of 340 rows match"` — this also serves the active
  filter summary.

### 7.3 Focus management

| surface | rule |
|---|---|
| column chooser popover | on open, focus the first checkbox; `Escape` closes and **returns focus to the chooser trigger**; Tab cycles within the popover (Radix `Popover` handles this if migrated onto the primitive — the current `HeaderFilter` hand-rolls it with `createPortal` + `role="dialog"`, `DataTable.tsx:207-430`, and does **not** trap focus) |
| filter popover | same as above; the popover must be a Radix `Popover` (a dep, `package.json:17`) so focus-trap and `Escape` are free |
| detail panel | Radix `Dialog` (as `EventInspectorSidebar.tsx:153` already is) → focus moves into the panel, `Escape` closes, focus returns to the originating row |
| context menu | Radix `DropdownMenu` (`package.json:15`) → arrow-key navigation is free |
| after bulk action | focus returns to the bulk bar's first button; after the bar closes, to the header checkbox |

### 7.4 Roving tabindex (required) and the documented alternative

**Adopt roving tabindex on rows.** The grid is the primary work surface; a single
`tabIndex={0}` on the `<tbody>` with arrow-key row navigation is the standard
model and matches `ui.RankedTable`'s precedent of focusable rows
(`ui.tsx:673-676`).

- `role="grid"` is added to the `<table>` **only if** roving tabindex ships;
  otherwise the table keeps implicit table semantics (safer for AT).
- Roving model: exactly one `<tr tabindex={0}>`; `ArrowUp/ArrowDown` move focus;
`Home/End` jump within the page; `Enter` activates (opens detail);
`Space` toggles selection; `Ctrl/Cmd+click` and `Shift+click` follow §5d.
- **Documented alternative** (if roving is deferred): rows remain non-focusable,
and activation is reachable via the actions-cell button (Tab-reachable) — but
this is explicitly a *degraded* state, logged as a known gap, not a design.

### 7.5 Target sizes

Minimum **24×24px** interactive target at both densities (WCAG 2.2 SC 2.5.8).

| control | comfortable | compact |
|---|---|---|
| row checkbox | 20px box, 40px hit area (padding) | 16px box, 24px hit area |
| sort button | full header height (~44px) | ~32px, but the **clickable area includes the th padding** so the effective target stays ≥24px |
| filter icon | 24×24 | 24×24 (never shrink below 24) |
| actions icon button | 32×32 (`h-8 w-8`) | 28×28, min 24 |
| resize handle | 8px visual, 12px hit strip | same |

Compact density reduces `padding` (from `py-3` to `py-1.5`), **not** the minimum
target size; a compact cell whose content is a 20px icon gets `min-h-6`
(24px) to preserve the rule.

### 7.6 Reduced motion

- The repo honours `html[data-paused]` (backgrounded tab pauses CSS animations,
`index.css:170`) and `prefers-reduced-motion` (a global CSS override,
`index.css:173-175`), and `MotionGate` sets framer's `reducedMotion="user"`
(`motion.tsx:24-28`).
- **Rule for the grid**: any new motion introduced by the revamp
  (row stagger on density change, panel slide, popover fade) must go through
  framer `motion`/the `motion.tsx` helpers, **never** ad-hoc CSS keyframes, so
  `MotionGate` and the CSS override both apply. The `animate-in`/`animate-out`
  utilities (`index.css:153-156`) are already covered by the media query.
- Density changes must **not** FLIP-animate row heights (layout animation is the
  expensive path the repo explicitly avoids, `motion.tsx:16` comment); the
  switch re-renders instantly and only the toolbar's density control animates.

---

## 8. Migration plan

Ordered, dependency-aware. **Steps 0–3 are the four defect fixes and MUST land
before any redesign work** — they are independent, small, and remove the bugs
that would otherwise be re-tested against a moving target. Risk is
low/med/high. "Rollback" is the revert unit (each step is one PR).

> **Working-tree status (verified against `git diff`, 2026-10-01):** D1, D2 and
> D3 are **already fixed in the uncommitted working tree** —
> `AnalyticsPage.tsx` has `internalPagination` removed from the raw mount,
> `LogsPage.tsx:130` uses the honest `accessor: (l) => (l.kind === "poll" ? l.stored
> : undefined)` (which is **option 2a**, the recommended D3 fix), and
> `ui.tsx:761` renders the last-page button behind `{hasTotal && …}`. **D4 is not
> yet fixed.** Steps 0–2 are therefore *verify + commit + test*, not new work;
> Step 3 is the only defect fix still to write. Confirm these diffs before
> starting so the reviewer knows the baseline.

### Step 0 — D1: Analytics raw double-pagination  *(risk: low)*

- **Files:** `AnalyticsPage.tsx` only — remove `internalPagination` from the raw
  mount at `:768`, leaving `total={rawTotal} page={rawPage} pageSize={rawPageSize}
  onPageChange={setRawPage}` to match `HostInspectorPage.tsx:1241`.
- **Acceptance:** open Analytics → Raw Findings → page to 2; rows render (not the
  empty state); the pager shows the correct range; `rawTotal` is unchanged.
- **Rollback:** re-add the prop.
- **Why first:** it is a one-line, user-visible data-loss bug on a page that is
  otherwise correct.

### Step 1 — D2: `Pagination` dead last-page button  *(risk: low)*

- **Files:** `ui.tsx` (`Pagination`, `:728-768`). Render the last-page button only
  when `hasTotal`; keep `totalPages = 0` when unknown; keep the `p < 0` guard.
  Add a `aria-label` test so the button is absent, not disabled, in cursor mode.
- **Acceptance:** unit/manual — a `Pagination` with no `total` renders no
  last-page button; with `total` it still works; `tsc` clean.
- **Rollback:** revert the conditional.

### Step 2 — D3: Logs "Stored" honest sort/filter  *(risk: low)*

- **Files:** `LogsPage.tsx` (`LOGS_COLUMNS`). Introduce an honest-surface rule:
  when a column hides a value for some rows, disable *both* sorting and filtering
  for those rows rather than the column. Two options:
  - **(2a, recommended)** keep `stored` sortable but make the accessor return
    `null` for `kind !== "poll"` so those rows sort to one end consistently with
    the `—` cell, and add `filterType: "number"` unchanged (a numeric filter
    already excludes nullish values, `DataTable.tsx:629-632`).
  - **(2b)** set `enableSorting: false` + `enableColumnFilter: false` on `stored`.
- **Acceptance:** sorting by "Stored" no longer interleaves hidden query rows;
  a numeric "Stored" range filter returns no `kind === "query"` rows.
- **Rollback:** restore the unconditional accessor.
- **Judgment call:** 2a is preferred because it keeps a genuinely useful sort for
  poll runs; flagged in the summary.

### Step 3 — D4: Query row-id uniqueness  *(risk: low)*

- **Files:** `QueryPage.tsx` only — change `queryRowId` (`:120-122`) to include
  `accounting_tag` (or a stable backend id if one exists in `QueryDoc`):

```ts
function queryRowId(d: QueryDoc): string {
  // accounting_tag disambiguates the new/enforcement pair for one request.
  return `${d.timestamp}|${d.client_ip}|${d.url}|${d.accounting_tag}`
}
```

- **Acceptance:** a response containing both an `enforcement` and a `new` row for
  the same (timestamp, client, url) renders two rows; selecting one selects only
  one; no React duplicate-key warning in the console.
- **Rollback:** revert the function.
- **Dependency:** none, but do it before Step 8 (Query slots) so the id is stable
  under test.

### Step 4 — `DataTable` core: slot engine + sticky header + density  *(risk: med)*

- **Files:** `DataTable.tsx` (granularity: one PR but internally ordered):
  1. slot resolution (fallback = declaration order, so no call site changes);
  2. `stickyHeader` (th becomes `bg-card`, `position: sticky`, top offset);
  3. `density` prop + `py-*` swap; toolbar scaffold (right cluster only: refresh
     if `onRefresh`, density, reset).
- **Acceptance:** every existing table renders pixel-identical at
  `density="comfortable"`; scrolling a long table keeps the header; `tsc` clean;
  `npm run build` green.
- **Rollback:** revert; the flags default on but the slot engine is inert without
  `slot`.
- **Why here:** everything after depends on the toolbar and slot machinery.

### Step 5 — Column visibility / resize / reorder + `viewKey` persistence  *(risk: med)*

- **Files:** new `components/table/useColumnState.ts` (hook), `DataTable.tsx`
  (chooser popover via Radix `Popover`, resize handles, drag-reorder).
- **Acceptance:** toggling a column hides it and survives a reload **only** when
  `viewKey` is set; resize persists; reorder persists; Reset restores defaults;
  no `viewKey` → nothing persisted.
- **Rollback:** remove the hook; the toolbar's column button hides behind a
  feature flag if partial.
- **Depends on:** Step 4.

### Step 6 — Export (`enableExport`)  *(risk: low/med)*

- **Files:** new `components/table/exportCsv.ts` (RFC-4180 + formula guard),
  `DataTable.tsx` toolbar menu.
- **Acceptance:** CSV of the Query grid round-trips in a spreadsheet; a URL
  containing commas and quotes survives; a cell starting `=` is prefixed so it
  cannot execute; columns match current order/visibility.
- **Rollback:** hide the button.
- **Depends on:** Step 5 (order/visibility feed the export).

### Step 7 — Filter builder + tri-state enum + active-filter chips  *(risk: high)*

- **Files:** `DataTable.tsx` (`EnumFilter` type, `isActiveFilter` extension,
  `HeaderFilter` → Radix `Popover`, toolbar chip row + Clear-all);
  `QueryPage.tsx` (delete the bespoke chip at `:1085-1113`).
- **Acceptance:** old scalar string filters still exact-match; a NOT filter
  excludes; chips summarize honestly; Clear-all clears; `QueryPage`'s removed
  chip is subsumed with no behaviour loss.
- **Rollback:** keep the scalar path; the tri-state is additive, so reverting the
  object form leaves the string path working.
- **Risk note:** this touches the filter engine that every page depends on; it is
  the highest-risk *logic* change. Ship behind `enableFilterBuilder` if needed.
- **Depends on:** Step 4.

### Step 8 — Apply the canonical column order per table  *(risk: med)*

- **Files (one PR per group, lowest-traffic first):**
  `PatternTable.tsx` → `FindingsPage.tsx` → `RedirectsPage.tsx` →
  `HostInspectorPage.tsx` (5 grids) → `AnalyticsPage.tsx` (3 grids) →
  `QueryPage.tsx` → `LogsPage.tsx`.
- **Change:** tag each column with `slot`, apply the renames from §3.2, set
  `defaultHidden` per §3.3, set `defaultSortBy`/`defaultSortDir`.
- **Acceptance:** per-table — the rendered left→right order equals §3.4; the
  default sort is the specified one; hidden columns are hidden; every header
  label matches the rename table.
- **Rollback:** per page (each PR is one page).
- **Depends on:** Step 4.
- **Judgment calls to watch:** `FindingsPage` default sort
  (`id desc → log_timestamp desc`) and `RedirectsPage` (`id → last_checked_at
  desc`) — both flagged in §3.3 and the summary.

### Step 9 — Migrate `AttckFleetPage` (2 grids)  *(risk: med)*

- **Files:** `AttckFleetPage.tsx` — replace the two hand-rolled `<table>`s
  (`:209-259`, `:267-308`) with `DataTable` using the columns in §3.3.8 and the
  props from Audit §5.1. `selectable` off, no pagination.
- **Acceptance:** both grids sort (severity, hosts, risk share, requests),
  filter by enum/number, show the shared empty state; the `example_hosts` IP
  chips and `techniques` badges render through `cell`.
- **Rollback:** revert the file.
- **Depends on:** Step 4 (slots/toolbar). Independent of Steps 5–8.

### Step 10 — Migrate `ReportPage.IndicatorTable` (4 mounts)  *(risk: med)*

- **Files:** `ReportPage.tsx` — delete `IndicatorTable` (`:63-100`); replace the
  four mounts (`:404`, `:418`, `:431`, `:455`) with `DataTable`; drop the
  `.slice(0,10/25)` caps in favour of `internalPagination` + `pageSize`
  (25, or 10 for the two in-panel tables).
- **Acceptance:** all four render with the §3.4 order; the in-panel tables show
  the empty state when the window has no data; dropping the slice does not
  change the visible top-10/25 on first page.
- **Rollback:** revert; `IndicatorTable` comes back.
- **Depends on:** Step 4.

### Step 11 — Row activation, context menu, detail panel  *(risk: high)*

- **Files:** `DataTable.tsx` (`onRowActivate`, `rowMenu`, `rowDetail` slots),
  `QueryPage.tsx` (adopt `rowDetail` over its bespoke
  `EventInspectorSidebar` mount), `FindingsPage.tsx` / `RedirectsPage.tsx`
  (add `rowMenu` mirroring their `ListActionCell` items).
- **Acceptance:** right-click opens the shared menu; double-click/Enter opens the
  panel; `[`/`]`/`Escape` work; focus returns correctly.
- **Rollback:** per-surface; the panel is additive.
- **Depends on:** Steps 4, 8.

### Step 12 — Saved views, quick-filter, roving tabindex  *(risk: med)*

- **Files:** `DataTable.tsx` (`SavedView` persistence, `enableQuickFilter`,
  roving-tabindex + `role="grid"`), `useColumnState.ts`.
- **Acceptance:** save a view (sort+filters+order+visibility+density), reload,
  apply it; quick-filter narrows; arrow keys move row focus; `Enter` activates.
- **Rollback:** feature flags (`enableSavedViews`, `enableQuickFilter`); roving
  behind `enableRovingFocus`.
- **Depends on:** Steps 5, 7, 11.

### Explicit "do NOT migrate" list

| surface | reason (Audit ref) |
|---|---|
| `WhitelistDomainPage.tsx` (`:180-264`) | inline-edit review list; `DataTable` has no inline-edit or index-aware `cell` concept (Audit §5.4) |
| `BlockDomainPage.tsx` (`:203-287`) | identical inline-edit review list (Audit §5.4) |
| `TopDestinations.tsx` (`:71-116`, `:135-164`) | index-dependent rank prefix + inline bar; `DataTableColumn.cell` receives only `row`, not the index (Audit §5.3). Migrate only after `cell(row, index)` exists, or generalize `ui.RankedTable` (Option B) |
| `BlacklistPage.tsx` `FeedCard` (`:211-250`) | single-value `<ul>` list with EDL display transform + copy/delete, not a column model (Audit §5.4) |
| `JaillistPage.tsx` (renders `FeedCard`) | same, shared component (Audit §5.4) |
| `LogsPage.tsx` backup preview (`:475-496`) | fixed 3-column summary of a constant list with no row identity; a `<table>` is the right tool (Audit §5.4) |
| `ui.RankedTable` (`ui.tsx:641-683`) | already the shared primitive; leave, or generalize per §5.3 Option B — not part of this revamp |

**`UrlInvestigationPage.tsx`** (`:342`) already uses `DataTable` and is **in
scope only for the Step-8 order/rename pass**, not for a migration.

---

## 9. Verification checklist

Run from `admin-ui/`. No `npm install` is required by this spec; the commands
below are the gate for every step in §8.

```
npm run build      # tsc -b && vite build — must be green
npm run lint       # eslint — must be clean (no new warnings)
```

### 9.1 Per-table manual script

Each row: **action → expected result.** All checks at 1440×900 unless noted.

| # | table | script |
|---|---|---|
| 1 | **Patterns** (`PatternTable`) | Open Patterns → headers read `Pattern · Type · Created · ID(hidden) · [actions]`. Click `Pattern` header → asc; click again → desc; third → unsorted. Open Type filter → check `Block` → table shows only block rows; chip reads `Type: Block`; `Clear` restores. Chooser → unhide `ID` → column appears last-before-actions. |
| 2 | **Findings** (`FindingsPage`) | Default sort is `Detected ↓`. Verify `Enforcement` sits left of `Pattern`. Select two rows → bulk bar shows `2 selected`; Delete → confirm dialog. Sort `Client IP` asc then desc. Filter `Detected` to last 1h via datetime. |
| 3 | **Query** (`QueryPage`) | Headers read `Timestamp · Client IP · Server IP · Destination · URL · Base URL · Action · Enforcement · Pattern · List match · Downloaded · Uploaded · Duration · [actions]`. **D4:** find a request with both `new` and `enforcement` rows; tick one → only one ticks; console has no duplicate-key warning. Sort by `Action` → ALLOW/DENY grouped. Multi-select via Ctrl → count increments. Double-click a row → inspector opens; `Escape` closes. |
| 4 | **Logs** (`LogsPage`) | **D3:** sort by `Stored` → query-kind rows do not interleave with poll rows by a hidden number; numeric `Stored` filter returns no query rows. Headers read `Time · Type · Outcome · Webhook · Flagged · Hits · Stored · Suppressed · Dests monitored · Window · Duration · [actions]`. Bulk-delete two rows → confirm. |
| 5 | **Redirects** (`RedirectsPage`) | Default sort `Last checked ↓`. `ID` hidden by default, unhide via chooser. Filter `Status` include `active`; then exclude it → NOT semantics hold. Bulk `Check` on 2 rows. |
| 6 | **Host Inspector — log** | Page size 50. Sticky header holds under scroll. Resize `URL` narrower; reload → width restored (viewKey set). Columns `rule`/`pattern`/`category`/`country` hidden by default. |
| 7 | **Host Inspector — dom/pat/url/raw** | `% total` header now reads `Share`. `Domain` reads `Destination` in raw. No selection checkbox (not selectable). |
| 8 | **Analytics — agg** | `Share` header. Sorting `Requests` desc matches visual ranking. |
| 9 | **Analytics — raw** | **D1:** go to page 2 → rows render. Filter `Action` include `DENY`. Export "Current view" → CSV has only the visible DENY rows. |
| 10 | **ATT&CK — techniques** | Headers `Technique ID · Name · Severity · Example hosts · Hosts · [actions]`. Sort `Severity`. Example-host IP chips still call `openHost`. |
| 11 | **ATT&CK — hosts** | Headers `Host · Techniques · Risk share · Requests · [actions]`. Sort `Risk share` desc. |
| 12 | **Report — 4 tables** | `Domain · Requests · Share` / `Pattern · Hits` / `URL · Requests` / `Client IP · Requests · Last seen`. No pagination on the two in-panel tables beyond the cap; empty state shows "No data in window". |
| 13 | **Cross-cutting — density** | Toggle Compact → row height shrinks, header/toolbar unchanged; toggle back. Reload with `viewKey` → density persists. |
| 14 | **Cross-cutting — export** | Menu labels state the scope and count. CSV filename ends with a timestamp; opens in a spreadsheet with correct columns. |
| 15 | **Cross-cutting — a11y** | Tab to a header → focus ring visible; screen reader announces `aria-sort`. Tab to a row → arrow keys move focus (if roving shipped). Filter tri-state announced via `role="switch"` + label. Target sizes ≥24px in Compact (measure the checkbox hit area). |
| 16 | **Cross-cutting — motion** | Enable OS reduced-motion → no stagger/panel slide; backgrounded tab freezes CSS animation (`html[data-paused]`). |

### 9.2 Definition of done

A step is done when **all** hold:

1. `npm run build` is green and `npm run lint` is clean.
2. The step's own acceptance check above passes.
3. **No table regressions:** every table *not* touched by the step still renders
   its current column order, sort, and filters (the slot fallback guarantees
   this; verify at least Query, Findings, Logs).
4. **No console errors/warnings** (React keys, hook deps, controlled/uncontrolled
   warnings).
5. The four defects (D1–D4) remain fixed — Steps 0–3 are the regression baseline,
   re-checked after Steps 4 and 8.
6. Any new persistence key is namespaced `unetwatch_table_*` and does not collide
   with the existing `unetwatch_*` keys (`QueryPage.tsx:591`,
   `lib/utils.ts:42`, `contexts/FilterContext.tsx:55`).

---

## 10. Explicitly out of scope

This revamp will **not**:

- **Build a <768px grid.** Mobile stays horizontal-scroll; a card/list fallback
  is a separate, later piece of work.
- **Adopt `role="grid"` + full ARIA grid keyboard model unless roving tabindex
  ships** (Step 12). Until then, implicit table semantics are kept deliberately.
- **Add `cell(row, index)` / inline-edit columns.** That is the prerequisite for
  migrating `TopDestinations`/`WhitelistDomainPage`/`BlockDomainPage`, and it is
  explicitly deferred (Audit §5.3/§5.4).
- **Migrate `TopDestinations`, `WhitelistDomainPage`, `BlockDomainPage`,
  `FeedCard`, the Logs backup preview, or `ui.RankedTable`** (§8 "do NOT migrate").
- **Build virtualization now.** The policy (§6.2) is stated, the implementation
  is deferred until a page exceeds 200 rendered rows.
- **Add server-side sort for a column that the server cannot sort.** The plan
  keeps each page's existing server/client sort mode; it does not add new
  backend sort parameters.
- **Add XLSX/JSON/PDF export, scheduled export, or export-to-S3.** CSV only.
- **Change the risk model, the `accounting_tag` semantics, or `ListActionCell`'s
  action list.** Column *placement* changes; business semantics do not
  (ADR 0001/0006 stay authoritative).
- **Introduce a new design language, colour tokens, or typography.** Every new
  surface reuses `index.css` tokens, `ui.tsx` primitives, and `motion.tsx`
  helpers.
- **Add a routing/URL layer for grid state.** Persistence is `localStorage`
  under `viewKey`; the app has no view router (`localStorage`-based view state,
  `QueryPage.tsx:591`), and this spec does not add one.
- **Fix unrelated `DataTable` findings** beyond D1–D4 (e.g. moving `HeaderFilter`
  off `createPortal` is *recommended* in §5.7/§7.3 but only as part of whatever
  step touches that control).
- **Touch the backend, ES mappings, or `api.ts` contracts.** Frontend grid only.
  (The one possible exception — a unique `QueryDoc` id if the backend has one —
  is a *nice-to-have* for Step 3; the composite id fix does not depend on it.)
