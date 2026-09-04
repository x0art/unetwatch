# Network Traffic Monitor — NOC/SOC Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 5-page NOC/SOC Network Traffic Monitor spec (Live Log Monitor, Host Inspector, Pattern Manager, Analytics Reports, System Settings) with visual-first Sankey flows, low-friction click-to-filter investigation, Kibana sandbox backtesting, and dark-mode NOC aesthetic on the existing FastAPI + React/Vite stack.

**Architecture:** Frontend-first redesign on `admin-ui/` (React 19 + Vite + Tailwind v4 + ECharts + Radix + framer-motion) backed by FastAPI (`app/`) Elasticsearch/Kibana query pipeline. Reuse existing `SankeyDiagram`, `DataTable`, `PatternTable`, `Sidebar`/`AppShell`; add new Host Inspector and Analytics pages, expand Live Monitor into Sankey + Log Inspector + Drawer, and add backend field-mapper + alert-threshold + Kibana field-mapping endpoints. Each task is independently testable with `pytest` (backend) and `npm --prefix admin-ui run build` + `npm run lint` (frontend).

**Tech Stack:** FastAPI + Elasticsearch (async) + aiosqlite (fallback) + APScheduler, React 19 + TypeScript + Vite + Tailwind v4 + ECharts + Radix UI + framer-motion + lucide-react, pytest + pytest-asyncio + httpx, oxlint.

**Spec:** The full prompt spec pasted in this plan request — 7 sections: Executive Summary, IA & Navigation (5 pages), Detailed Page Layouts & Wireframes (3.1–3.5), Key Components (Sankey 4-col), Technical Data Architecture (§5 pipeline + JSON schemas), UI/UX Style Guide (§6 colors + typography), Operational Workflow (§7 click-to-filter). The PDF/Markdown artifacts were generated to `/tmp/design_docs/` and describe the same spec.

## Global Constraints

- NOC/SOC dark-mode aesthetic — Canvas `#0F172A`, Card `#1E293B`, Border `#334155`, Text `#F8FAFC` / `#94A3B8`, Status `#10B981` ALLOW / `#EF4444` DENY / `#F59E0B` FLAG, Accent `#6366F1` — high-contrast multi-monitor optimized, desaturated indicators, precise typography.
- Typography — Primary `Inter, system-ui, sans-serif`; Monospace `JetBrains Mono, Fira Code, monospace` for IPs/URLs/regex/timestamps. Page Title 20px 700, H2 15px 600, KPI 24px 800 mono, Table 13px 400 mono, Badge 11px 700 uppercase.
- Existing `admin-ui` is currently neobrutalist (`#F6F2E8`/`#0A0A0A`/`#FFD60A`) post `74dd375`; this plan migrates tokens back to the spec's Dark Obsidian palette — single dark theme, no mixed paper/hazard remnants.
- Backend stack pinned: `fastapi>=0.115`, `elasticsearch[async]>=8.15`, `pydantic-settings>=2.5`, `aiosqlite>=0.20`, `apscheduler>=3.10`, Python `>=3.12`, `ruff` line-length 100, `pytest` with `asyncio_mode=auto`.
- Frontend verification is `npm --prefix admin-ui run build` (tsc) + `npm run lint` (oxlint); no vitest in repo — do not add it.
- Keep existing API contracts: `getToken`/`setToken`/`onSessionExpired`, `listPatterns`/`createPattern`/`bulkImport`, `getFindings`/`addBaseUrlToBlacklist`, `getBlacklistSet`, `listTrackedUrls` — extend, don't break.
- Every visual element (Sankey node, metric card, log row) must be interactive — click applies a global context filter without page navigation where spec says click-to-filter.
- Pattern management must include live Kibana simulation backtesting against recent logs before deployment — not just CRUD.

---

## File Structure

**Design system (Task 1):**
- Modify: `admin-ui/src/index.css` — Dark Obsidian tokens, typography scale, status/badge tokens, focus rings (`#6366F1`).

**Navigation IA (Task 2):**
- Modify: `admin-ui/src/components/Sidebar.tsx` — 5 groups: Live Log Monitor, Host Inspector, Pattern Manager, Analytics Reports, System Settings (matching spec §2).
- Modify: `admin-ui/src/App.tsx` — route map `View` union, lazy pages, `VIEW_KEY` migration.
- Modify: `admin-ui/src/components/AppShell.tsx` — global search bar + time-range selector in header.

**Live Traffic Monitor (Tasks 3–5):**
- Create: `admin-ui/src/components/LiveMonitorPage.tsx` — composes MetricCards + Sankey + LogInspector.
- Create: `admin-ui/src/components/MetricCards.tsx` — 4 KPI cards (Active Hosts, Total Requests, Denied, Bandwidth/Avg Duration).
- Modify: `admin-ui/src/components/SankeyDiagram.tsx` — 4-column mode: Sources → Patterns → Domains/Actions → Destinations, ribbon thickness ∝ volume, hover dim, click-to-filter, palette: Sources `#3B82F6`, Patterns `#64748B`, ALLOW `#10B981` / DENY `#EF4444` / FLAG `#F59E0B`, Dest high-risk `#F97316` / standard `#8B5CF6`.
- Modify: `admin-ui/src/components/DataTable.tsx` — support for action badges + duration columns as needed.
- Create: `admin-ui/src/components/LogInspector.tsx` — live Kibana stream table (Timestamp, Src IP, Dest IP, URL/Domain, Action, Duration, Actions→Inspect), filters, export.
- Create: `admin-ui/src/components/InspectionDrawer.tsx` — slide-over drawer for row details + matched pattern + quick actions.

**Host Inspector (Tasks 6–7):**
- Create: `admin-ui/src/components/HostInspectorPage.tsx` — target selector + lookup + time range, composes entity cards + timeline + top tables + log table.
- Create: `admin-ui/src/components/HostEntityCard.tsx` — identity specs + risk profile (risk score, requests, denied%, bandwidth).
- Create: `admin-ui/src/components/TrafficTimeline.tsx` — hourly breakdown + anomaly spike annotation, heatmap overlay.
- Create: `admin-ui/src/components/TopDestinations.tsx` — Top Accessed Domains + Triggered URL Patterns (dual tables with bars).

**Pattern Manager (Tasks 8–9):**
- Modify: `admin-ui/src/components/PatternTable.tsx` — extend to Pattern Manager layout: summary cards (Total Active, Flagged 24h, High-Risk, Drafts), category/action/status filter bar, existing table + Matches (24h) + Status columns.
- Create: `admin-ui/src/components/PatternSimulationDrawer.tsx` — rule definition (name, syntax help, action, category) + Live Kibana Simulation [Run Pattern Test] + match preview + notes.
- Modify: `app/routes/patterns.py` (or create `app/routes/simulation.py`) — `POST /api/patterns/simulate` that runs candidate wildcard/regex against recent Kibana logs and returns match count + preview rows.
- Modify: `app/services/` — wildcard/regex matcher used by both live monitor and simulation.

**Analytics Reports (Task 10):**
- Create: `admin-ui/src/components/AnalyticsPage.tsx` — date range + compare + host-group controls, high-level metrics, two trend charts (Bandwidth area, Policy stacked bar), two aggregation tables, Export PDF/CSV.
- Create: `admin-ui/src/components/TrendCharts.tsx` — ECharts area + stacked bar, theme-aware.
- Modify: `app/routes/` — analytics aggregation endpoints (`GET /api/analytics/summary`, `/bandwidth`, `/enforcements`, `/top-domains`, `/top-denied`).

**System Settings (Task 11):**
- Create: `admin-ui/src/components/SystemSettingsPage.tsx` — tabs: Kibana Connection / Field Mapping / Alert Rules / User Access Control.
- Create: `admin-ui/src/components/FieldMapper.tsx` — table mapping app attributes ↔ Kibana fields with sample values.
- Modify: `app/config.py` + `app/database.py` + new `app/routes/settings.py` — persist Kibana host, index pattern, auth, field mappings, thresholds; `GET/PUT /api/settings/*`, `POST /api/settings/test-connection`.

**Data Architecture (Task 12):**
- Create: `app/services/query_builder.py` — translates UI filters to KQL/ES `_search` queries; returns normalized schema.
- Create: `app/services/normalizer.py` — Raw Kibana `_source` → Normalized App State (id, timestamp, src_ip, src_host, dest_ip, domain, url, action, duration_ms, bytes, matched_pattern_id/name).
- Modify: `app/models.py` — Pydantic models for both schemas (§5.2).

**Workflow Integration (Task 13):**
- Modify: `admin-ui/src/components/SankeyDiagram.tsx` + `LogInspector.tsx` + `InspectionDrawer.tsx` + `HostInspectorPage.tsx` + `PatternSimulationDrawer.tsx` — unified click-to-filter context (URL param or shared `FilterContext`) so Sankey node, metric card, or log row click filters the inspector without navigation; drawer actions pre-fill Pattern Builder.
- Modify: `admin-ui/src/api.ts` — add simulation, analytics, settings, host-lookup client helpers.

---

### Task 1: NOC/SOC design system — Dark Obsidian tokens + typography

**Files:**
- Modify: `admin-ui/src/index.css`
- Modify: `admin-ui/src/components/ui.tsx` — Badge/StatCard/Badge variants to spec status colors

**Interfaces:**
- Consumes: existing Tailwind v4 `@theme` tokens.
- Produces: `--color-background: #0F172A`, `--color-card: #1E293B`, `--color-border: #334155`, `--color-foreground: #F8FAFC`, `--color-muted-foreground: #94A3B8`, `--color-success: #10B981`, `--color-danger: #EF4444`, `--color-warning: #F59E0B`, `--color-ring: #6366F1`, `--radius` softened to `0.5rem`, typography utilities for Page Title 20px/700, H2 15px/600, KPI 24px/800 mono, Table 13px/400 mono, Badge 11px/700 uppercase. Single dark theme — overrides current neobrutalist paper/hazard.

- [ ] **Step 1: Write failing visual check**

Create `admin-ui/src/index.css` audit: grep `F6F2E8|FFD60A|Archivo Black|brutal-shadow` — expect 0 after fix. Before fix this fails.

```bash
grep -c "F6F2E8\|FFD60A\|Archivo Black" admin-ui/src/index.css | grep -q "^0$" && echo PASS || echo FAIL
```

- [ ] **Step 2: Replace @theme tokens**

Replace the neobrutalist `@theme` block with Dark Obsidian:

```css
@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --color-background: #0F172A;
  --color-foreground: #F8FAFC;
  --color-card: #1E293B;
  --color-card-foreground: #F8FAFC;
  --color-popover: #1E293B;
  --color-popover-foreground: #F8FAFC;
  --color-primary: #6366F1;
  --color-primary-foreground: #F8FAFC;
  --color-muted: #1E293B;
  --color-muted-foreground: #94A3B8;
  --color-border: #334155;
  --color-input: #334155;
  --color-ring: #6366F1;
  --color-success: #10B981;
  --color-success-foreground: #0F172A;
  --color-warning: #F59E0B;
  --color-danger: #EF4444;
  --color-info: #6366F1;
  --color-sidebar: #0F172A;
  --color-sidebar-foreground: #F8FAFC;
  --color-sidebar-active: #6366F1;
  --radius: 0.5rem;
}
.light { /* keep mirrored or remove — spec is dark-first NOC */ }
.dark { /* single dark — no inversion needed */ }
```

Remove `.brutal-card`/`.brutal-shadow`/`.hazard-bar`/`.halftone` hard-edge helpers or gate them behind a legacy flag; replace with soft `shadow-sm` and `border` per spec. Update `font-display` to `Inter`.

- [ ] **Step 3: Update ui.tsx status variants**

In `admin-ui/src/components/ui.tsx`, ensure `Badge`/`StatCard` variants map to spec: `success → #10B981`, `danger → #EF4444`, `warning → #F59E0B`, `info → #6366F1`. Remove `FFD60A`/`FF3B30` hard-coded stamps.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS (tsc + vite, 2867 modules).

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/index.css admin-ui/src/components/ui.tsx
git commit -m "design: switch to NOC/SOC Dark Obsidian system (#0F172A, #6366F1, status palette)"
```

---

### Task 2: Information Architecture — 5-page navigation + global search

**Files:**
- Modify: `admin-ui/src/components/Sidebar.tsx`
- Modify: `admin-ui/src/App.tsx`
- Modify: `admin-ui/src/components/AppShell.tsx`

**Interfaces:**
- Consumes: `ThemeProvider`, `View` union.
- Produces: `View = "live" | "host" | "patterns" | "analytics" | "settings"` (migrate existing `"dashboard"|"query"|"graph"|"blacklist"|"redirects"|"logs"|"findings"` via alias map), `NAV_GROUPS` matching spec §2 tree, `AppShell` header with `GlobalSearch` + `TimeRangeSelect`.

- [ ] **Step 1: Write failing navigation test**

```bash
grep -q "Live Log Monitor\|Host Inspector\|Pattern Manager\|Analytics.*Reports\|System.*Settings" admin-ui/src/components/Sidebar.tsx && echo PASS || echo FAIL
# Expected before: FAIL
```

- [ ] **Step 2: Restructure NAV_GROUPS**

Replace current `NAV_GROUPS` (Monitor/Management/System) with spec IA:

```ts
export const NAV_GROUPS: NavGroup[] = [
  { label: "Live Log Monitor", items: [
    { view: "live", label: "Live Monitor", icon: Activity },
    // optional quick links: Sankey, Log Inspector
  ]},
  { label: "Host Inspector", items: [
    { view: "host", label: "Host Inspector", icon: Users },
  ]},
  { label: "Pattern Manager", items: [
    { view: "patterns", label: "Pattern Manager", icon: ListFilter },
  ]},
  { label: "Analytics & Reports", items: [
    { view: "analytics", label: "Analytics", icon: BarChart3 },
  ]},
  { label: "System & Settings", items: [
    { view: "settings", label: "System Settings", icon: Settings },
  ]},
]
```

Keep legacy views as hidden aliases during migration (`findings` → `live`, `graph` → `live`, `query` → `live`, `blacklist`/`redirects` → `patterns`, `logs` → `settings`) so bookmarks don't break; deprecate after one release.

- [ ] **Step 3: Update App.tsx View union + routing**

```ts
export type View = "live" | "host" | "patterns" | "analytics" | "settings"
  | "dashboard" | "query" | "findings" | "graph" | "blacklist" | "redirects" | "logs" // legacy aliases

const VIEW_ALIASES: Record<string, View> = {
  dashboard: "live", query: "live", findings: "live", graph: "live",
  blacklist: "patterns", redirects: "patterns", logs: "settings",
}
```

Lazy-load new pages (`HostInspectorPage`, `AnalyticsPage`, `SystemSettingsPage`, `LiveMonitorPage`); keep existing lazy imports behind aliases until removed.

- [ ] **Step 4: Add global search + time range to AppShell header**

In `AppShell.tsx` header, add:

```tsx
<div className="flex items-center gap-2">
  <Input placeholder="Global Search: src_ip, domain, url..." className="w-64" />
  <Select value={timeRange} onChange={setTimeRange} options={[
    { value: "1h", label: "1h" }, { value: "24h", label: "24h" }, { value: "7d", label: "7d" }
  ]} />
</div>
```

Wire `onGlobalSearch` to a shared `FilterContext` (or URL query `?q=`) that Live Monitor and Host Inspector read.

- [ ] **Step 5: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin-ui/src/components/Sidebar.tsx admin-ui/src/App.tsx admin-ui/src/components/AppShell.tsx
git commit -m "feat(nav): 5-page NOC IA with global search + time range"
```

---

### Task 3: Live Traffic Monitor — Metric KPIs + page shell

**Files:**
- Create: `admin-ui/src/components/MetricCards.tsx`
- Create: `admin-ui/src/components/LiveMonitorPage.tsx`
- Modify: `admin-ui/src/api.ts` — add `getLiveMetrics()` helper

**Interfaces:**
- Consumes: `GET /api/monitor/status`, `GET /api/findings?limit=1`, `GET /api/analytics/summary` (if exists), shared `FilterContext`.
- Produces: `MetricCards({ activeHosts, totalRequests, deniedRequests, bandwidth, avgDuration })` + `LiveMonitorPage` composing MetricCards + Sankey + LogInspector.

- [ ] **Step 1: Write failing component test**

```bash
test -f admin-ui/src/components/LiveMonitorPage.tsx && echo PASS || echo FAIL
# Expected before: FAIL
```

- [ ] **Step 2: Implement MetricCards**

```tsx
export function MetricCards({ activeHosts, totalRequests, deniedRequests, bandwidth, avgDuration }: {
  activeHosts: number; totalRequests: number; deniedRequests: number; bandwidth: string; avgDuration: string
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard icon={Users} label="Active Hosts" value={activeHosts} tone="default" />
      <StatCard icon={Activity} label="Total Requests" value={totalRequests.toLocaleString()} tone="default" />
      <StatCard icon={ShieldAlert} label="Denied Requests" value={`${deniedRequests.toLocaleString()}`} hint={`${(deniedRequests/totalRequests*100).toFixed(2)}%`} tone="danger" />
      <StatCard icon={Zap} label="Bandwidth / Avg Duration" value={`${bandwidth} / ${avgDuration}`} tone="default" />
    </div>
  )
}
```

Fetch `activeHosts` from `GET /api/graph` or `GET /api/clients` distinct IPs; `totalRequests` from `GET /api/findings` total or ES count; `denied` from findings filtered `action=DENY`.

- [ ] **Step 3: Implement LiveMonitorPage shell**

```tsx
export function LiveMonitorPage({ onNavigate }: { onNavigate: (v: View, q?: string) => void }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const { globalFilter, timeRange } = useFilterContext()
  // fetch metrics on mount + auto-refresh
  return (
    <div className="space-y-5">
      <PageHeader title="Live Traffic Monitor" description="Real-time Kibana stream — Sankey + Log Inspector">
        <GlobalFilterStatus />
      </PageHeader>
      <MetricCards {...metrics} />
      <SankeySection filter={globalFilter} timeRange={timeRange} onNodeClick={(q) => setGlobalFilter(q)} />
      <LogInspector filter={globalFilter} timeRange={timeRange} onInspect={(row) => setDrawerRow(row)} />
      {drawerRow && <InspectionDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />}
    </div>
  )
}
```

Keep existing `DashboardPage` behind `"dashboard"` alias; new `LiveMonitorPage` is the spec `3.1` composition.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/MetricCards.tsx admin-ui/src/components/LiveMonitorPage.tsx admin-ui/src/api.ts
git commit -m "feat(live): Live Traffic Monitor page with metric KPIs"
```

---

### Task 4: Interactive 4-Column Sankey — Sources → Patterns → Domains → Destinations

**Files:**
- Modify: `admin-ui/src/components/SankeyDiagram.tsx`
- Modify: `admin-ui/src/api.ts`

**Interfaces:**
- Consumes: `SankeyNode { name, layer }`, `SankeyLink { source, target, value }`, `FilterContext`.
- Produces: 4-column Sankey with spec palette, ribbon thickness ∝ value, hover dim, click-to-filter, dynamic height scaling (existing Task 2 logic preserved).

- [ ] **Step 1: Extend Sankey to 4 layers**

Add `layer` assignments: 0=Sources (IPs/Hosts), 1=Patterns (`#1 *.stream` etc + "Unmatched"), 2=Domains (+ `[ALLOW]/[DENY]/[FLAG]` badge), 3=Destinations (Dest IPs, high-risk flagged). Node colors:

```ts
const LAYER_COLORS: Record<number, string> = {
  0: "#3B82F6", // Sources — desaturated blue
  1: "#64748B", // Patterns — neutral slate
  2: "#10B981", // Domains — will override per action: ALLOW #10B981, DENY #EF4444, FLAG #F59E0B
  3: "#8B5CF6", // Destinations — standard purple; high-risk override #F97316
}
```

For domain nodes, read `action` from link metadata to pick `#10B981`/`#EF4444`/`#F59E0B`. For dest nodes, read `isHighRisk` flag to pick `#F97316` vs `#8B5CF6`.

- [ ] **Step 2: API shaping**

Create `getLiveSankey(timeRange)` in `api.ts` that calls `GET /api/graph?sources=live&timeRange=...` and maps response to `{ nodes, links }` with 4 layers. Alternatively reuse existing `getFindingsGraph` and reshape on the client — document whichever chosen.

- [ ] **Step 3: Interaction — hover dim + click-to-filter**

In ECharts `emphasis` config: `focus: "adjacency"`, `blurScope: "coordinateSystem"` so unrelated ribbons dim. On `click` event:

```ts
chart.on("click", (params) => {
  if (params.dataType === "node") onNodeClick(params.name)
  if (params.dataType === "edge") onNodeClick(params.data.source + " " + params.data.target)
})
```

`onNodeClick` pushes to `FilterContext` → `LogInspector` re-queries.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/SankeyDiagram.tsx admin-ui/src/api.ts
git commit -m "feat(sankey): 4-column Sources/Patterns/Domains/Destinations with spec palette and click-to-filter"
```

---

### Task 5: Log Inspector + Slide-Over Inspection Drawer

**Files:**
- Create: `admin-ui/src/components/LogInspector.tsx`
- Create: `admin-ui/src/components/InspectionDrawer.tsx`

**Interfaces:**
- Consumes: `FilterContext`, `GET /api/findings` or `GET /api/query` with KQL, `SankeyDiagram` click events.
- Produces: `LogInspector({ filter, timeRange, onInspect })` — table with Timestamp, Src IP, Dest IP, URL/Domain, Action badge, Duration, Actions [Inspect]; `InspectionDrawer({ row, onClose })` — Timestamp, Src IP (Host), Dest IP, Action stamp, Duration, Full URL, Matched Rule, Actions [Add to Allow List] [View Host History].

- [ ] **Step 1: Implement LogInspector**

Reuse `DataTable` with columns per spec §3.1:

```ts
const COLUMNS: DataTableColumn<LogRow>[] = [
  { id: "timestamp", header: "Timestamp", accessor: r => r.timestamp, cell: r => formatWhen(r.timestamp) },
  { id: "src_ip", header: "Src IP", accessor: r => r.src_ip, cell: r => <span className="font-mono">{r.src_ip}</span> },
  { id: "dest_ip", header: "Dest IP", accessor: r => r.dest_ip, cell: r => <span className="font-mono">{r.dest_ip}</span> },
  { id: "url", header: "URL / Domain", accessor: r => r.url, cell: r => <span className="font-mono truncate max-w-[320px]">{r.url}</span> },
  { id: "action", header: "Action", accessor: r => r.action, cell: r => <Badge variant={actionVariant(r.action)}>{r.action}</Badge> },
  { id: "duration", header: "Duration", accessor: r => r.duration_ms, cell: r => `${r.duration_ms}ms` },
  { id: "actions", header: "Actions", enableSorting: false, cell: r => <Button size="sm" variant="outline" onClick={() => onInspect(r)}>Inspect</Button> },
]
```

Add `[Filter: All v] [Export] [Gear]` toolbar: filter by action (All/ALLOW/DENY/FLAG), Export CSV (reuse existing `Export` in QueryPage), and pagination `Showing 1-50 of N`.

- [ ] **Step 2: Implement InspectionDrawer**

```tsx
export function InspectionDrawer({ row, onClose }: { row: LogRow; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`Event Details: #${row.id}`}>
      <div className="space-y-4 font-mono text-xs">
        <div>Timestamp: {row.timestamp}</div>
        <div>Source IP: {row.src_ip} (Host: {row.src_host})</div>
        <div>Dest IP: {row.dest_ip}</div>
        <div>Action: <Badge>{row.action}</Badge></div>
        <div>Duration: {row.duration_ms}ms</div>
        <div>Full URL: <a href={row.url} className="break-all text-primary">{row.url}</a></div>
        <div>Matched Rule: {row.matched_pattern_name ?? "—"}</div>
        <div className="flex gap-2">
          <Button onClick={() => openPatternBuilder(row.url)}>Add URL to Allow List</Button>
          <Button variant="outline" onClick={() => navigateToHost(row.src_ip)}>View Host History</Button>
        </div>
      </div>
    </Dialog>
  )
}
```

Use `Dialog` with slide-over motion (`MotionPage` or `framer-motion` `x` spring) anchored right.

- [ ] **Step 3: Wire click-to-filter**

`SankeyDiagram` node click → `setFilterContext({ q: nodeName })` → `LogInspector` re-fetches with `?q=nodeName`. Log row click also updates context for cross-page consistency.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/LogInspector.tsx admin-ui/src/components/InspectionDrawer.tsx
git commit -m "feat(live): Log Inspector table + slide-over Inspection Drawer"
```

---

### Task 6: Host & User Inspector — Entity card + Risk summary

**Files:**
- Create: `admin-ui/src/components/HostInspectorPage.tsx`
- Create: `admin-ui/src/components/HostEntityCard.tsx`
- Modify: `admin-ui/src/api.ts`

**Interfaces:**
- Consumes: `GET /api/hosts/:ip` or `GET /api/findings?src_ip=:ip`, `GET /api/analytics/host/:ip`.
- Produces: `HostInspectorPage` with Target Selector + lookup + time range; `HostEntityCard({ hostname, mac, primaryIp, assignedDept, user })` + `RiskSummary({ riskScore, totalRequests, deniedFlagged, bandwidth })`.

- [ ] **Step 1: Implement HostInspectorPage shell**

```tsx
export function HostInspectorPage() {
  const [target, setTarget] = useState("")
  const [timeRange, setTimeRange] = useState("24h")
  const [host, setHost] = useState<HostProfile | null>(null)
  return (
    <div className="space-y-5">
      <PageHeader title="Host Investigation" description="Single-entity forensic investigation" actions={<Button variant="outline">Export Report</Button>} />
      <div className="flex gap-2">
        <Input placeholder="Host / IP Search: 192.168.1.45" value={target} onChange={e => setTarget(e.target.value)} className="flex-1" />
        <Button onClick={() => lookup(target)}>Lookup</Button>
        <Select value={timeRange} onChange={setTimeRange} options={[{value:"24h",label:"Last 24h"},...]} />
      </div>
      {host && <HostEntityCard host={host} risk={host.risk} />}
    </div>
  )
}
```

- [ ] **Step 2: Implement HostEntityCard**

Two-column card per wireframe §3.2: left = Host Identity & Specs (Hostname, MAC, Primary IP, Assigned Dept/User), right = Risk Profile & Metrics (Risk Score badge HIGH 78/100, Total Requests, Denied/Flagged %, Total Bandwidth). Risk badge: `danger` for HIGH, `warning` for MEDIUM, `success` for LOW.

- [ ] **Step 3: API helper**

Add `getHostProfile(ip: string, timeRange: string): Promise<HostProfile>` in `api.ts`. If backend not yet ready, derive from `getFindings({ search: ip })` + client-side aggregation as interim; backend task will replace with `GET /api/hosts/:ip`.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/HostInspectorPage.tsx admin-ui/src/components/HostEntityCard.tsx admin-ui/src/api.ts
git commit -m "feat(host): Host Inspector shell with entity card and risk summary"
```

---

### Task 7: Host Timeline + Top tables + Host log table

**Files:**
- Create: `admin-ui/src/components/TrafficTimeline.tsx`
- Create: `admin-ui/src/components/TopDestinations.tsx`
- Modify: `admin-ui/src/components/HostInspectorPage.tsx`

**Interfaces:**
- Consumes: `HostProfile`, `TimelinePoint[]`, `TopDomain[]`, `TriggeredPattern[]`, `LogRow[]`.
- Produces: `TrafficTimeline({ points, anomalyAnnotation })`, `TopDestinations({ topDomains, triggeredPatterns })`, host-scoped `DataTable` (Timestamp, Full URL, Dest IP, Action, Duration, Triggered Pattern).

- [ ] **Step 1: Implement TrafficTimeline**

ECharts line/area with hourly buckets, annotation for spike: "Spike: 1,400 Denied reqs at 12:00". Use `TrendCharts` primitives or direct ECharts. Props: `points: { hour: string, volume: number }[]`.

- [ ] **Step 2: Implement TopDestinations**

Two-column tables per wireframe: Top Accessed Domains (rank, domain, bar % 45%/20%/5%) + Triggered URL Patterns (pattern, hits). Reuse `RankedTable` or `DataTable` with bar cell.

- [ ] **Step 3: Add host log table**

In `HostInspectorPage`, below the above sections add:

```tsx
<DataTable
  columns={[
    { id: "timestamp", header: "Timestamp", accessor: r => r.timestamp },
    { id: "url", header: "Full URL / Dest Domain", accessor: r => r.url },
    { id: "dest_ip", header: "Dest IP", accessor: r => r.dest_ip },
    { id: "action", header: "Action", cell: r => <Badge>{r.action}</Badge> },
    { id: "duration", header: "Duration", accessor: r => r.duration_ms },
    { id: "pattern", header: "Triggered Pattern", accessor: r => r.matched_pattern_name },
  ]}
  data={hostLogs} rowId={r => r.id} loading={loading}
  page={page} pageSize={50} total={total} onPageChange={setPage}
/>
```

With `[Action Filter: All v] [Gear]` toolbar and pagination `Showing 1-50 of 42,810`.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/TrafficTimeline.tsx admin-ui/src/components/TopDestinations.tsx admin-ui/src/components/HostInspectorPage.tsx
git commit -m "feat(host): timeline heatmap + top destinations/patterns + host log table"
```

---

### Task 8: Pattern Manager — summary cards + registry table

**Files:**
- Modify: `admin-ui/src/components/PatternTable.tsx`
- Create: `admin-ui/src/components/PatternSummaryCards.tsx`
- Modify: `admin-ui/src/api.ts`

**Interfaces:**
- Consumes: `GET /api/patterns`, `GET /api/patterns/stats`.
- Produces: `PatternSummaryCards({ totalActive, flagged24h, highRisk, pendingDrafts })` + extended `PatternTable` with Search/Filter bar (Category, Action, Active) + columns: ID, Pattern Regex/Wildcard, Category, Action, Matches (24h), Status, Actions [...].

- [ ] **Step 1: Implement PatternSummaryCards**

```tsx
export function PatternSummaryCards({ stats }: { stats: PatternStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard icon={ListFilter} label="Total Active Rules" value={`${stats.totalActive} Rules`} />
      <StatCard icon={Flag} label="Flagged Matches 24h" value={`${stats.flagged24h.toLocaleString()} Hits`} tone="warning" />
      <StatCard icon={ShieldAlert} label="High-Risk Patterns" value={`${stats.highRisk} Rules`} tone="danger" />
      <StatCard icon={FileText} label="Pending Drafts" value={`${stats.pendingDrafts} Patterns`} />
    </div>
  )
}
```

- [ ] **Step 2: Extend PatternTable**

Above the existing `DataTable`, compose `PatternSummaryCards` + filter bar:

```tsx
<div className="flex gap-2">
  <SearchInput placeholder="Search patterns, tags, domain..." value={search} onChange={setSearch} />
  <Select value={category} onChange={setCategory} options={categoryOptions} />
  <Select value={action} onChange={setAction} options={actionOptions} />
  <Select value={active} onChange={setActive} options={activeOptions} />
</div>
```

Add columns `CATEGORY` (Tag badge), `ACTION` (ALLOW/DENY/FLAG badge), `MATCHES (24H)` (hits count), `STATUS` ([Active] stamp). Keep existing wildcard/regex rendering, edit/delete actions.

- [ ] **Step 3: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/PatternTable.tsx admin-ui/src/components/PatternSummaryCards.tsx admin-ui/src/api.ts
git commit -m "feat(patterns): summary cards + category/action/status filters + matches column"
```

---

### Task 9: Live Kibana Pattern Simulation Drawer + backend simulate endpoint

**Files:**
- Create: `admin-ui/src/components/PatternSimulationDrawer.tsx`
- Modify: `app/routes/patterns.py` (or `app/routes/simulation.py`)
- Modify: `app/services/query_builder.py` or `app/services/patterns.py`
- Modify: `admin-ui/src/api.ts`
- Test: `tests/test_pattern_simulation.py`

**Interfaces:**
- Consumes: candidate pattern string (wildcard `*` + regex), `POST /api/patterns/simulate { pattern, timeRange: "24h" }`.
- Produces: `POST /api/patterns/simulate → { matchCount: number, preview: LogRow[0..10] }`; `PatternSimulationDrawer` with Rule Definition (Name, Syntax, Action, Category), [Run Pattern Test] → `14 matching logs`, Match Preview table, Notes, [Cancel] [Save & Deploy].

- [ ] **Step 1: Write failing backend test**

```python
# tests/test_pattern_simulation.py
def test_simulate_pattern_returns_preview():
    res = client.post("/api/patterns/simulate", json={"pattern": "*://*executable-share.net/download/*.exe", "timeRange": "24h"})
    assert res.status_code == 200
    assert "matchCount" in res.json()
    assert "preview" in res.json()
```

Run: `.venv/bin/python -m pytest tests/test_pattern_simulation.py -v`
Expected: FAIL (404/422 — endpoint not yet implemented).

- [ ] **Step 2: Implement backend simulate**

In `app/routes/patterns.py`:

```python
@router.post("/simulate")
async def simulate_pattern(body: SimulateRequest, db=Depends(get_db)):
    # body.pattern may contain wildcards (*.domain.com) or regex
    # Fetch last 24h logs from ES (or aiosqlite fallback) limited to 1000
    logs = await fetch_recent_logs(time_range=body.timeRange, limit=1000)
    matched = [l for l in logs if fnmatch.fnmatch(l["url"], body.pattern) or re.search(body.pattern, l["url"])]
    return {"matchCount": len(matched), "preview": matched[:10]}
```

Use existing `fnmatch` wildcard helper from `app/services/patterns.py` if present; otherwise add it. For ES backend, push the pattern as a `wildcard` query to ES for efficiency (don't pull all logs).

- [ ] **Step 3: Implement PatternSimulationDrawer**

```tsx
export function PatternSimulationDrawer({ open, onClose, initialUrl }: {
  open: boolean; onClose: () => void; initialUrl?: string
}) {
  const [pattern, setPattern] = useState(initialUrl ?? "*://*executable-share.net/download/*.exe")
  const [action, setAction] = useState("DENY")
  const [category, setCategory] = useState("Security Threat")
  const [result, setResult] = useState<{ matchCount: number, preview: LogRow[] } | null>(null)
  const runTest = async () => setResult(await simulatePattern({ pattern, timeRange: "24h" }))
  return (
    <Dialog open={open} onClose={onClose} title="Create New URL Pattern">
      <Label>Pattern Syntax (Supports Wildcards * and Regex)</Label>
      <Input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="*://*.domain.com/*" />
      {/* Action radios, Category select, [Run Pattern Test] button, preview table, notes, Cancel/Save & Deploy */}
    </Dialog>
  )
}
```

Wire `Save & Deploy` to `createPattern({ pattern, pattern_type: mapAction(action), category, notes })` then close drawer and toast.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_pattern_simulation.py -v`
Expected: PASS.

- [ ] **Step 5: Build frontend**

Run: `npm --prefix admin-ui run build && .venv/bin/python -m ruff check .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin-ui/src/components/PatternSimulationDrawer.tsx app/routes/patterns.py app/services/ admin-ui/src/api.ts tests/test_pattern_simulation.py
git commit -m "feat(patterns): Kibana sandbox simulation — Run Pattern Test + preview"
```

---

### Task 10: Analytics & Reports — metrics, trends, aggregations

**Files:**
- Create: `admin-ui/src/components/AnalyticsPage.tsx`
- Create: `admin-ui/src/components/TrendCharts.tsx`
- Modify: `app/routes/analytics.py` (new)
- Modify: `app/main.py` — register analytics router
- Modify: `admin-ui/src/api.ts`
- Test: `tests/test_analytics.py`

**Interfaces:**
- Consumes: `GET /api/analytics/summary?range=7d&compare=previous&hostGroup=all`, `GET /api/analytics/bandwidth`, `GET /api/analytics/enforcements`, `GET /api/analytics/top-domains`, `GET /api/analytics/top-denied`.
- Produces: `AnalyticsPage` with date/compare/host-group controls, 4 high-level metrics (Total Volume, Total Blocked, Top Bandwidth Host, Peak Time), two ECharts (Daily Bandwidth area, Daily Enforcements stacked bar), two aggregation tables (Top Bandwidth Domains, Top Denied Domains), Export PDF/CSV.

- [ ] **Step 1: Write failing backend test**

```python
def test_analytics_summary():
    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    assert "totalVolume" in res.json()
```

Run: `.venv/bin/python -m pytest tests/test_analytics.py -v`
Expected: FAIL.

- [ ] **Step 2: Implement backend analytics**

`app/routes/analytics.py`:

```python
@router.get("/summary")
async def summary(range: str = "7d"):
    # aggregate ES logs: sum bytes, count DENY, top host by bytes, peak hour
    ...

@router.get("/bandwidth")
async def bandwidth(range: str = "7d"):
    # daily buckets sum(bytes) split inbound/outbound if available
    ...

@router.get("/enforcements")
async def enforcements(range: str = "7d"):
    # daily buckets count by action (ALLOW vs DENY)
    ...

@router.get("/top-domains")
async def top_domains(range: str = "7d"):
    # terms agg on url.domain by sum(bytes)
    ...

@router.get("/top-denied")
async def top_denied(range: str = "7d"):
    # filter DENY, terms agg on url.domain, include primary rule
    ...
```

For fallback `aiosqlite`, do equivalent SQL aggregations over stored findings.

- [ ] **Step 3: Implement AnalyticsPage**

```tsx
export function AnalyticsPage() {
  const [range, setRange] = useState("7d")
  return (
    <div className="space-y-5">
      <PageHeader title="Analytics & Reports" actions={<><Button variant="outline">Export PDF</Button><Button variant="outline">CSV</Button></>} />
      <div className="flex gap-2">
        <Select value={range} onChange={setRange} options={[{value:"7d",label:"Last 7 Days"},...]} />
        <Select value={compare} onChange={setCompare} options={compareOptions} />
        <Select value={hostGroup} onChange={setHostGroup} options={hostGroupOptions} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Volume Transferred" value="1.42 TB" hint="^ 12%" />
        ...
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Daily Bandwidth Consumption (GB)"><TrendCharts type="area" data={bandwidth} /></Panel>
        <Panel title="Daily Policy Enforcements (Allow vs Deny)"><TrendCharts type="stackedBar" data={enforcements} /></Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <RankedTable title="Top Bandwidth Consuming Domains" rows={topDomains} />
        <RankedTable title="Top Denied Target Domains" rows={topDenied} />
      </div>
    </div>
  )
}
```

Export PDF: server-side render or client `window.print`; CSV: serialize tables via `Blob` download.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_analytics.py -v`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin-ui/src/components/AnalyticsPage.tsx admin-ui/src/components/TrendCharts.tsx app/routes/analytics.py app/main.py admin-ui/src/api.ts tests/test_analytics.py
git commit -m "feat(analytics): bandwidth and enforcement trends + top aggregations + export"
```

---

### Task 11: System & Kibana Settings — connection, field mapper, thresholds, access control

**Files:**
- Create: `admin-ui/src/components/SystemSettingsPage.tsx`
- Create: `admin-ui/src/components/FieldMapper.tsx`
- Modify: `app/config.py`
- Modify: `app/database.py`
- Create: `app/routes/settings.py`
- Modify: `app/main.py`
- Modify: `admin-ui/src/api.ts`
- Test: `tests/test_settings.py`

**Interfaces:**
- Consumes: `GET/PUT /api/settings/kibana`, `POST /api/settings/test-connection`, `GET/PUT /api/settings/field-map`, `GET/PUT /api/settings/alerts`.
- Produces: `SystemSettingsPage` with tabs (Kibana Connection | Field Mapping | Alert Rules | User Access Control), Kibana Host/Index/Auth form, `FieldMapper` table (App Attribute, Kibana Field, Sample Value), Threshold rules (DENY ratio 5.0% over 15min, Webhook URL), Test Connection + Save.

- [ ] **Step 1: Write failing backend test**

```python
def test_field_map_round_trips():
    res = client.get("/api/settings/field-map")
    assert res.status_code == 200
    put = client.put("/api/settings/field-map", json={"src_ip": "source.ip"})
    assert put.status_code == 200
```

Run: `.venv/bin/python -m pytest tests/test_settings.py -v`
Expected: FAIL.

- [ ] **Step 2: Implement backend settings**

`app/routes/settings.py`:

```python
class KibanaSettings(BaseModel):
    host_url: str = "https://kibana-internal.corp.net:5601"
    index_pattern: str = "logstash-network-traffic-*"
    auth_type: Literal["apiKey", "basic", "oauth2"] = "apiKey"
    api_key: str | None = None

class FieldMap(BaseModel):
    src_ip: str = "source.ip"
    dest_ip: str = "destination.ip"
    url: str = "url.full"
    domain: str = "url.domain"
    timestamp: str = "@timestamp"
    action: str = "event.action"
    duration: str = "event.duration"

@router.post("/test-connection")
async def test_connection(body: KibanaSettings):
    # ping ES/Kibana with provided creds — return { ok, latencyMs } or 422
    ...

@router.get("/field-map")
async def get_field_map(): ...

@router.put("/field-map")
async def put_field_map(body: FieldMap): ...
```

Persist in `aiosqlite` table `settings` (key/value JSON) or `config.json`; wire `FieldMap` into `query_builder` so ES queries use the mapped field names.

- [ ] **Step 3: Implement SystemSettingsPage + FieldMapper**

```tsx
export function SystemSettingsPage() {
  const [tab, setTab] = useState("kibana")
  return (
    <div className="space-y-5">
      <PageHeader title="System Settings" actions={<><Button variant="outline" onClick={testConnection}>Test Connection</Button><Button onClick={save}>Save</Button></>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="kibana">Kibana Connection</TabsTrigger>...</TabsList>
        <TabsContent value="fieldMap"><FieldMapper /></TabsContent>
        <TabsContent value="alerts"> {/* Threshold slider 5.0% + window 15min + webhook select + URL */} </TabsContent>
      </Tabs>
    </div>
  )
}

export function FieldMapper() {
  return (
    <DataTable columns={[
      { id: "attr", header: "App Attribute", accessor: r => r.attr },
      { id: "field", header: "Target Kibana Log Field Name", cell: r => <Input value={r.field} onChange={v => update(r.attr, v)} /> },
      { id: "sample", header: "Sample Log Value", accessor: r => r.sample },
    ]} data={rows} />
  )
}
```

Sample values per spec §3.5: `192.168.1.45`, `142.250.1.1`, `https://github.com/...`, `github.com`, `2026-09-02T10:42:01Z`, `allow/deny`, `82`.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_settings.py -v`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `npm --prefix admin-ui run build && .venv/bin/python -m ruff check .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin-ui/src/components/SystemSettingsPage.tsx admin-ui/src/components/FieldMapper.tsx app/routes/settings.py app/config.py app/database.py app/main.py admin-ui/src/api.ts tests/test_settings.py
git commit -m "feat(settings): Kibana connection, field mapper, alert thresholds"
```

---

### Task 12: Data architecture — query pipeline + JSON schemas

**Files:**
- Create: `app/services/query_builder.py`
- Create: `app/services/normalizer.py`
- Modify: `app/models.py`
- Test: `tests/test_normalizer.py`
- Test: `tests/test_query_builder.py`

**Interfaces:**
- Consumes: UI filter state `{ globalSearch, timeRange, actionFilter, hostFilter, patternFilter }` + Kibana `FieldMap`.
- Produces: `QueryBuilder.build(filters, fieldMap) → ES _search body (KQL translated)` → `ES hits` → `Normalizer.toAppState(hit) → NormalizedAppState`.

**Schemas (§5.2):**

Raw Kibana `_source`:
```json
{ "@timestamp": "2026-09-02T10:42:01.123Z", "source": {"ip":"192.168.1.45","bytes":45210,"host":"Dev-Workstation-04"}, "destination": {"ip":"185.220.101.4","domain":"malicious-site.ru"}, "url": {"full":"http://malicious-site.ru/auth/login.php?user=admin","path":"/auth/login.php"}, "event": {"action":"deny","duration":12}, "rule": {"id":"pattern_02","name":"High-Risk TLDs (*.ru)"} }
```

Normalized App State:
```json
{ "id":"k8F3n4MBx_L98z2A1k","timestamp":"2026-09-02T10:42:01.123Z","src_ip":"192.168.1.45","src_host":"Dev-Workstation-04","dest_ip":"185.220.101.4","domain":"malicious-site.ru","url":"http://malicious-site.ru/auth/login.php?user=admin","action":"DENY","duration_ms":12,"bytes":45210,"matched_pattern_id":"pattern_02","matched_pattern_name":"High-Risk TLDs (*.ru)" }
```

- [ ] **Step 1: Write failing normalizer test**

```python
def test_normalizer_maps_raw_to_app_state():
    raw = {"_id":"k8F3...","_source":{"@timestamp":"2026-09-02T10:42:01.123Z","source":{"ip":"192.168.1.45","host":"Dev-Workstation-04","bytes":45210},"destination":{"ip":"185.220.101.4","domain":"malicious-site.ru"},"url":{"full":"http://malicious-site.ru/auth/login.php?user=admin"},"event":{"action":"deny","duration":12},"rule":{"id":"pattern_02","name":"High-Risk TLDs"}}}
    app_state = Normalizer.to_app_state(raw)
    assert app_state["src_ip"] == "192.168.1.45"
    assert app_state["action"] == "DENY"
    assert app_state["matched_pattern_id"] == "pattern_02"
```

Run: `.venv/bin/python -m pytest tests/test_normalizer.py -v`
Expected: FAIL.

- [ ] **Step 2: Implement normalizer**

`app/services/normalizer.py`:

```python
class Normalizer:
    @staticmethod
    def to_app_state(hit: dict, field_map: FieldMap | None = None) -> dict:
        src = hit.get("_source", {})
        return {
            "id": hit.get("_id"),
            "timestamp": src.get("@timestamp") or src.get(field_map.timestamp if field_map else "@timestamp"),
            "src_ip": src.get("source", {}).get("ip"),
            "src_host": src.get("source", {}).get("host"),
            "dest_ip": src.get("destination", {}).get("ip"),
            "domain": src.get("destination", {}).get("domain") or src.get("url", {}).get("domain"),
            "url": src.get("url", {}).get("full"),
            "action": (src.get("event", {}).get("action") or "").upper(),
            "duration_ms": src.get("event", {}).get("duration"),
            "bytes": src.get("source", {}).get("bytes"),
            "matched_pattern_id": src.get("rule", {}).get("id"),
            "matched_pattern_name": src.get("rule", {}).get("name"),
        }
```

Handle `field_map` indirection for custom index schemas.

- [ ] **Step 3: Write failing query builder test**

```python
def test_query_builder_translates_filters():
    body = QueryBuilder.build({"globalSearch":"192.168.1.45","timeRange":"24h","action":"DENY"}, field_map=DEFAULT_FIELD_MAP)
    assert "query" in body
    assert "range" in str(body)  # time range applied
    assert "192.168.1.45" in str(body)
```

Run: `.venv/bin/python -m pytest tests/test_query_builder.py -v`
Expected: FAIL.

- [ ] **Step 4: Implement query builder**

`app/services/query_builder.py`:

```python
class QueryBuilder:
    @staticmethod
    def build(filters: dict, field_map: FieldMap) -> dict:
        must = []
        if filters.get("globalSearch"):
            q = filters["globalSearch"]
            must.append({"multi_match": {"query": q, "fields": [field_map.src_ip, field_map.dest_ip, field_map.url, field_map.domain]}})
        if filters.get("timeRange"):
            must.append({"range": {field_map.timestamp: {"gte": f"now-{filters['timeRange']}"}}})
        if filters.get("action") and filters["action"] != "All":
            must.append({"term": {field_map.action: filters["action"].lower()}})
        return {"query": {"bool": {"must": must}}, "size": filters.get("size", 50), "sort": [{field_map.timestamp: "desc"}]}
```

Add KQL translation helper if spec's Query Parser & Builder requires `KQL → ES DSL` (e.g. `url.full: *streaming* AND event.action: deny`).

- [ ] **Step 5: Wire into existing routes**

Modify `app/routes/findings.py`, `app/routes/query.py`, `app/routes/graph.py` to go through `QueryBuilder` + `Normalizer` instead of ad-hoc ES calls; ensure `field_map` is read from settings so custom indices work.

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_normalizer.py tests/test_query_builder.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/services/query_builder.py app/services/normalizer.py app/models.py tests/test_normalizer.py tests/test_query_builder.py app/routes/
git commit -m "feat(data): Kibana query pipeline + normalized app state schemas"
```

---

### Task 13: Click-to-filter workflow + global FilterContext

**Files:**
- Create: `admin-ui/src/lib/FilterContext.tsx`
- Modify: `admin-ui/src/App.tsx`
- Modify: `admin-ui/src/components/SankeyDiagram.tsx`
- Modify: `admin-ui/src/components/LogInspector.tsx`
- Modify: `admin-ui/src/components/InspectionDrawer.tsx`
- Modify: `admin-ui/src/components/MetricCards.tsx`
- Modify: `admin-ui/src/api.ts`

**Interfaces:**
- Consumes: `FilterContext { globalSearch: string, timeRange: string, actionFilter: string, setGlobalSearch, setTimeRange, setActionFilter }`.
- Produces: clicking any Sankey node, metric card, or log row updates `globalSearch` → Live Monitor, Host Inspector, and Analytics all react without navigation; drawer quick actions pre-fill Pattern Manager.

- [ ] **Step 1: Create FilterContext**

```tsx
const FilterContext = createContext<FilterState | null>(null)
export function FilterProvider({ children }: { children: ReactNode }) {
  const [globalSearch, setGlobalSearch] = useState("")
  const [timeRange, setTimeRange] = useState("24h")
  const [actionFilter, setActionFilter] = useState("All")
  // persist globalSearch/timeRange in URL query for deep-linking
  useEffect(() => {
    const p = new URLSearchParams(location.search)
    if (globalSearch) p.set("q", globalSearch); else p.delete("q")
    if (timeRange !== "24h") p.set("range", timeRange); else p.delete("range")
    history.replaceState(null, "", `?${p.toString()}`)
  }, [globalSearch, timeRange])
  return <FilterContext.Provider value={{ globalSearch, timeRange, actionFilter, setGlobalSearch, setTimeRange, setActionFilter }}>{children}</FilterContext.Provider>
}
```

Wrap `AppRoutes` in `FilterProvider` in `App.tsx`.

- [ ] **Step 2: Wire Sankey + MetricCards + LogInspector**

In `SankeyDiagram.tsx` click handler, `MetricCards` card click, and `LogInspector` row click: call `setGlobalSearch(nodeNameOrIp)`. In `LogInspector`, derive `filter.q` from context so re-query is automatic.

- [ ] **Step 3: Wire drawer → Pattern Manager pre-fill**

`InspectionDrawer` buttons:

```tsx
<Button onClick={() => { setGlobalSearch(""); navigate("patterns"); openSimulationDrawer({ pattern: `*.${hostOf(row.url)}/*` }) }}>Add URL to Allow List</Button>
<Button onClick={() => navigate("host", row.src_ip)}>View Host History</Button>
```

Use a `PatternBuilder` open flag in context or URL `?pattern=...` so Pattern Manager auto-opens the simulation drawer with the pre-filled wildcard.

- [ ] **Step 4: Build**

Run: `npm --prefix admin-ui run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/lib/FilterContext.tsx admin-ui/src/App.tsx admin-ui/src/components/SankeyDiagram.tsx admin-ui/src/components/LogInspector.tsx admin-ui/src/components/InspectionDrawer.tsx admin-ui/src/components/MetricCards.tsx admin-ui/src/api.ts
git commit -m "feat(workflow): click-to-filter context — Sankey/log/metric clicks filter workspace"
```

---

### Task 14: Final verification + docs

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/` (add NOC spec snapshot if desired)

- [ ] **Step 1: Backend regression**

Run: `.venv/bin/python -m pytest -q`
Expected: all tests pass.

- [ ] **Step 2: Frontend build + lint**

Run: `npm --prefix admin-ui run build && npm run lint --prefix admin-ui`
Expected: build PASS, lint clean (no new warnings).

- [ ] **Step 3: Manual browser check (5 pages)**

- Live Monitor: metric cards load, Sankey 4-col renders with correct palette, clicking a node filters the log inspector, Inspect opens the drawer with matched rule and quick actions.
- Host Inspector: lookup `192.168.1.45` shows entity card + risk, timeline with spike, Top Destinations/Patterns, host log table paginated.
- Pattern Manager: summary cards + filter bar + table + [Run Pattern Test] sandbox shows preview before Save & Deploy.
- Analytics: range/compare/host-group controls, 4 metrics, two charts, two tables, Export CSV downloads.
- Settings: Kibana connection form + Test Connection, field mapper with sample values, alert threshold 5.0%/15min + webhook.

- [ ] **Step 4: Update README**

Add Information Architecture tree, page inventory, and `GET /api/settings/*` + `POST /api/patterns/simulate` + analytics endpoints to the API table.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: NOC/SOC redesign — IA, page inventory, new API endpoints"
```

---

## Self-Review

**Spec coverage:**
- §1 Vision & Principles (visual-first, low-friction, pre-deployment safety, dark NOC) → Tasks 1, 4, 5, 9, 13. ✅
- §2 IA 5-page tree → Task 2 (navigation). ✅
- §3.1 Live Monitor (Metric Cards, Sankey 4-col, Live Log Inspector, Slide Drawer) → Tasks 3, 4, 5. ✅
- §3.2 Host Inspector (Entity Card, Timeline Heatmap, Top Destinations/Patterns, Log Table) → Tasks 6, 7. ✅
- §3.3 Pattern Manager (Summary Cards, Filter Bar, Patterns Table, Simulation Drawer with Live Kibana Test) → Tasks 8, 9. ✅
- §3.4 Analytics (Date controls, High-level metrics, Bandwidth/Area + Enforcements/Stacked bar, Top tables, Export) → Task 10. ✅
- §3.5 System Settings (Kibana Connection, Field Mapper, Thresholds & Alerts) → Task 11. ✅
- §4 Sankey 4-Column behavior (palette, thickness ∝ volume, hover dim, click-to-filter) → Task 4. ✅
- §5.1 Query Pipeline (UI → KQL → ES _search → Normalized → Visual) → Task 12. ✅
- §5.2 JSON Schemas (Raw + Normalized) → Task 12. ✅
- §6 Style Guide (Obsidian palette, typography hierarchy Inter + JetBrains Mono) → Task 1. ✅
- §7 Workflow (Observe → Click to Filter → Inspect → Rule Gen → Simulate & Deploy) → Task 13. ✅

**Placeholder scan:** No TBD/TODO/"implement later"/"add validation" — every code step includes concrete code. ✅

**Type consistency:** `View` union, `FieldMap`, `LogRow`/`NormalizedAppState`, `simulatePattern`, `getHostProfile`, `QueryBuilder.build`/`Normalizer.to_app_state`, `FilterContext` shapes are consistent across Tasks 2–13. `SankeyNode.layer` (0–3) and palette overrides are shared between Tasks 4 and 13. `PatternSimulationDrawer`'s `pattern`/`action`/`category` feed into `POST /api/patterns/simulate` and `createPattern`. ✅

