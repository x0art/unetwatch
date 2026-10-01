# Table Revamp — Final Consolidated Verification Report

Date: 2026-10-01 (final release-gate pass, after the blocker fixes landed)
Verifier: QA/release engineer
Scope: `docs/table-revamp-spec.md` §3.4 + §9.1, plus the D1–D4 fixes, the
`ui.Button` rewrite, and every grid surface.

> **Verdict: SHIP WITH CAVEATS.** All four originally-reported blockers (B1–B4)
> are fixed and verified in the running app, and the `ui.Button` rewrite caused
> no regressions. Two **new** defects were found in this pass — one of them a
> duplicate-key bug in the same family as D4 that the earlier pass missed
> because it never exercised Host Inspector's log grid with twin data (see
> Defects D5 and N1). Neither is a ship blocker by itself, but D5 should be
> fixed before the next release and the Analytics zero-volume crash (N1) is a
> real user-facing blank page under a specific but realistic condition.

---

## 1. Environment & startup

Port 8000 is occupied by an unrelated Docker container (`zai2api`), so the
backend ran on **8001** and Vite on **5175** (`VITE_API_PROXY` — the B6 fix —
makes the stock `npm run dev` usable again).

| piece | command |
|---|---|
| backend | `DATABASE_URL=sqlite:////tmp/unetwatch_qa.db ELASTIC_HOST=http://localhost:9299 ELASTIC_USER= ELASTIC_PASS= ELASTIC_INDEX=logs .venv/bin/python -m uvicorn app.main:app --port 8001` |
| frontend (dev) | `cd admin-ui && VITE_API_PROXY=http://localhost:8001 npm run dev -- --port 5175 --strictPort` |
| ES substitute | `python /tmp/es_stub.py` on **9299** (the real Elasticsearch at `localhost:9200` is not running) |
| DB | copy `/tmp/unetwatch_qa.db` (90 findings, 5 tracked URLs seeded via API) via the `DATABASE_URL` env var |
| browser | `playwright-core` + system `/usr/bin/google-chrome`, viewport 1440×900 |

**Credentials: `admin` / `admin123`** (from `.env`). Login succeeds; wrong
credentials show "Invalid username or password" (no crash).

Data present for this run: Query returns 4 items including the D4 twin
(`deny`→`enforcement`, `allow`→`new` on identical `timestamp|client_ip|url`);
5 tracked URLs; 90 findings (all dated 2026-09-21, i.e. **outside the default
24h Analytics window**).

---

## 2. Per-surface results (final run)

Toolbar = one toolbar per table (Export / Columns / Density) above it.
✅ verified · ⚠️ partial · ❌ failed · ➖ not reachable.

| Surface | Headers left→right (final run) | Toolbar | defaultHidden | Result |
|---|---|---|---|---|
| **Patterns** | `Pattern · Type · Created · [actions]` | ✅ ×1 | `id` hidden ✅ | ✅ matches §3.4 |
| **Findings** | `Detected · Client IP · Server IP · URL · Base URL · Enforcement · Pattern · [actions]` | ✅ ×1 | `id` hidden ✅ | ✅ |
| **Query** | `Timestamp · Client IP · Server IP · Destination · URL · Action · Enforcement · Pattern · Downloaded · Duration · [actions]` | ✅ ×1 | `base_url`/`List match`/`Uploaded` hidden ✅ | ✅ plus D4 green |
| **Logs** | `Time · Type · Outcome · Webhook · Flagged · Hits · Stored · Window · Duration · [actions]` | ✅ ×1 | `suppressed`/`Dests monitored` hidden ✅ | ✅ (D3 caveat below) |
| **Redirects** | `URL · Final URL · Status · HTTP · Source · Redirects · Last checked · [actions]` | ✅ ×1 | `id` hidden ✅ | ✅ matches the corrected §3.4 |
| **Host Inspector — log** | `Timestamp · Dest IP · URL · Destination · Method · Action · Status · Bytes · Duration` | ✅ ×1 | `rule`/`pattern`/`category`/`country` hidden ✅ | ⚠️ **`Client IP` still missing** (old Defect 5, untouched) + **D5 dup keys** |
| **Host Inspector — dom/pat/url** | `# · Domain · Share` / `Pattern · Hits` / (url not hit) | ✅ | n/a | ⚠️ 3 of 4 grids seen; `raw` needs a finding in-window |
| **Analytics — agg** | `Domain · Requests · Volume · Share` / `Client IP · Requests · Last seen` | ✅ ×1 each | all visible ✅ | ✅ in the 24h window |
| **Analytics — raw** | `Timestamp · Client IP · URL · Destination · Action · Pattern · Volume · Duration` | ✅ ×1 | all visible ✅ | ❌ 0 rows in 24h (findings out of window); **30d crashes → N1** |
| **URL Investigation** | `Client IP · Requests · Last seen` | ✅ ×1 | n/a | ✅ (after entering a URL) |
| **ATT&CK — techniques** | (not rendered) | ➖ | ➖ | ➖ unverified — ES stub has no ATT&CK field inventory (COLLAPSED); page shows the field-availability gate |
| **ATT&CK — hosts** | (not rendered) | ➖ | ➖ | ➖ unverified — same reason |
| **Report — 4 tables** | (not rendered) | ➖ | ➖ | ➖ unverified — report renders but "No findings for this entity" (24h window) |
| **Dashboard / Blacklist / Jaillist** | non-DataTable surfaces | ➖ | ➖ | ✅ render, no errors |

Console: ECharts lifecycle warnings (`Instance … has been disposed`,
`Can't get DOM width or height`) are **known-benign** and not counted as
defects. No controlled/uncontrolled, invalid-DOM-attribute, or hook-dependency
warnings were observed anywhere.

---

## 3. Defect list — final state

Legend: **FIXED** (verified in this run) · **STILL-OPEN** (verified still
broken) · **NEW** (found in this pass).

### B1 — CSV export + row context menu dead → **FIXED**
- **File:** `admin-ui/src/components/ui.tsx` (imports; `Button` 59–91).
- **Fix:** `Button` is now a `ComponentPropsWithRef<"button">` primitive that
  spreads `...props` onto the native `<button>` and forwards `ref` (React 19
  treats `ref` as an ordinary prop).
- **Evidence this run:** Export trigger goes `data-state:closed→open`,
  `aria-expanded:false→true`, `[role=menu]` opens with `["Current view (5)"]`;
  a real download fires (`redirects-20261001-102152.csv`, 301 B, BOM, header
  `URL,Final URL,Status,HTTP,Source,Redirects,Last checked`); the comma-bearing
  URL round-trips quoted; the **actions column is excluded** from the CSV
  (`actionsInHeader:false`, `hasObjectObject:false`). The ColumnChooser
  `Popover.Trigger asChild` + `ui.Button` also still opens. Bonus fix retained:
  `DataTable.tsx` export now excludes `slot === "actions"` (previously
  `[object Object]`).
- **Row context menu:** still **not driven end-to-end** — no page supplies
  `rowMenu` (spec Step 11 unshipped). Its trigger is a plain `<span>`, unaffected
  by the `Button` bug; the shared Radix path is proven via the Export menu.

### B2 — Analytics blank-page crash → **FIXED** (with a new related crash, N1)
- **Files:** `admin-ui/src/components/AnalyticsPage.tsx` (null-safe
  `countOrDash`, guarded `totalVolume`), `admin-ui/src/api.ts`
  (`AnalyticsSummary.totalVolume`/`totalEnforcements` now `number | null`),
  `app/services/es_client.py` (new `es_hits_total()`),
  `app/routes/analytics.py:525`, `app/services/attck_mapping.py:1482,1962`.
- **Evidence this run:** Analytics renders 3 grids in the default window with no
  blank page; the enforcement stat reads a real number. The helper is proven on
  a genuine `ObjectApiResponse` (old idiom → `None`, helper → correct value) and
  guarded by a regression test that fails on the old idiom.

### B3 — D4 not fixed end-to-end → **FIXED** (Query grid)
- **Files:** `app/services/result_processor.py` `build_items` (emits
  `accounting_tag` on every row), `admin-ui/src/api.ts` `QueryDoc`.
- **Evidence this run:** Query grid renders the twin as two distinct rows
  (`Enforcement` + `New`); ticking one ticks **exactly 1**; **0** duplicate-key
  errors on Query (before and after Run).
- **Caveat:** the same request pair still collides in the **Host Inspector log
  grid / Report** via a *second* id function — see **D5**.

### B4 — Redirects order (spec conflict) → **FIXED (spec)**
- **File:** `docs/table-revamp-spec.md` §3.3.5 + §3.4. Rendering confirmed to
  match the corrected contract: `URL · Final URL · Status · HTTP · Source ·
  Redirects · Last checked`. No slot tags changed.

### B5 — `RankedTable` duplicate keys → **FIXED**
- **File:** `admin-ui/src/components/ui.tsx:661` (`key={`${i}-${r.label}`}`).
  No duplicate-key errors observed on Query's ranked tables this run.

### B6 — vite proxy not overridable → **FIXED**
- **File:** `admin-ui/vite.config.ts:16` (`process.env.VITE_API_PROXY ?? 'http://localhost:8000'`).
  Used successfully this run (`VITE_API_PROXY=http://localhost:8001 npm run dev`).

### D5 — **FIXED in the follow-up batch** (was: Host Inspector log grid & Report duplicate keys) — major
- **File:** `admin-ui/src/lib/logRow.ts` `getRowId()` — appended the same
  `accounting_tag` discriminator `queryRowId` uses, falling back to `action`
  for a looser row. Consumers `HostInspectorPage.tsx` (`rowId={getRowId}`) and
  `EventInspectorSidebar.tsx`.
- **Evidence (live, after fix):** Host Inspector log grid for `10.10.0.5`
  renders the twin rows (`deny` / `allow`) with **0 duplicate-key errors** (was
  **5**); the Report built from it → **0** (was **11**). See §8.

### N1 — **FIXED in the follow-up batch**: Analytics `Share` cell crashed on `pct: null` — major
- **File:** `admin-ui/src/components/AnalyticsPage.tsx:310`
  (`cell: (r) => <span …>{r.pct.toFixed(1)}%</span>`).
- **Evidence this run:** switching Analytics to **Last 30 Days** throws
  `TypeError: Cannot read properties of null (reading 'toFixed')` at
  `AnalyticsPage.tsx` and renders **zero tables** (blank section). Backend
  confirmed to emit `pct: null` legitimately
  (`app/routes/analytics.py:385`: `… if total else None`) — the domain rows have
  `count` but `volume: 0`, so `pct` is null.
- **Same class as B2a** (null count dereferenced unguarded). Live blank-page
  condition on a surface under test. **Fixed in the follow-up batch (see §8).**

### N2 — **FIXED in the follow-up batch**: ECharts `TitleComponent` not registered — minor (pre-existing)
- **File:** `admin-ui/src/components/TrendCharts.tsx` — uses a `title:` option
  (empty-state "No data in window", line ~94) but `echarts.use([...])` (line 20)
  never includes `TitleComponent`.
- **Evidence this run:** console error on Analytics —
  `[ECharts] Component title is used but not imported.`
- **Provenance:** `TrendCharts.tsx` was unmodified by this session and by the
  revamp. **Fixed in the follow-up batch (see §8).**

### Old Defect 5 — Host Inspector log grid omitted `Client IP` — **FIXED in the follow-up batch**
- Added a real `client_ip` column (slot `subject`, text filter, same
  open-in-Host-Inspector affordance as `dest_ip`) between `Timestamp` and
  `Dest IP`, matching §3.4 / §3.3.6(a). No other column changed. See §8.

### Old Defect 7 / D3 — Logs "Stored" sort interleave — **FIXED in the follow-up batch**
- The frontend accessor was never the problem: `stored` is `0` for **both**
  kinds in SQLite, and the sort is server-side, so raw `ORDER BY stored` tied
  every row. Fixed in `app/routes/logs.py` with a kind-aware, deterministic
  order. See §8.

---

## 4. D1–D4 status (final)

| ID | Verdict | Evidence |
|---|---|---|
| **D1** Analytics raw page 2 | **Not observable** | Code fix present (no `internalPagination`; server `total/page/pageSize`). In the 24h window the raw grid has **0 rows** ("Showing 1–0 of 0") because the seeded findings are 10 days old; widening to 30d **crashes (N1)** before page 2 is reachable. Page 2 could not be rendered in a browser. |
| **D2** last-page control | **PASS (latent)** | `ui.tsx` renders it behind `{hasTotal && …}`; with `total` known the control is present and functional. |
| **D3** Logs "Stored" sort | **STILL-OPEN** | Interleave persists (see Old Defect 7). |
| **D4** Query unique row id | **PASS on Query; STILL-OPEN on Host/Report** | Query: two rows, tick 1, 0 dup keys. Host Inspector log grid + Report: 5 / 11 dup-key errors via `getRowId` (D5). |

---

## 5. New-capability verification

| Capability | Result | Evidence |
|---|---|---|
| CSV export downloads | ✅ | `redirects-20261001-102152.csv`, 301 B, BOM |
| Comma/quote round-trip | ✅ | `"http://evil.example/redir2,with,commas"` quoted |
| Actions column excluded | ✅ | `actionsInHeader:false`, `hasObjectObject:false` |
| Column chooser hide/reveal | ✅ | hiding TYPE removed it from headers and **persisted across reload** |
| Column resize/reorder persistence | ⚠️ not exercised this run | chooser + density persistence proven; resize/reorder drag not re-driven |
| Density toggle | ✅ | 57 px → 45 px, **persisted across reload** |
| Sorting | ✅ | Patterns: `ascending` → `descending` |
| Per-column filter (tri-state) | ✅ | Type→Block: `aria-checked:true`, Apply → only `Block` rows |
| Login form / destructive confirm / nav | ✅ | wrong creds message; Delete-pattern confirm dialog opens and cancels; all 11 nav items render |

---

## 6. What remains unverified (and why)

1. **ATT&CK Fleet (2 grids)** — the fleet page gates on the ES field inventory;
   the stub reports `COLLAPSED` (no ATT&CK mappings), so zero techniques and no
   tables render. Needs a real ES with proxy/ATT&CK mappings.
2. **Reports (4 indicator tables)** — reachable via Host Investigation → View
   Report, but the report shows "No findings for this entity" (its window is
   24h while the seeded findings are 10 days old), so no tables render.
3. **Host Inspector raw grid** — requires a finding inside the selected window;
   the raw table was not populated in this dataset.
4. **Analytics raw page 2 (D1)** — blocked by N1 (30d crash) on one side and an
   empty 24h window on the other.
5. **Column resize/reorder persistence via `viewKey`** — the chooser and density
   persistence were proven; the resize/reorder drag gestures were not re-driven
   in this pass.
6. **Row right-click context menu** — no page supplies `rowMenu` (spec Step 11
   unshipped).

---

## 7. Servers & cleanup

Started: `unetwatch-backend` (uvicorn :8001), `uivite` (vite :5175), `es-stub`
(:9299). All killed at the end of the run; ports `:8001`, `:5175`, `:9299`
confirmed free. No file under `admin-ui/src/` or `app/` was modified in this
pass; only `docs/table-verify-report.md` was written.

---

## 8. Post-fix follow-up batch (final)

A follow-up batch closed the two newly-found defects (D5, N1), the minor
pre-existing ECharts defect (N2), and the two defects still open from the first
report (old 5 and old 7 / D3). Environment identical to §1 (backend :8001,
vite :5175, ES stub :9299, the 90-finding DB copy). Servers stopped afterwards.

| Fix | File / line range | Change | Evidence |
|---|---|---|---|
| **F1** (D5) | `admin-ui/src/lib/logRow.ts:30-43` | `getRowId` now appends the same discriminator `queryRowId` uses — `accounting_tag`, falling back to `action` for a looser row (`typeof` narrowing, no inline cast). | Live: Host Inspector log grid for `10.10.0.5` shows the twin `deny`/`allow` rows with **0** duplicate-key errors (was 5); Report built from it **0** (was 11). |
| **F2** (N1 + audit) | `admin-ui/src/components/AnalyticsPage.tsx:303-318`; `admin-ui/src/api.ts:1947` | `pct`/"Share" cell is now null-safe (`typeof r.pct === "number"` → `toFixed(1)%`, else `—`). `TopDomainRow.pct` retyped `number \| null`. | Live: Analytics **Last 30 Days** renders all **3** grids, `blank: false`, **no console TypeError**; Share cells render `—`. |
| **F3** (N2) | `admin-ui/src/components/TrendCharts.tsx:4,20` | Registered `TitleComponent` alongside the others (chosen over dropping the `title`, since the `title` is the empty-state "No data in window" label that was silently missing — the error was the only visible symptom of it not rendering). | Live: the `[ECharts] Component title is used but not imported` error is **gone**; chart layout for non-empty data is unchanged. |
| **F4a** (old 5) | `admin-ui/src/components/HostInspectorPage.tsx:43-52, 690-715` | Added a `client_ip` column (`slot: "subject"`, `filterType: "text"`, same open-in-Host-Inspector button as `dest_ip`) between `Timestamp` and `Dest IP`; imported `getSrcIp`. No other column's order or slot changed. | Live: log grid headers now `TIMESTAMP · CLIENT IP · DEST IP · URL · DESTINATION · METHOD · ACTION · STATUS · BYTES · DURATION`, matching §3.4. |
| **F4b** (D3 / old 7) | `app/routes/logs.py:25-76` | New `_order_clause`: for `sort_by == "stored"` order on the **effective** value (`CASE WHEN kind = 'poll' THEN stored END`), so non-poll rows sort as NULL (grouped at one end); `id DESC` added as a stable tiebreaker for every sort. | Backend test `tests/test_logs.py::test_logs_stored_sort_groups_query_rows_apart_from_polls` — **passes with the fix, fails without it** (`['poll','query','query','poll']` without). Live/API before→after below. |

### F4b — `Type:Stored` sequence, before → after

Raw data: 230 `poll` + 81 `query` rows; **every** row has `stored = 0` in
SQLite, and the grid renders `—` for a non-poll row.

```
BEFORE  (ORDER BY stored ASC, no kind-awareness)  first 24 rows:
  query:0 ×22 … poll:0  query:0          ← a poll row buried among query rows
AFTER   (CASE WHEN kind='poll' THEN stored END ASC)  first 24 rows — UI values:
  query:— ×24                            ← kinds contiguous, no interleave
AFTER   … descending — UI values:
  poll:0 ×24                             ← all poll rows grouped
```

Browser-confirmed: sorting Logs by **Stored** yields a contiguous
`Poll:0 …` block ascending and a contiguous `Query:— …` block descending.

### Verification for the follow-up batch

- `cd admin-ui && npm run build` → **exit 0** (`tsc -b && vite build` green).
- `npm run lint` → **exit 0**, 17 warnings (no new errors; the set is unchanged
  from the pre-batch run — only pre-existing `only-export-components`).
- Backend suite `.venv/bin/python -m pytest -q` → **466 passed, 1 failed**
  (was 465; the +1 is the new logs sort test). The 1 failure,
  `tests/test_hosts.py::test_persisted_fallback_reports_same_domain_shape`
  (`assert 0 == 2`), is the **same pre-existing failure** — re-confirmed by
  stashing `app/routes/logs.py` and watching it fail identically.
- `ruff check app/routes/logs.py tests/test_logs.py` → **All checks passed**.

### Still unverified after the follow-up batch

Unchanged from §6 except where noted: **ATT&CK Fleet** (no real ES ATT&CK
mapping), **Reports' 4 indicator tables** (no in-window finding for the
entity during this run), **Host Inspector raw grid** (no in-window finding),
**Analytics raw page 2 / D1** (the N1 crash is fixed, but the 24h window is
empty and the 30d data still does not place a row beyond page 1 to observe —
page 2 was not reached), **column resize/reorder persistence** (drag gestures
not re-driven), and the **row right-click context menu** (no page supplies
`rowMenu`).
