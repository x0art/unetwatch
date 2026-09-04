import { useEffect, useMemo, useState } from "react"
import { Activity, Link2, Search, SearchX, Settings2, Download, ShieldAlert, ShieldCheck } from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { Button, Input, Select, PageHeader, Panel, Skeleton, Badge, useToast } from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { HostEntityCard } from "./HostEntityCard"
import { TrafficTimeline, type TimelinePoint } from "./TrafficTimeline"
import { TopDestinations, type TopDomain, type TriggeredPattern } from "./TopDestinations"
import {
  addBaseUrlToBlacklist,
  bulkImport,
  getHostProfile,
  runQuery,
  timeRangeToMinutesLive,
  formatBytes,
  type QueryDoc,
  type HostProfile,
} from "../api"
import {
  getDestIp,
  getDurationMs,
  getMatchedRule,
  getRowId,
  actionVariant,
  hostOfUrl,
  type LogRow,
} from "../lib/logRow"

const TIME_RANGE_OPTIONS = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
]

const ACTION_FILTER_OPTIONS = [
  { value: "All", label: "All" },
  { value: "ALLOW", label: "ALLOW" },
  { value: "DENY", label: "DENY" },
  { value: "FLAG", label: "FLAG" },
]

const DEMO_IP = "192.168.1.45"

/* ── Section data (timeline + top tables + host log rows) ────────────── */

interface HostSectionData {
  timeline: TimelinePoint[]
  anomaly?: string
  topDomains: TopDomain[]
  triggeredPatterns: TriggeredPattern[]
  topUrls: { url: string; count: number }[]
  logs: LogRow[]
  logTotal: number
  window: string
  /** Demo-only paging metadata so the 42,810-count pagination is fully wired. */
  demoMeta?: { destIps: string[]; patterns: TriggeredPattern[]; urls: string[]; baseNow: number }
}

const EMPTY_SECTIONS: HostSectionData = {
  timeline: [],
  topDomains: [],
  triggeredPatterns: [],
  topUrls: [],
  logs: [],
  logTotal: 0,
  window: "24h",
}

function windowLabel(tr: string): string {
  return TIME_RANGE_OPTIONS.find((o) => o.value === tr)?.label ?? tr
}

/** HH:MM label from an ISO bucket (mono, matches the wireframe axis). */
function formatHour(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function buildTopDomains(items: QueryDoc[]): TopDomain[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const domain = it.base_url || hostOfUrl(it.url) || "unknown"
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  const total = Math.max(1, items.length)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, count]) => ({ domain, count, pct: (count / total) * 100 }))
}

function buildTriggeredPatterns(items: QueryDoc[]): TriggeredPattern[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const pats = it.blocked_by.length > 0 ? it.blocked_by : ["Unmatched"]
    for (const p of pats) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([pattern, hits]) => ({ pattern, hits }))
}

/** Ranked URLs for the host — each row links into URL Investigation. */
function buildTopUrls(items: QueryDoc[], limit = 8): { url: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const url = it.url || hostOfUrl(it.url) || "unknown"
    counts.set(url, (counts.get(url) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url, count]) => ({ url, count }))
}

/** Flag the largest hourly bucket when it towers over the rest. */
function detectSpike(points: TimelinePoint[]): string | undefined {
  if (points.length < 2) return undefined
  const volumes = points.map((p) => p.volume)
  const max = Math.max(...volumes)
  const second = [...volumes].sort((a, b) => b - a)[1] ?? 0
  if (max > 0 && max > second * 1.5) {
    const point = points.find((p) => p.volume === max)!
    return `Spike: ${max.toLocaleString()} Denied reqs at ${point.hour}`
  }
  return undefined
}

async function fetchHostSections(ip: string, timeRange: string): Promise<HostSectionData> {
  const minutes = timeRangeToMinutesLive(timeRange)
  const isDemo = ip.trim() === DEMO_IP

  // Prefer live ES rows filtered to this host — richest source (action-aware,
  // pattern matches, durations). Backend caps items at 500; total_requests is
  // the real window total and drives the "Showing 1-50 of 42,810" summary.
  try {
    const res = await runQuery(minutes, { q: ip.trim() })
    if (res.items.length > 0) {
      const timeline = res.timeline.map((t) => ({ hour: formatHour(t.bucket), volume: t.count }))
      const topDomains = buildTopDomains(res.items)
      const triggeredPatterns = buildTriggeredPatterns(res.items)
      const topUrls = buildTopUrls(res.items)
      const logs = (res.items as unknown as LogRow[]).map((r) => ({ ...r }))
      return {
        timeline,
        anomaly: detectSpike(timeline),
        topDomains,
        triggeredPatterns,
        topUrls,
        logs,
        logTotal: res.total_requests || res.items.length,
        window: timeRange,
      }
    }
  } catch {
    /* fall through to demo/empty */
  }

  // ES offline / no matches — synthesize the wireframe demo section so the
  // spec IP (192.168.1.45) still renders the full layout with its numbers.
  if (isDemo) return buildDemoSections(timeRange)

  return { ...EMPTY_SECTIONS, window: timeRange }
}

function buildDemoSections(timeRange: string): HostSectionData {
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const timeline: TimelinePoint[] = hours.map((h) => ({
    hour: `${String(h).padStart(2, "0")}:00`,
    // 12:00 spike mirrors the spec annotation ("Spike: 1,400 Denied reqs at 12:00")
    volume: h === 12 ? 1400 : 40 + Math.round(Math.abs(Math.sin(h * 1.7)) * 160),
  }))

  const domains: TopDomain[] = [
    { domain: "api.internal.corp", count: 19264, pct: 45 },
    { domain: "s3.amazonaws.com", count: 8562, pct: 20 },
    { domain: "zoom.us", count: 5140, pct: 12 },
    { domain: "msteams.microsoft.com", count: 3425, pct: 8 },
    { domain: "github.com", count: 2140, pct: 5 },
  ]

  const patterns: TriggeredPattern[] = [
    { pattern: "*/admin/*", hits: 3214 },
    { pattern: "*.exe download*", hits: 1832 },
    { pattern: "*/wp-admin/*", hits: 1120 },
    { pattern: "*paypal*", hits: 940 },
    { pattern: "*/login*", hits: 512 },
  ]

  const topUrls = [
    { url: "https://api.internal.corp/v1/data/pull?token=abc", count: 19264 },
    { url: "https://s3.amazonaws.com/releases/client-installer.exe", count: 8562 },
    { url: "https://zoom.us/j/82461730291", count: 5140 },
  ]

  // Demo window is synthesize-only; keep logs deterministic via a single
  // factory so pagination can materialize lazily across the full 42,810 count.
  const demoBaseNow = Date.now()
  const demoMeta = {
    destIps: ["10.0.0.21", "52.218.64.11", "162.159.128.61", "13.107.42.12", "140.82.112.3"],
    patterns,
    urls: [
      "https://api.internal.corp/v1/data/pull?token=abc",
      "https://s3.amazonaws.com/releases/client-installer.exe",
      "https://zoom.us/j/82461730291",
      "https://msteams.microsoft.com/share/threads/19:abc",
      "https://github.com/acme/monitor/releases/download/v2/agent.exe",
    ],
    baseNow: demoBaseNow,
  } satisfies HostSectionData["demoMeta"]
  const DEMO_TOTAL = 42810
  const firstPageLogs: LogRow[] = buildDemoRows(0, 50, demoBaseNow, demoMeta)

  return {
    timeline,
    anomaly: detectSpike(timeline),
    topDomains: domains,
    triggeredPatterns: patterns,
    topUrls,
    logs: firstPageLogs,
    logTotal: DEMO_TOTAL,
    window: timeRange,
    demoMeta,
  }
}

/** Demo row action — must stay in sync with buildDemoRow below. */
function demoActionForIndex(i: number): "ALLOW" | "DENY" | "FLAG" {
  if (i % 7 === 0) return "DENY"
  if (i % 5 === 0) return "FLAG"
  return "ALLOW"
}

function buildDemoRow(
  i: number,
  baseNow: number,
  meta: { destIps: string[]; patterns: TriggeredPattern[]; urls: string[] },
): LogRow {
  const action = demoActionForIndex(i)
  const matched = action === "ALLOW" ? null : meta.patterns[i % meta.patterns.length].pattern
  const dip = meta.destIps[i % meta.destIps.length]
  const u = meta.urls[i % meta.urls.length]
  return {
    id: i,
    timestamp: new Date(baseNow - i * 13 * 60 * 1000).toISOString(),
    client_ip: DEMO_IP,
    src_ip: DEMO_IP,
    server_ip: dip,
    dest_ip: dip,
    url: u,
    base_url: u.split("/").slice(0, 3).join("/"),
    duration_seconds: 0.02 + (i % 9) * 0.11,
    duration_ms: 20 + (i % 9) * 110,
    action,
    blocked_by: matched ? [matched] : [],
    matched_pattern_name: matched,
    whitelisted: false,
    blacklisted: false,
    blacklist_source: null,
  }
}

function buildDemoRows(
  offset: number,
  count: number,
  baseNow: number,
  meta: { destIps: string[]; patterns: TriggeredPattern[]; urls: string[] },
): LogRow[] {
  return Array.from({ length: count }, (_, k) => buildDemoRow(offset + k, baseNow, meta))
}

/** Honest filtered total: walk the virtual demo dataset and count rows whose
 * action matches. Deterministic (no allocation), matches the row formula. */
function demoActionTotal(action: string, total: number): number {
  let n = 0
  for (let i = 0; i < total; i++) if (demoActionForIndex(i) === action) n++
  return n
}

/** Lazy page over the *filtered* demo set: walks indices from 0 collecting
 * `startOrdinal`-th matching row onward, materializing at most `count` rows.
 * Keeps the demo window allocation-free at any page/filter combination. */
function buildDemoRowsFiltered(
  action: string,
  startOrdinal: number,
  count: number,
  total: number,
  baseNow: number,
  meta: { destIps: string[]; patterns: TriggeredPattern[]; urls: string[] },
): LogRow[] {
  const rows: LogRow[] = []
  let seen = 0
  for (let i = 0; i < total && rows.length < count; i++) {
    if (demoActionForIndex(i) !== action) continue
    if (seen >= startOrdinal) rows.push(buildDemoRow(i, baseNow, meta))
    seen++
  }
  return rows
}

/* ── Page ────────────────────────────────────────────────────────────── */

export function HostInspectorPage({
  onNavigate,
}: {
  onNavigate?: (view: "host" | "patterns" | "analytics" | "dashboard" | "query" | "findings" | "blacklist" | "redirects" | "logs" | "url") => void
} = {}) {
  const { globalFilter, setGlobalFilter } = useFilter()
  const { toast } = useToast()

  const [target, setTarget] = useState(() => globalFilter || "")
  const [timeRange, setTimeRange] = useState("24h")
  const [host, setHost] = useState<HostProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  const [sections, setSections] = useState<HostSectionData | null>(null)
  const [sectionsLoading, setSectionsLoading] = useState(false)
  const [actionFilter, setActionFilter] = useState("All")
  const [page, setPage] = useState(0)
  const pageSize = 50

  // Pre-fill from FilterContext (?q=) so InspectionDrawer "View Host History" lands filled.
  useEffect(() => {
    if (globalFilter && !target) {
      setTarget(globalFilter)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter])

  // Reset pagination whenever the host or action filter changes.
  useEffect(() => {
    setPage(0)
  }, [host, actionFilter])

  const lookup = async (ip: string) => {
    const clean = ip.trim()
    if (!clean) {
      toast({ title: "Enter a host or IP", variant: "info" })
      return
    }
    setLoading(true)
    setError(null)
    setHasSearched(true)
    setHost(null)
    setSections(null)
    setSectionsLoading(false)
    try {
      const profile = await getHostProfile(clean, timeRange)
      setHost(profile)
    } catch (e) {
      const msg = (e as Error).message || "Lookup failed"
      setError(msg)
      setHost(null)
      toast({ title: "Lookup failed", description: msg, variant: "error" })
      setLoading(false)
      return
    }
    setLoading(false)

    // Sections load independently so the entity card paints immediately.
    setSectionsLoading(true)
    try {
      const data = await fetchHostSections(clean, timeRange)
      setSections(data)
    } catch {
      setSections({ ...EMPTY_SECTIONS, window: timeRange })
    } finally {
      setSectionsLoading(false)
    }
  }

  const handleExport = () => {
    if (!host) {
      toast({ title: "No host selected", description: "Run a lookup first.", variant: "info" })
      return
    }
    // Interim: export as JSON download until backend report lands.
    try {
      const blob = new Blob([JSON.stringify(host, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `host-${host.primaryIp}-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: "Report exported", variant: "success" })
    } catch {
      toast({ title: "Export failed", variant: "error" })
    }
  }

  const handleGear = () => {
    toast({ title: "Table settings", description: "Column visibility coming soon.", variant: "info" })
  }

  /* ── Per-host enforcement actions (ADR 0001) ── */
  const handleWhitelist = async () => {
    if (!target.trim()) return
    const host = target.trim()
    const pattern = `*.${host}/*`
    try {
      await bulkImport({ patterns: [pattern], pattern_type: "whitelist" })
      toast({ title: "Whitelisted", description: `${pattern} added to whitelist — excluded from risk.`, variant: "success" })
    } catch (e) {
      toast({ title: "Whitelist failed", description: (e as Error).message, variant: "error" })
    }
  }

  const handleBlacklist = async () => {
    if (!target.trim()) return
    try {
      const res = await addBaseUrlToBlacklist(target.trim())
      toast({
        title: res.added.length ? "Blacklisted" : "Already blacklisted",
        description: `${target.trim()} added to the block feed.`,
        variant: res.added.length ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    }
  }

  const handleOpenUrl = (url: string) => {
    setGlobalFilter(url)
    try {
      window.localStorage.setItem("unetwatch_view", "url")
    } catch {
      /* ignore */
    }
    onNavigate?.("url")
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") lookup(target)
  }

  // Host log rows — client-side action filter layered over fetched rows.
  const filteredLogs = useMemo(() => {
    if (!sections) return []
    if (actionFilter === "All") return sections.logs
    return sections.logs.filter((r) => (r.action ?? "") === actionFilter)
  }, [sections, actionFilter])

  // Materialize the current page. Real data is already sliced; the demo window
  // (42,810 virtual rows) generates each page lazily from demoMeta so the full
  // pagination range works without allocating the dataset.
  const pageRows = useMemo(() => {
    if (sections?.demoMeta) {
      if (actionFilter === "All") {
        return buildDemoRows(page * pageSize, pageSize, sections.demoMeta.baseNow, sections.demoMeta)
      }
      // Filtered demo page: walk the virtual set and materialize only the
      // `page`-th slice of matching rows (honest "of N" total, still lazy).
      return buildDemoRowsFiltered(
        actionFilter,
        page * pageSize,
        pageSize,
        sections.logTotal,
        sections.demoMeta.baseNow,
        sections.demoMeta,
      )
    }
    return filteredLogs.slice(page * pageSize, (page + 1) * pageSize)
  }, [sections, filteredLogs, actionFilter, page, pageSize])

  // Pagination total. The demo window has a fully-lazy dataset so it reports
  // the full wireframe count (42,810) unfiltered, and the exact filtered
  // subset count (e.g. 6,116 DENY rows) when an action filter is active. Live
  // rows are capped by the backend (~500 items) so their total is bounded to
  // what we actually fetched — otherwise paging past the fetched rows would
  // show "501-550 of 42,810" with empty rows.
  const displayTotal = useMemo(() => {
    if (!sections) return 0
    if (sections.demoMeta) {
      if (actionFilter === "All") return sections.logTotal
      return demoActionTotal(actionFilter, sections.logTotal)
    }
    return filteredLogs.length
  }, [sections, actionFilter, filteredLogs])

  const logColumns: DataTableColumn<LogRow>[] = useMemo(
    () => [
      {
        id: "timestamp",
        header: "Timestamp",
        accessor: (r) => r.timestamp,
        cell: (r) => (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(r.timestamp)}</span>
        ),
        width: "w-48",
        defaultSortDir: "desc" as const,
      },
      {
        id: "url",
        header: "Full URL / Dest Domain",
        accessor: (r) => r.url,
        cell: (r) => (
          <span className="block max-w-[340px] truncate font-mono text-xs" title={r.url}>
            {r.url}
          </span>
        ),
      },
      {
        id: "dest_ip",
        header: "Dest IP",
        accessor: (r) => getDestIp(r),
        cell: (r) => <span className="font-mono text-xs text-muted-foreground">{getDestIp(r) || "—"}</span>,
      },
      {
        id: "action",
        header: "Action",
        accessor: (r) => r.action,
        cell: (r) => <Badge variant={actionVariant(r.action ?? "")}>{r.action || "—"}</Badge>,
        width: "w-24",
      },
      {
        id: "duration",
        header: "Duration",
        accessor: (r) => getDurationMs(r),
        cell: (r) => {
          const ms = getDurationMs(r)
          return <span className="font-mono text-xs tabular-nums">{ms != null ? `${ms}ms` : "—"}</span>
        },
        align: "right" as const,
        width: "w-24",
      },
      {
        id: "pattern",
        header: "Triggered Pattern",
        accessor: (r) => getMatchedRule(r),
        cell: (r) => (
          <span className="block max-w-[200px] truncate font-mono text-xs" title={getMatchedRule(r)}>
            {getMatchedRule(r)}
          </span>
        ),
      },
      /* ── Rich flat proxy fields (logstash-proxy-* schema) ── */
      {
        id: "category",
        header: "Category",
        accessor: (r) => r.category,
        cell: (r) => <span className="font-mono text-xs text-muted-foreground">{r.category || "—"}</span>,
        width: "w-24",
      },
      {
        id: "method",
        header: "Method",
        accessor: (r) => r.http_method,
        cell: (r) => <span className="font-mono text-xs">{r.http_method || "—"}</span>,
        width: "w-20",
      },
      {
        id: "status",
        header: "Status",
        accessor: (r) => r.http_status_code,
        cell: (r) => <span className="font-mono text-xs tabular-nums">{r.http_status_code ?? "—"}</span>,
        width: "w-20",
        align: "right" as const,
      },
      {
        id: "country",
        header: "Country",
        accessor: (r) => r.country_code,
        cell: (r) => <span className="font-mono text-xs">{r.country_code || "—"}</span>,
        width: "w-20",
      },
      {
        id: "bytes",
        header: "↓/↑ Bytes",
        accessor: (r) => (Number(r.bytes_downloaded) || 0) + (Number(r.bytes_uploaded) || 0),
        cell: (r) => {
          const dn = Number(r.bytes_downloaded) || 0
          const up = Number(r.bytes_uploaded) || 0
          if (!dn && !up) return <span className="text-xs text-muted-foreground">—</span>
          return (
            <span className="font-mono text-xs tabular-nums" title={`↓ ${dn.toLocaleString()} / ↑ ${up.toLocaleString()}`}>
              {formatBytes(dn + up)}
            </span>
          )
        },
        align: "right" as const,
        width: "w-24",
      },
      {
        id: "rule",
        header: "Rule",
        accessor: (r) => r.rule_name ?? r.rule_info ?? "—",
        cell: (r) => {
          const rule = r.rule_name && r.rule_name !== "-" ? r.rule_name : r.rule_info
          return <span className="block max-w-[140px] truncate font-mono text-xs text-muted-foreground" title={rule}>{rule || "—"}</span>
        },
        width: "w-28",
      },
    ],
    [],
  )

  const showSections = !!host && !error

  return (
    <div className="space-y-5">
      <PageHeader
        title="Host Investigation"
        description="Single-entity forensic investigation"
      >
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export Report
        </Button>
        {host && (
          <>
            <Button variant="outline" onClick={handleWhitelist}>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Whitelist host
            </Button>
            <Button variant="outline" onClick={handleBlacklist} className="text-destructive hover:text-destructive">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              Blacklist host
            </Button>
          </>
        )}
      </PageHeader>

      <div className="flex gap-2">
        <Input
          placeholder="Host / IP Search: 192.168.1.45"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 font-mono text-[13px]"
          aria-label="Host or IP search"
        />
        <Button onClick={() => lookup(target)} disabled={loading}>
          <Search className="h-4 w-4" aria-hidden="true" />
          {loading ? "Looking up…" : "Lookup"}
        </Button>
        <Select
          value={timeRange}
          onChange={setTimeRange}
          options={TIME_RANGE_OPTIONS}
          className="w-36 shrink-0"
          aria-label="Time range"
        />
      </div>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {!loading && !error && host && (
        <HostEntityCard host={host} risk={host.risk} />
      )}

      {!loading && !error && !host && hasSearched && (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">No host found</p>
          <p className="mt-2 text-sm text-muted-foreground">No data for “{target}” in the selected window.</p>
        </div>
      )}

      {!loading && !error && !host && !hasSearched && (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">Host Investigation</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter a host or IP (e.g. 192.168.1.45) and run Lookup. Try the wireframe demo IP <span className="font-mono font-semibold text-foreground">192.168.1.45</span> to see the spec card.
          </p>
        </div>
      )}

      {/* ── Spec §3.2 sections (render only once a host is resolved) ── */}
      {showSections && (
        <>
          {/* 1) Visual Traffic Timeline & Anomaly Heatmap */}
          <Panel
            title="Visual Traffic Timeline & Anomaly Heatmap"
            icon={Activity}
            description={sections ? `${sections.logTotal.toLocaleString()} req · ${windowLabel(sections.window)} window` : "—"}
          >
            {sectionsLoading ? (
              <Skeleton className="h-60 w-full" />
            ) : sections && sections.timeline.length > 0 ? (
              <TrafficTimeline points={sections.timeline} anomalyAnnotation={sections.anomaly} />
            ) : (
              <p className="py-10 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                NO DATA IN WINDOW
              </p>
            )}
          </Panel>

          {/* 2) Top Destinations & Rule Matches */}
          {sectionsLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : sections ? (
            <TopDestinations topDomains={sections.topDomains} triggeredPatterns={sections.triggeredPatterns} />
          ) : null}

          {/* 3) Ranked URLs — each row links into URL Investigation */}
          <Panel
            title="Top URLs Accessed"
            icon={Link2}
            description="Click a URL to investigate who else reached it"
          >
            {sectionsLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : sections && sections.topUrls.length > 0 ? (
              <div className="divide-y divide-border">
                {sections.topUrls.map((u) => (
                  <button
                    key={u.url}
                    type="button"
                    onClick={() => handleOpenUrl(u.url)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                  >
                    <span className="block max-w-[60%] flex-1 truncate font-mono text-[13px] font-semibold" title={u.url}>
                      {u.url}
                    </span>
                    <span className="ml-auto font-mono text-[13px] font-bold tabular-nums">
                      {u.count.toLocaleString()}
                    </span>
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-10 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                NO DATA IN WINDOW
              </p>
            )}
          </Panel>

          {/* 3) Chronological Kibana Request Logs */}
          <Panel
            title="Chronological Kibana Request Logs"
            icon={SearchX}
            description={sections ? `${sections.logTotal.toLocaleString()} docs · ${windowLabel(sections.window)} window` : "—"}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={actionFilter}
                  onChange={setActionFilter}
                  options={ACTION_FILTER_OPTIONS}
                  className="w-36"
                  aria-label="Filter by action"
                />
                <Button variant="outline" size="sm" onClick={handleGear} aria-label="Table settings">
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            }
          >
            <DataTable
              columns={logColumns}
              data={pageRows}
              rowId={getRowId}
              loading={sectionsLoading}
              empty={{
                icon: SearchX,
                title: "No log entries",
                description: "Try a broader time range or clear the action filter.",
              }}
              defaultSortBy="timestamp"
              defaultSortDir="desc"
              page={page}
              pageSize={pageSize}
              total={displayTotal}
              onPageChange={setPage}
              ariaLabel="Host request logs"
            />
          </Panel>
        </>
      )}
    </div>
  )
}