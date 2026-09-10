import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  Database,
  Globe,
  Link2,
  Network,
  Printer,
  Search,
  SearchX,
  Server,
  ShieldAlert,
  ShieldCheck,
  Download,
} from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { Button, Input, Select, PageHeader, Panel, Skeleton, Badge, LoadingIcon, useToast, StatCard } from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { HostEntityCard } from "./HostEntityCard"
import { TrafficTimeline, type TimelinePoint } from "./TrafficTimeline"
import { TopDestinations, type TopDomain, type TriggeredPattern } from "./TopDestinations"
import { TrendCharts, type TrendPoint } from "./TrendCharts"
import {
  getHostProfile,
  runQuery,
  timeRangeToMinutesLive,
  formatBytes,
  buildFlowSankey,
  getClientReport,
  getClientReportFindings,
  getClientReportCsvUrl,
  getToken,
  type QueryDoc,
  type HostProfile,
  type ClientReport,
  type Finding,
} from "../api"
import { SankeyDiagram } from "./SankeyDiagram"
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

/** True when a search string looks like a URL rather than a bare host/IP —
 * used to keep the host page from reacting to a URL filter (and vice versa). */
function looksLikeUrl(s: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ||
    s.includes("/") ||
    s.includes("?") ||
    s.startsWith("www.")
  )
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

type HostSource = "live" | "findings"

async function fetchHostSectionsFindings(ip: string, timeRange: string): Promise<HostSectionData> {
  const minutes = timeRangeToMinutesLive(timeRange)
  const { getFindings } = await import("../api")
  const res = await getFindings({ search: ip.trim(), minutes, limit: 500 })
  if (res.items.length === 0) return { ...EMPTY_SECTIONS, window: timeRange }
  // Build same aggregates but from findings (QueryDoc-shaped items from Finding coords)
  const items = res.items.map((f) => {
    let pats: string[] = []
    try { const p = f.matched_patterns ? JSON.parse(f.matched_patterns) : []; pats = Array.isArray(p) ? p : [] } catch { pats = [] }
    return {
      client_ip: f.client_ip,
      server_ip: f.server_ip,
      url: f.url,
      base_url: f.base_url,
      timestamp: f.log_timestamp,
      action: (f.action as string) || "ALLOW",
      blocked_by: pats,
      duration_seconds: Number(f.duration_seconds) || null,
      bytes_downloaded: f.bytes_downloaded as unknown as number,
      bytes_uploaded: f.bytes_uploaded as unknown as number,
      blacklisted: false,
      blacklist_source: null as null,
      whitelisted: false,
    } as unknown as QueryDoc
  })
  // Bucket timeline from findings timestamps
  const byBucket = new Map<string, number>()
  for (const it of items) { const ts = (it as unknown as LogRow).timestamp as string; const key = ts.slice(0,13)+":00"; byBucket.set(key, (byBucket.get(key) ?? 0)+1) }
  const timeline: TimelinePoint[] = [...byBucket.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([bucket, count])=>({ hour: formatHour(bucket), volume: count }))
  const topDomains = buildTopDomains(items as unknown as QueryDoc[])
  const triggeredPatterns = buildTriggeredPatterns(items as unknown as QueryDoc[])
  const topUrls = buildTopUrls(items as unknown as QueryDoc[])
  const logs = (items as unknown as LogRow[]).map((r) => ({ ...r }))
  return { timeline, anomaly: detectSpike(timeline), topDomains, triggeredPatterns, topUrls, logs, logTotal: res.total || items.length, window: timeRange }
}

async function fetchHostSections(ip: string, timeRange: string, source: HostSource = "live"): Promise<HostSectionData> {
  const minutes = timeRangeToMinutesLive(timeRange)
  const isDemo = ip.trim() === DEMO_IP
  if (source === "findings") {
    try { const data = await fetchHostSectionsFindings(ip, timeRange); if (data.logs.length > 0) return data } catch { /* fallback below */ }
    if (isDemo) return buildDemoSections(timeRange)
    return { ...EMPTY_SECTIONS, window: timeRange }
  }
  // Prefer live ES rows filtered to this host — richest source (action-aware,
  // pattern matches, durations). Backend caps items at 500; total_requests is
  // the real window total and drives the "Showing 1-50 of 42,810" summary.
  // The `ip` param uses an exact ES term filter so risk rows are found even
  // when the generic substring search would miss them.
  try {
    const res = await runQuery(minutes, { q: ip.trim(), ip: ip.trim() })
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
    /* fall through to findings fallback */
  }
  // Live found nothing — try findings before demo/empty
  try { const fb = await fetchHostSectionsFindings(ip, timeRange); if (fb.logs.length > 0) return fb } catch { /* ignore */ }
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
  const { globalFilter, setGlobalFilter, timeRange, setTimeRange } = useFilter()
  const { toast } = useToast()

  const [target, setTarget] = useState(() => globalFilter || "")
  const [host, setHost] = useState<HostProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  const [sections, setSections] = useState<HostSectionData | null>(null)
  const [sectionsLoading, setSectionsLoading] = useState(false)
  const [actionFilter, setActionFilter] = useState("All")
  const [hSource, setHSource] = useState<HostSource>("live")
  const [page, setPage] = useState(0)
  const pageSize = 50
  /** Focused node id in the client-behaviour Sankey (persistent trace). */
  const [behaviourFocus, setBehaviourFocus] = useState<string | null>(null)

  // ── Findings (Client Report) branch state ──
  const [report, setReport] = useState<ClientReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [raw, setRaw] = useState<Finding[]>([])
  const [rawTotal, setRawTotal] = useState(0)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawSearch, setRawSearch] = useState("")
  const [rawPage, setRawPage] = useState(0)
  const rawPageSize = 50

  // Pre-fill + re-lookup from FilterContext (?q=) so the Ctrl+K palette and
  // InspectionDrawer "View Host History" land on the right host. Re-runs on
  // every globalFilter change (the page stays mounted across tabs now) — but
  // only when the filter is a host/IP, not a URL.
  useEffect(() => {
    if (globalFilter && !looksLikeUrl(globalFilter) && globalFilter !== target) {
      setTarget(globalFilter)
      void lookup(globalFilter)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter])

  // Reset pagination whenever the host or action filter changes.
  useEffect(() => {
    setPage(0)
  }, [host, actionFilter])

  // Re-fetch the findings report when the source toggle flips to findings and
  // a host is already selected (the report is all-time; no time range window).
  useEffect(() => {
    if (!host || loading) return
    if (hSource === "findings") {
      setReportLoading(true)
      void getClientReport((host as unknown as { primaryIp: string }).primaryIp || target)
        .then((data) => {
          setReport(data)
          if (data.has_data) setRawPage(0)
        })
        .catch((e) => {
          setReport(null)
          toast({ title: "Report failed", description: (e as Error).message, variant: "error" })
        })
        .finally(() => setReportLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hSource])

  // Re-fetch the live sections when the toggle flips to live and the host was
  // looked up in Findings mode (sections were never loaded for it).
  useEffect(() => {
    if (!host || loading) return
    if (hSource === "live" && !sections) {
      setSectionsLoading(true)
      const ip = (host as unknown as { primaryIp: string }).primaryIp || target
      void fetchHostSections(ip, timeRange, "live")
        .then((data) => setSections(data))
        .catch(() => setSections({ ...EMPTY_SECTIONS, window: timeRange }))
        .finally(() => setSectionsLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hSource])

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
    setReport(null)
    setSectionsLoading(false)
    setReportLoading(false)
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

    if (hSource === "findings") {
      // Findings branch: always resolve the full Client Report.
      setReportLoading(true)
      try {
        const data = await getClientReport(clean)
        setReport(data)
        setRawPage(0)
      } catch (e) {
        setReport(null)
        setError((e as Error).message || "Report failed")
        toast({ title: "Report failed", description: (e as Error).message, variant: "error" })
      } finally {
        setReportLoading(false)
      }
    } else {
      // Live branch: sections load independently so the entity card paints immediately.
      setSectionsLoading(true)
      try {
        const data = await fetchHostSections(clean, timeRange, hSource)
        setSections(data)
      } catch {
        setSections({ ...EMPTY_SECTIONS, window: timeRange })
      } finally {
        setSectionsLoading(false)
      }
    }
  }

  // ── Raw findings table (findings branch) ──
  const fetchRaw = useCallback(async () => {
    if (!report?.client_ip || !report.has_data) return
    setRawLoading(true)
    try {
      const res = await getClientReportFindings(report.client_ip, {
        search: rawSearch.trim() || undefined,
        limit: rawPageSize,
        offset: rawPage * rawPageSize,
      })
      setRaw(res.items)
      setRawTotal(res.total)
    } catch (e) {
      toast({ title: "Raw findings failed", description: (e as Error).message, variant: "error" })
    } finally {
      setRawLoading(false)
    }
  }, [report, rawSearch, rawPage, toast])

  useEffect(() => { void fetchRaw() }, [fetchRaw])

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

  const handleOpenUrl = useCallback((url: string) => {
    if (!url) return
    setGlobalFilter(url)
    try {
      window.localStorage.setItem("unetwatch_view", "url")
    } catch {
      /* ignore */
    }
    onNavigate?.("url")
  }, [setGlobalFilter, onNavigate])

  const handleOpenHost = useCallback((ip: string) => {
    if (!ip) return
    setGlobalFilter(ip)
    try {
      window.localStorage.setItem("unetwatch_view", "host")
    } catch {
      /* ignore */
    }
    onNavigate?.("host")
  }, [setGlobalFilter, onNavigate])

  const openUrlInInvestigation = useCallback((url: string) => {
    if (!url) return
    try { window.localStorage.setItem("unetwatch_url", url) } catch { /* ignore */ }
    onNavigate?.("url")
  }, [onNavigate])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") lookup(target)
  }

  // ── Findings branch: client report exports ──
  const handleExportCsv = () => {
    if (!report) return
    const apiUrl = getClientReportCsvUrl(report.client_ip)
    const tok = getToken()
    fetch(`/api${apiUrl.replace(/^\/api/, "") || apiUrl}`, { headers: tok ? { "X-API-Key": tok } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `client-${report.client_ip}-${Date.now()}.csv`
        a.click()
        URL.revokeObjectURL(url)
        toast({ title: "CSV exported", variant: "success" })
      })
      .catch((e) => toast({ title: "CSV export failed", description: (e as Error).message, variant: "error" }))
  }

  const handleExportPdf = () => {
    toast({ title: "Opening print dialog — Save as PDF", variant: "info" })
    window.print()
  }

  // Host log rows — client-side action filter layered over fetched rows.
  const filteredLogs = useMemo(() => {
    if (!sections) return []
    if (actionFilter === "All") return sections.logs
    return sections.logs.filter((r) => (r.action ?? "") === actionFilter)
  }, [sections, actionFilter])

  // Client-behaviour flow: an ego view of this host — pattern → this client
  // → URL → destination — over the same rows the request log shows. Built with
  // the shared buildFlowSankey so it inherits top-N capping, Others grouping
  // and the path-tracing hover/click interactions of the Query flow.
  const behaviourFlow = useMemo(() => {
    const items = filteredLogs as unknown as QueryDoc[]
    if (items.length === 0) return null
    return buildFlowSankey(items, {
      maxPat: 12,
      maxSrc: 5,
      maxDom: 20,
      maxDst: 20,
      minWeight: 1,
      groupOthers: true,
      keepRisk: true,
    })
  }, [filteredLogs])

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
          <span className="flex items-center gap-1.5">
            <span className="block max-w-[340px] truncate font-mono text-xs" title={r.url}>
              {r.url}
            </span>
            <button
              type="button"
              onClick={() => handleOpenUrl(r.url ?? "")}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
              aria-label="Open in URL Investigation"
              title="Open in URL Investigation"
            >
              <Search className="h-3 w-3" />
            </button>
          </span>
        ),
      },
      {
        id: "dest_ip",
        header: "Dest IP",
        accessor: (r) => getDestIp(r),
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{getDestIp(r) || "—"}</span>
            <button
              type="button"
              onClick={() => handleOpenHost(getDestIp(r))}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
              aria-label="Open in Host Inspector"
              title="Open in Host Inspector"
            >
              <Search className="h-3 w-3" />
            </button>
          </span>
        ),
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
    [handleOpenHost, handleOpenUrl],
  )

  /* ── Findings branch columns (ported from Client Report) ── */
  const domainColumns = useMemo<DataTableColumn<{ domain: string; count: number; volume: number; pct: number }>[]>(() => [
    { id: "domain", header: "Domain", accessor: (r) => r.domain, cell: (r) => <span className="block max-w-[240px] truncate font-mono text-[13px] font-semibold" title={r.domain}>{r.domain}</span> },
    { id: "count", header: "Requests", accessor: (r) => r.count, align: "right", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>, width: "w-20" },
    { id: "volume", header: "Volume", accessor: (r) => r.volume, align: "right", cell: (r) => <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{formatBytes(r.volume)}</span>, width: "w-28" },
    { id: "pct", header: "% Total", accessor: (r) => r.pct, align: "right", cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.pct.toFixed(1)}%</span>, width: "w-20" },
  ], [])

  const patternColumns = useMemo<DataTableColumn<{ pattern: string; hits: number }>[]>(() => [
    { id: "pattern", header: "Pattern", accessor: (r) => r.pattern, cell: (r) => <span className="block max-w-[280px] truncate font-mono text-xs" title={r.pattern}>{r.pattern}</span> },
    { id: "hits", header: "Hits", accessor: (r) => r.hits, align: "right", cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.hits.toLocaleString()}</span>, width: "w-24" },
  ], [])

  const urlColumns = useMemo<DataTableColumn<{ url: string; base_url: string; count: number; last_seen: string }>[]>(() => [
    { id: "url", header: "URL", accessor: (r) => r.url, cell: (r) => (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[560px] truncate font-mono text-xs" title={r.url}>{r.url}</span>
        <button type="button" onClick={() => openUrlInInvestigation(r.url)} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground" aria-label="Open in URL Investigation"><Search className="h-3 w-3" /></button>
      </span>
    )},
    { id: "count", header: "Hits", accessor: (r) => r.count, align: "right", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>, width: "w-20" },
  ], [openUrlInInvestigation])

  const rawColumns = useMemo<DataTableColumn<Finding>[]>(() => [
    { id: "log_timestamp", header: "Timestamp", accessor: (r) => r.log_timestamp, cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(r.log_timestamp)}</span>, width: "w-44", defaultSortDir: "desc" },
    { id: "url", header: "URL", accessor: (r) => r.url, cell: (r) => <span className="block max-w-[420px] truncate font-mono text-xs" title={r.url}>{r.url}</span> },
    { id: "base_url", header: "Domain", accessor: (r) => r.base_url, cell: (r) => <span className="block max-w-[200px] truncate font-mono text-xs text-muted-foreground" title={r.base_url}>{r.base_url}</span> },
    { id: "pattern", header: "Pattern", enableSorting: false, accessor: (r) => r.matched_patterns, cell: (r) => {
      let pats: string[] = []
      try { const p = r.matched_patterns ? JSON.parse(r.matched_patterns) : []; pats = Array.isArray(p) ? p : [] } catch {}
      // Findings-backed report: every finding was stored because it matched a block pattern.
      // If the row somehow has no matched_patterns (legacy / empty array), fall back to
      // the report-level top pattern for this client so the cell never reads as "—".
      if (pats.length === 0 && report?.top_pattern) pats = [report.top_pattern]
      if (pats.length === 0) return <span className="text-xs text-muted-foreground">—</span>
      return (
        <span className="flex flex-wrap gap-1">
          {pats.map((pat) => (
            <span key={pat} className="inline-flex items-center border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground" title={pat}>{pat}</span>
          ))}
        </span>
      )
    } },
    { id: "volume", header: "Volume", accessor: (r) => { const dn = Number(r.bytes_downloaded) || 0; const up = Number(r.bytes_uploaded) || 0; if (dn || up) return dn + up; const dur = Number(r.duration_seconds) || 0; return dur > 0 ? Math.max(1, Math.round(dur)) * 8192 : 8192 }, align: "right", cell: (r) => {
      const dn = Number(r.bytes_downloaded) || 0; const up = Number(r.bytes_uploaded) || 0; const hasBytes = !!(dn || up); const dur = Number(r.duration_seconds) || 0; const vol = hasBytes ? dn + up : dur > 0 ? Math.max(1, Math.round(dur)) * 8192 : 8192
      return <span className="inline-flex items-center gap-1.5" title={hasBytes ? `Real: ↓${dn}+↑${up}` : `Est: ${dur}s×8KiB`}><span className="font-mono text-xs tabular-nums">{formatBytes(vol)}</span><span className={`border px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${hasBytes ? "border-[#0A0A0A] bg-[#0A0A0A] text-white dark:border-[#F6F2E8] dark:bg-[#F6F2E8] dark:text-[#0A0A0A]" : "border-border bg-muted text-muted-foreground"}`}>{hasBytes ? "real" : "est."}</span></span>
    }, width: "w-32" },
  ], [report?.top_pattern])

  const showSections = !!host && !error && hSource === "live"
  const showReport = !!host && !error && hSource === "findings"
  const isFindings = hSource === "findings"
  const hasRealData = !!report?.has_data

  const bandwidthPoints = useMemo<TrendPoint[]>(
    () => (report?.bandwidth.points ?? []).map((p) => ({
      bucket: p.bucket,
      inbound: Number((p.inbound / 1024 ** 3).toFixed(3)),
      outbound: Number((p.outbound / 1024 ** 3).toFixed(3)),
    })),
    [report],
  )
  const enforcementPoints = useMemo<TrendPoint[]>(
    () => (report?.enforcements.points ?? []).map((p) => ({ bucket: p.bucket, allow: p.allow, deny: p.deny })),
    [report],
  )
  const volumeValue = hasRealData ? formatBytes(report!.total_volume) : "—"

  return (
    <div className="space-y-5">
      <PageHeader
        title="Host Investigation"
        description={isFindings ? "Per-client analytics from findings (all time, risk-only)" : "Single-entity forensic investigation (live ES window)"}
      >
        {isFindings ? (
          <>
            <Button variant="outline" onClick={handleExportPdf} aria-label="Export PDF"><Printer className="h-4 w-4" aria-hidden="true" />Print / PDF</Button>
            <Button variant="outline" onClick={handleExportCsv} aria-label="Export CSV" disabled={!report?.has_data}><Database className="h-4 w-4" aria-hidden="true" />CSV</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Export Report
            </Button>
          </>
        )}
      </PageHeader>

      {/* Standardized search toolbar - matches URL Investigation's brutal-card form. */}
      <div className="brutal-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Host / IP Search: 192.168.1.45"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 min-w-[240px] font-mono text-[13px]"
            aria-label="Host or IP search"
          />
          <Button onClick={() => lookup(target)} disabled={loading}>
            {loading ? <LoadingIcon /> : <Search className="h-4 w-4" aria-hidden="true" />}
            {loading ? "Looking up..." : "Lookup"}
          </Button>
          <Select
            value={timeRange}
            onChange={(v) => setTimeRange(v as typeof timeRange)}
            options={TIME_RANGE_OPTIONS}
            className="w-36 shrink-0"
            aria-label="Time range"
          />
          <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Data source">
            <button type="button" onClick={() => setHSource("live")} aria-pressed={hSource === "live"} className={`px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors ${hSource === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>Live</button>
            <button type="button" onClick={() => setHSource("findings")} aria-pressed={hSource === "findings"} className={`px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors ${hSource === "findings" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>Findings</button>
          </div>
        </div>
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

      {!loading && !error && host && hSource === "live" && (
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
            Enter a host or IP (e.g. 192.168.1.45) and run Lookup. <span className="font-mono font-semibold">Live</span> shows the live ES window;
            <span className="font-mono font-semibold"> Findings</span> shows all-time analytics from the findings table.
          </p>
        </div>
      )}

      {/* ── LIVE branch — Spec §3.2 sections (render only once a host is resolved) ── */}
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

          {/* 3) Client behaviour flow — pattern → this client → Domain → dest IP */}
          <Panel
            title="Client Behaviour Flow"
            icon={Network}
            description="Pattern → this client → Domain → destination · hover traces a path · click isolates it"
          >
            {sectionsLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : behaviourFlow && behaviourFlow.links.length > 0 ? (
              <>
                {behaviourFocus && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 border-[2px] border-[#0A0A0A] bg-secondary px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-[#0A0A0A] dark:border-[#F6F2E8]">
                    <span>Focused: {behaviourFocus.replace(/^(stub:)?(src|pat|url|dom|dst|ip|base):/, "")}</span>
                    <span className="opacity-60">(trace isolated)</span>
                    <Button variant="outline" size="sm" onClick={() => setBehaviourFocus(null)} className="ml-auto h-6 px-2 text-[10px]">Clear focus</Button>
                  </div>
                )}
                <SankeyDiagram
                  nodes={behaviourFlow.nodes}
                  links={behaviourFlow.links}
                  focusedId={behaviourFocus}
                  onNodeClick={(info) => {
                    if (info.kind === "node") setBehaviourFocus((cur) => (cur === info.id ? null : info.id))
                    else setBehaviourFocus(info.id)
                  }}
                  ariaLabel="Client behaviour — pattern to client to Domain to destination"
                />
              </>
            ) : (
              <p className="py-10 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                NO DATA IN WINDOW
              </p>
            )}
          </Panel>

          {/* 4) Chronological Kibana Request Logs */}
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

      {/* ── FINDINGS branch — Client Report analytics ── */}
      {showReport && (
        <>
          {reportLoading && !report ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
              <Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" />
            </div>
          ) : report && !hasRealData && hasSearched ? (
            <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
              <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">No findings for {report.client_ip}</p>
              <p className="mt-2 text-sm text-muted-foreground">This client has no findings in the database.</p>
            </div>
          ) : report && hasRealData ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
                <StatCard icon={Database} label="Total Requests" value={report.total_requests.toLocaleString()} tone="info" hint={`${report.distinct_urls} URLs · ${report.distinct_domains} domains`} />
                <StatCard icon={ShieldAlert} label="Risks (ALLOW)" value={report.total_risk.toLocaleString()} tone="danger" hint={report.top_pattern ? `top: ${report.top_pattern}` : "risk-only"} />
                <StatCard icon={ShieldCheck} label="Enforcements (DENY)" value={report.total_enforcements.toLocaleString()} tone="success" hint="handled" />
                <StatCard icon={Server} label="Total Volume" value={volumeValue} tone="default" hint={`bytes + 8 KiB fallback · ${report.distinct_domains} domains`} />
                <StatCard icon={Activity} label="Peak Hour" value={report.peak_hour || "—"} tone="default" hint={`${report.distinct_urls} distinct URLs`} />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Daily Bandwidth (GB)" icon={Activity} description="inbound vs outbound">
                  <TrendCharts type="area" data={bandwidthPoints} labels={["inbound", "outbound"]} seriesNames={["Inbound", "Outbound"]} unit="GB" height={260} ariaLabel="Client daily bandwidth" />
                </Panel>
                <Panel title="Daily Enforcements" icon={Activity} description="ALLOW vs DENY">
                  <TrendCharts type="stackedBar" data={enforcementPoints} labels={["allow", "deny"]} seriesNames={["ALLOW", "DENY"]} unit="reqs" height={260} ariaLabel="Client daily enforcements" />
                </Panel>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Top Domains" icon={Globe}>
                  <DataTable columns={domainColumns} data={report.top_domains} rowId={(r) => r.domain} empty={{ icon: Globe, title: "No domains in window", description: "Try a broader date range." }} ariaLabel="Top domains" />
                </Panel>
                <Panel title="Top Patterns" icon={Link2}>
                  <DataTable columns={patternColumns} data={report.top_patterns} rowId={(r) => r.pattern} empty={{ icon: SearchX, title: "No patterns in window", description: "No matched patterns." }} ariaLabel="Top patterns" />
                </Panel>
              </div>

              <Panel title="Top URLs" icon={Link2} description="Click to investigate">
                <DataTable columns={urlColumns} data={report.top_urls} rowId={(r) => r.url} empty={{ icon: SearchX, title: "No URLs in window" }} ariaLabel="Top URLs" />
              </Panel>

              <Panel title={`Raw Findings — ${report.client_ip}`} icon={Database} description={`${rawTotal.toLocaleString()} docs`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input type="search" placeholder="Filter (URL)..." value={rawSearch} onChange={(e) => { setRawSearch(e.target.value); setRawPage(0) }} className="w-64 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring" aria-label="Filter raw findings" />
                  <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">findings table · whitelist-excluded</span>
                </div>
                <DataTable columns={rawColumns} data={raw} rowId={(r) => String(r.id)} loading={rawLoading} total={rawTotal} page={rawPage} pageSize={rawPageSize} onPageChange={setRawPage} empty={{ icon: SearchX, title: "No findings in window" }} ariaLabel="Raw findings" />
              </Panel>
            </>
          ) : null}
        </>
      )}
    </div>
  )
}