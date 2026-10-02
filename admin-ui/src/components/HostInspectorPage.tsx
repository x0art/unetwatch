import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  FileText,
} from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { Button, Callout, IconButton, Input, SearchInput, Select, PageHeader, Panel, SkeletonShape, Badge, EmptyState, LoadingIcon, TimestampCell, useToast, StatCard } from "./ui"
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
  getJaillistSet,
  getClientReportCsvUrl,
  getToken,
  notifySessionExpired,
  type QueryDoc,
  type HostProfile,
  type HostRisk,
  type ClientReport,
  type Finding,
} from "../api"
import { LoadingIndicator, useElapsed } from "./loading"
import { SankeyDiagram } from "./SankeyDiagram"
import {
  getDestDomain,
  getDestIp,
  getDurationMs,
  getMatchedRule,
  getRowId,
  getSrcIp,
  actionVariant,
  hostOfUrl,
  type LogRow,
} from "../lib/logRow"
import { useAbortable, useGeneration } from "../lib/utils"

const TIME_RANGE_OPTIONS = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "3d", label: "Last 3d" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
  { value: "90d", label: "Last 90d" },
  { value: "1y", label: "Last 1y" },
]

const ACTION_FILTER_OPTIONS = [
  { value: "All", label: "All" },
  { value: "ALLOW", label: "ALLOW" },
  { value: "DENY", label: "DENY" },
  { value: "FLAG", label: "FLAG" },
]

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

/**
 * Per-domain row counts over the host's FLAGGED rows — this is the frame the
 * page fetches (live: the block-pattern query; findings: rows only written on
 * a pattern match), so it counts rows that already matched a pattern, NOT the
 * destination's total access volume. Total volume comes from the backend
 * (domain-level measurements on the host aggregate), never from here.
 *
 * Within that flagged frame the count is complete: every flagged row is
 * counted, and the domain is read as `base_url` first so sibling paths on one
 * flagged domain aggregate into one honest bucket (a domain is counted once
 * per access, regardless of which path was hit). Rows that resolve to no
 * domain (blank url/base_url) land in "unknown" rather than being dropped, so
 * the flagged counts stay honest.
 */
function buildTopDomains(items: QueryDoc[]): TopDomain[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const domain = getDestDomain(it as unknown as LogRow)
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  const total = Math.max(1, items.length)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, count]) => ({ domain, count, pct: (count / total) * 100 }))
}

/** Legend for the domain-match figure. The backend number counts rows that
 * matched a block pattern BY DOMAIN — it is NOT the destination's total
 * access volume, and this text never claims it is. */
const DOMAIN_MATCH_COUNT_LABEL = "Rows matched a block pattern by destination domain"

/** The host's domain-level flag picture, read from the OPTIONAL backend keys
 * on `GET /api/hosts/{ip}`'s `risk` object. Both fields are additive, so an
 * older backend leaves `count` null and `domains` empty, and the page renders
 * the client-side fallback / an unmeasured figure instead of a fabricated `0`. */
interface DomainMatch {
  /** Distinct flagged domains, busiest first, already capped by the backend. */
  domains: { domain: string; count: number }[]
  /** Total rows matched by domain; `null` when the backend did not say. */
  count: number | null
}

/** Read `risk.domainMatchCount` / `risk.flaggedDomains` defensively: validate
 * element shapes so a malformed payload can never render `undefined`/`NaN`. */
function readDomainMatch(risk: HostRisk): DomainMatch {
  const domains = Array.isArray(risk.flaggedDomains)
    ? risk.flaggedDomains
        .filter(
          (d): d is { domain: string; count: number } =>
            !!d && typeof d.domain === "string" && typeof d.count === "number",
        )
        .map((d) => ({ domain: d.domain, count: d.count }))
    : []
  const count =
    typeof risk.domainMatchCount === "number" && Number.isFinite(risk.domainMatchCount)
      ? risk.domainMatchCount
      : null
  return { domains, count }
}

/** Resolve the domain rows for the destination table. The backend's
 * `flaggedDomains` list is preferred when supplied (its `count` is the
 * authoritative per-domain flagged count); otherwise the client-side
 * `buildTopDomains` frame is used. BOTH sources are rows from the flagged
 * frame — every row already matched a block pattern — so both are marked
 * `flagged` and carry the honest "matched" count label; the caption then never
 * claims more than the rows say. */
function flaggedDomainDomains(sections: HostSectionData, dm: DomainMatch): TopDomain[] {
  if (dm.domains.length === 0) {
    return sections.topDomains.map((d) => ({
      domain: d.domain,
      count: d.count,
      pct: Number.isFinite(d.pct) ? d.pct : 0,
      flagged: true,
      countLabel: "matched",
    }))
  }
  const fallback = new Map(sections.topDomains.map((d) => [d.domain, d]))
  return dm.domains.map((d) => ({
    domain: d.domain,
    count: d.count,
    // Backend gives no share; compute it against the flagged rows we counted,
    // else fall back to the client-side share for the same domain.
    pct: dm.count && dm.count > 0 ? (d.count / dm.count) * 100 : (fallback.get(d.domain)?.pct ?? 0),
    flagged: true,
    countLabel: "matched",
  }))
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

async function fetchHostSectionsFindings(ip: string, timeRange: string, signal?: AbortSignal): Promise<HostSectionData> {
  const minutes = timeRangeToMinutesLive(timeRange)
  const { getFindings } = await import("../api")
  const res = await getFindings({ search: ip.trim(), minutes, limit: 500 }, { signal })
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

async function fetchHostSections(ip: string, timeRange: string, source: HostSource = "live", signal?: AbortSignal): Promise<HostSectionData> {
  const minutes = timeRangeToMinutesLive(timeRange)
  if (source === "findings") {
    try { const data = await fetchHostSectionsFindings(ip, timeRange, signal); if (data.logs.length > 0) return data } catch { /* fallback below */ }
    return { ...EMPTY_SECTIONS, window: timeRange }
  }
  // Prefer live ES rows filtered to this host — richest source (action-aware,
  // pattern matches, durations). Backend caps items at 500; total_requests is
  // the real window total and drives the request-log count summary.
  // The `ip` param uses an exact ES term filter so risk rows are found even
  // when the generic substring search would miss them.
  try {
    const res = await runQuery(minutes, { q: ip.trim(), ip: ip.trim(), signal })
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
  // Live found nothing — try findings before the honest empty state.
  try { const fb = await fetchHostSectionsFindings(ip, timeRange, signal); if (fb.logs.length > 0) return fb } catch { /* ignore */ }
  return { ...EMPTY_SECTIONS, window: timeRange }
}

/* ── Page ────────────────────────────────────────────────────────────── */

export function HostInspectorPage({
  onNavigate,
  // When omitted the page behaves as before (always active), so standalone
  // use/tests are unaffected. App passes `view === "host"`; hidden tabs stay
  // mounted, and CSS `hidden` does not stop JS, so mount fetches must not fire
  // until the tab is actually shown.
  active = true,
}: {
  onNavigate?: (view: "host" | "patterns" | "analytics" | "dashboard" | "query" | "findings" | "blacklist" | "redirects" | "logs" | "url" | "report-host") => void
  active?: boolean
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
  const [sectionsError, setSectionsError] = useState<string | null>(null)
  const [domainMatch, setDomainMatch] = useState<DomainMatch | null>(null)
  const [actionFilter, setActionFilter] = useState("All")
  const [hSource, setHSource] = useState<HostSource>("live")
  const [page, setPage] = useState(0)
  const pageSize = 50
  /** Focused node id in the client-behaviour Sankey (persistent trace). */
  const [behaviourFocus, setBehaviourFocus] = useState<string | null>(null)

  // ── Findings (Client Report) branch state ──
  const [report, setReport] = useState<ClientReport | null>(null)
  // Synced each render so the toggle effect can read the CURRENT report without
  // listing it as a dependency: the effect is keyed on `hSource` alone so it
  // never re-fires on a report change, but a stale closure would let its
  // failure guard clobber a report that landed since the effect last ran.
  const reportRef = useRef<ClientReport | null>(null)
  reportRef.current = report
  const [reportLoading, setReportLoading] = useState(false)
  const [raw, setRaw] = useState<Finding[]>([])
  const [rawTotal, setRawTotal] = useState(0)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawSearch, setRawSearch] = useState("")
  const [rawPage, setRawPage] = useState(0)
  const [rawError, setRawError] = useState<string | null>(null)
  const rawPageSize = 50

  // Epoch-ms anchors for the two expensive ES reads on this page — the host
  // profile lookup and the per-host log/analytics sections. Reset per run so
  // neither elapsed figure inherits a previous read's clock.
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | undefined>(undefined)
  const [sectionsStartedAt, setSectionsStartedAt] = useState<number | undefined>(undefined)
  useElapsed(loading, undefined, active)
  useElapsed(sectionsLoading, undefined, active)

  // One shared abort point for every user-keyed read on this page — the host
  // lookup, the report/sections toggles and the raw-findings search. A faster
  // navigation aborts the previous read (AbortError resolves undefined), and
  // the generation tags each invocation so a read that still lands after a
  // newer one cannot overwrite it. Without both, a slow stale host's data can
  // render over the host the operator just selected (the audit's "Highest"
  // race site).
  const run = useAbortable()
  // Destructure the two STABLE useCallback functions rather than keeping the
  // `useGeneration()` object: that object is a fresh literal every render, so
  // depending on it would make `fetchRaw` (and everything that reads it) new on
  // every render, refetching in a loop. `next`/`isCurrent` are stable.
  const { next: genNext, isCurrent: genCurrent } = useGeneration()
  // The selector a read was issued for, so a late response can be dropped when
  // the operator has since moved to a different host/target.
  const selectorRef = useRef("")
  // True once the raw-findings table has painted at least once, so a failed
  // refetch keeps its rows (never-blank) while a failed first load may reset.
  const rawLoadedRef = useRef(false)

  // Jailed client IPs for the header badge — best-effort, fail-closed to no
  // badge (mirrors the Query/Findings per-row pattern).
  const [jailedIndex, setJailedIndex] = useState<Record<string, true>>({})
  // Mount-time fetch, gated on `active`: a hidden (previously visited) tab must
  // not fire this. Re-runs when the tab becomes visible, so the badge index
  // still builds on first show.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    getJaillistSet()
      .then((res) => {
        if (cancelled) return
        const next: Record<string, true> = {}
        for (const ip of res.ips) next[ip] = true
        setJailedIndex(next)
      })
      .catch(() => {
        if (!cancelled) setJailedIndex({})
      })
    return () => {
      cancelled = true
    }
  }, [active])

  // Pre-fill + re-lookup from FilterContext (?q=) so the Ctrl+K palette and
  // "View Host History" land on the right host. Re-runs on
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
      // A toggle supersedes anything in flight, so claim the generation here
      // too: a slow report must not land after the operator flipped back.
      const g = genNext()
      setReportLoading(true)
      setLoadingStartedAt(Date.now())
      const selected = (host as unknown as { primaryIp: string }).primaryIp || target
      void run((signal) => getClientReport(selected, { signal }))
        .then((data) => {
          if (data === undefined || !genCurrent(g)) return
          setReport(data)
          if (data.has_data) setRawPage(0)
        })
        .catch((e) => {
          if (!genCurrent(g)) return
          if ((e as Error).name === "AbortError") return
          // Never blank a report already on screen on a failed refetch. Read
          // through the ref: `report` is deliberately absent from this effect's
          // deps (it is keyed on `hSource`), so the state value here would be
          // the stale one captured when the effect last ran.
          if (!reportRef.current) setReport(null)
          toast({ title: "Report failed", description: (e as Error).message, variant: "error" })
        })
        .finally(() => {
          if (genCurrent(g)) setReportLoading(false)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hSource])

  // Re-fetch the live sections when the toggle flips to live and the host was
  // looked up in Findings mode (sections were never loaded for it).
  useEffect(() => {
    if (!host || loading) return
    if (hSource === "live" && !sections) {
      const g = genNext()
      setSectionsLoading(true)
      setSectionsStartedAt(Date.now())
      const ip = (host as unknown as { primaryIp: string }).primaryIp || target
      void run((signal) => fetchHostSections(ip, timeRange, "live", signal))
        .then((data) => {
          if (data === undefined || !genCurrent(g)) return
          setSections(data)
        })
        .catch((e) => {
          if (!genCurrent(g)) return
          if ((e as Error).name === "AbortError") return
          setSections({ ...EMPTY_SECTIONS, window: timeRange })
        })
        .finally(() => {
          if (genCurrent(g)) setSectionsLoading(false)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hSource])

  // Domain-level flag picture from the dedicated host endpoint. This is
  // SUPPLEMENTARY to the request-log table (which is fed by `runQuery`): it is
  // fetched independently once a lookup resolves, so a failing or slow profile
  // call can never block, empty or break the log rows — those still paint from
  // `sections`. A failure leaves `domainMatch` null and the page falls back to
  // the client-side `buildTopDomains` and an unmeasured "—" figure.
  // Own abort point: this read overlaps nothing else — it starts when a lookup
  // resolves, and `lookup` also kicks off `fetchSections`. Sharing one
  // controller would let whichever starts second abort the other, leaving
  // `domainMatch` permanently null. The generation still drops a stale pair.
  const runDomainMatch = useAbortable()
  useEffect(() => {
    if (!host || loading) return
    // Keyed on the host/time-range pair: a newer pair supersedes this read.
    const g = genNext()
    setDomainMatch(null)
    const ip = host.primaryIp || target
    void runDomainMatch((signal) => getHostProfile(ip, timeRange, { signal }))
      .then((profile) => {
        if (profile === undefined || !genCurrent(g)) return
        setDomainMatch(readDomainMatch(profile.risk))
      })
      .catch(() => {
        if (genCurrent(g)) setDomainMatch(null)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, timeRange])

  // Shared sections loader: uses the cleaned host string, falls back to
  // EMPTY_SECTIONS + toasts on failure. Used by both lookup and Retry.
  // `g` is the lookup's generation, threaded in so the profile read and the
  // sections read that make up one lookup share an ownership token.
  const fetchSections = useCallback(async (clean: string, g: number) => {
    setSectionsLoading(true)
    setSectionsStartedAt(Date.now())
    setSectionsError(null)
    const data = await run((signal) => fetchHostSections(clean, timeRange, hSource, signal))
    // Superseded by a newer lookup/toggle, or aborted (undefined) — a newer
    // invocation owns the section state now.
    if (data === undefined || !genCurrent(g)) return
    // Stale-target guard: only paint if the operator is still on this host.
    if (clean === selectorRef.current) setSections(data)
    setSectionsLoading(false)
  }, [run, genCurrent, timeRange, hSource])

  const lookup = async (ip: string) => {
    const clean = ip.trim()
    if (!clean) {
      toast({ title: "Enter a host or IP", variant: "info" })
      return
    }
    // Newest invocation wins; this aborts the previous lookup's in-flight read.
    const g = genNext()
    selectorRef.current = clean
    setLoading(true)
    setLoadingStartedAt(Date.now())
    setError(null)
    setHasSearched(true)
    setHost(null)
    setSections(null)
    setSectionsLoading(false)
    setReportLoading(false)
    const profile = await run((signal) => getHostProfile(clean, timeRange, { signal }))
    if (profile === undefined || !genCurrent(g)) return
    setHost(profile)
    setLoading(false)

    if (hSource === "findings") {
      // Findings branch: always resolve the full Client Report.
      setReportLoading(true)
      try {
        const data = await run((signal) => getClientReport(clean, { signal }))
        if (data === undefined || !genCurrent(g)) return
        setReport(data)
        setRawPage(0)
      } catch (e) {
        if (!genCurrent(g)) return
        if ((e as Error).name === "AbortError") return
        setReport(null)
        setError((e as Error).message || "Report failed")
        toast({ title: "Report failed", description: (e as Error).message, variant: "error" })
      }
      if (genCurrent(g)) setReportLoading(false)
    } else {
      // Live branch: sections load independently so the entity card paints immediately.
      await fetchSections(clean, g)
    }
  }

  // ── Raw findings table (findings branch) ──
  // Own abort point so a raw search/page change cannot abort the report read
  // that triggered it (and vice versa). The generation still orders the two.
  const runRaw = useAbortable()
  const fetchRaw = useCallback(async () => {
    if (!report?.client_ip || !report.has_data) return
    // Newest search/page wins; a superseded raw read is aborted below.
    const g = genNext()
    const isFirstLoad = !rawLoadedRef.current
    setRawLoading(true)
    setRawError(null)
    try {
      const res = await runRaw((signal) =>
        getClientReportFindings(report.client_ip, {
          search: rawSearch.trim() || undefined,
          limit: rawPageSize,
          offset: rawPage * rawPageSize,
        }, { signal }),
      )
      if (res === undefined || !genCurrent(g)) return
      setRaw(res.items)
      setRawTotal(res.total)
      rawLoadedRef.current = true
    } catch (e) {
      if (!genCurrent(g)) return
      if ((e as Error).name === "AbortError") return
      // Never blank good rows on a FAILED refetch; a failed first load may reset.
      if (isFirstLoad) {
        setRaw([])
        setRawTotal(0)
      }
      const msg = (e as Error).message || "Raw findings failed"
      setRawError(msg)
      toast({ title: "Raw findings failed", description: msg, variant: "error" })
    } finally {
      if (genCurrent(g)) setRawLoading(false)
    }
  }, [runRaw, genNext, genCurrent, report, rawSearch, rawPage, toast])

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

  const handleViewReport = useCallback(() => {
    const current = (host?.primaryIp || target).trim()
    if (!current) {
      toast({ title: "No host selected", description: "Run a lookup first.", variant: "info" })
      return
    }
    setGlobalFilter(current)
    try {
      window.localStorage.setItem("unetwatch_view", "report-host")
    } catch {
      /* ignore */
    }
    onNavigate?.("report-host")
  }, [host, onNavigate, setGlobalFilter, target, toast])

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
        if (res.status === 401) {
          notifySessionExpired()
          toast({ title: "Session expired — please log in again", variant: "error" })
          return
        }
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

  // Materialize the current page from the fetched (real) rows.
  const pageRows = useMemo(() => {
    return filteredLogs.slice(page * pageSize, (page + 1) * pageSize)
  }, [filteredLogs, page, pageSize])

  // Pagination total. Live rows are capped by the backend (~500 items) so the
  // total is bounded to what we actually fetched — otherwise paging past the
  // fetched rows would show a page range beyond the data with empty rows.
  const displayTotal = useMemo(() => {
    return filteredLogs.length
  }, [filteredLogs])

  const logColumns: DataTableColumn<LogRow>[] = useMemo(
    () => [
      {
        id: "timestamp",
        slot: "identity",
        header: "Timestamp",
        filterType: "datetime",
        accessor: (r) => r.timestamp,
        cell: (r) => <TimestampCell value={r.timestamp} />,
        width: "w-48",
        defaultSortDir: "desc" as const,
      },
      {
        /* Source attribution — §3.4/§3.3.6(a) place Client IP immediately after
         * the time anchor (Subject slot). The grid is scoped to one host, so
         * the value is constant here, but a screenshot or CSV export of this
         * grid must name the source the row came from, exactly as the Query and
         * Findings grids do. */
        id: "client_ip",
        slot: "subject",
        header: "Client IP",
        filterType: "text",
        accessor: (r) => getSrcIp(r),
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{getSrcIp(r) || "—"}</span>
            <IconButton
              icon={Search}
              label="Open in Host Inspector"
              onClick={() => handleOpenHost(getSrcIp(r))}
            />
          </span>
        ),
      },
      {
        id: "dest_ip",
        slot: "object",
        header: "Dest IP",
        filterType: "text",
        accessor: (r) => getDestIp(r),
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{getDestIp(r) || "—"}</span>
            <IconButton
              icon={Search}
              label="Open in Host Inspector"
              onClick={() => handleOpenHost(getDestIp(r))}
            />
          </span>
        ),
      },
      {
        id: "url",
        slot: "object",
        header: "URL",
        filterType: "text",
        accessor: (r) => r.url,
        cell: (r) => (
          <span className="flex items-center gap-1.5">
            <span className="block max-w-[340px] truncate font-mono text-xs" title={r.url}>
              {r.url}
            </span>
            <IconButton
              icon={Search}
              label="Open in URL Investigation"
              onClick={() => handleOpenUrl(r.url ?? "")}
            />
          </span>
        ),
      },
      {
        /* Dest domain — the destination the operator acts on. Resolved from
         * `base_url` (else derived from `url`), never from the matched pattern;
         * a domain-level pattern match shows in "Triggered pattern" via
         * `blocked_by`, so this column always answers "where did it go". */
        id: "domain",
        slot: "object",
        header: "Destination",
        filterType: "text",
        accessor: (r) => getDestDomain(r),
        cell: (r) => {
          const domain = getDestDomain(r)
          return (
            <span className="flex items-center gap-1.5">
              <span className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={domain}>
                {domain || "—"}
              </span>
              <IconButton
                icon={Search}
                label="Open in URL Investigation"
                onClick={() => handleOpenUrl(domain)}
              />
            </span>
          )
        },
        width: "w-28",
      },
      /* ── Rich flat proxy fields (logstash-proxy-* schema) ── */
      {
        id: "method",
        slot: "object",
        header: "Method",
        filterType: "enum",
        accessor: (r) => r.http_method,
        cell: (r) => <span className="text-xs">{r.http_method || "—"}</span>,
        width: "w-20",
      },
      /* ── Verdict column — Action answers "whether the policy fired". ── */
      {
        id: "action",
        slot: "verdict",
        header: "Action",
        filterType: "enum",
        accessor: (r) => r.action,
        cell: (r) => <Badge variant={actionVariant(r.action ?? "")}>{r.action || "—"}</Badge>,
        width: "w-24",
      },
      {
        id: "status",
        slot: "verdict",
        header: "Status",
        filterType: "number",
        accessor: (r) => r.http_status_code,
        cell: (r) => <span className="font-mono text-xs tabular-nums">{r.http_status_code ?? "—"}</span>,
        width: "w-20",
        align: "right" as const,
      },
      {
        id: "rule",
        slot: "verdict",
        defaultHidden: true,
        header: "Rule",
        filterType: "text",
        accessor: (r) => r.rule_name ?? r.rule_info ?? "—",
        cell: (r) => {
          const rule = r.rule_name && r.rule_name !== "-" ? r.rule_name : r.rule_info
          return <span className="block max-w-[140px] truncate text-xs text-muted-foreground" title={rule}>{rule || "—"}</span>
        },
        width: "w-28",
      },
      {
        id: "pattern",
        slot: "evidence",
        defaultHidden: true,
        header: "Triggered pattern",
        filterType: "text",
        accessor: (r) => getMatchedRule(r),
        cell: (r) => (
          <span className="block max-w-[200px] truncate font-mono text-xs" title={getMatchedRule(r)}>
            {getMatchedRule(r)}
          </span>
        ),
      },
      {
        id: "category",
        slot: "evidence",
        defaultHidden: true,
        header: "Category",
        filterType: "enum",
        accessor: (r) => r.category,
        cell: (r) => <span className="text-xs text-muted-foreground">{r.category || "—"}</span>,
        width: "w-24",
      },
      {
        id: "country",
        slot: "evidence",
        defaultHidden: true,
        header: "Country",
        filterType: "enum",
        accessor: (r) => r.country_code,
        cell: (r) => <span className="text-xs">{r.country_code || "—"}</span>,
        width: "w-20",
      },
      {
        id: "bytes",
        slot: "measures",
        header: "Bytes",
        filterType: "number",
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
        id: "duration",
        slot: "measures",
        header: "Duration",
        filterType: "number",
        accessor: (r) => getDurationMs(r),
        cell: (r) => {
          const ms = getDurationMs(r)
          return <span className="font-mono text-xs tabular-nums">{ms != null ? `${ms}ms` : "—"}</span>
        },
        align: "right" as const,
        width: "w-24",
      },
    ],
    [handleOpenHost, handleOpenUrl],
  )

  /* ── Findings branch columns (ported from Client Report) ── */
  const domainColumns = useMemo<DataTableColumn<{ domain: string; count: number; volume: number; pct: number }>[]>(() => [
    { id: "domain", slot: "identity", header: "Domain", filterType: "text", accessor: (r) => r.domain, cell: (r) => <span className="block max-w-[240px] truncate font-mono text-[13px] font-semibold" title={r.domain}>{r.domain}</span> },
    { id: "count", slot: "measures", header: "Requests", filterType: "number", accessor: (r) => r.count, align: "right", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>, width: "w-20" },
    { id: "volume", slot: "measures", header: "Volume", filterType: "number", accessor: (r) => r.volume, align: "right", cell: (r) => <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{formatBytes(r.volume)}</span>, width: "w-28" },
    { id: "pct", slot: "measures", header: "Share", filterType: "number", accessor: (r) => r.pct, align: "right", cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.pct.toFixed(1)}%</span>, width: "w-20" },
  ], [])

  const patternColumns = useMemo<DataTableColumn<{ pattern: string; hits: number }>[]>(() => [
    { id: "pattern", slot: "identity", header: "Pattern", filterType: "text", accessor: (r) => r.pattern, cell: (r) => <span className="block max-w-[280px] truncate font-mono text-xs" title={r.pattern}>{r.pattern}</span> },
    { id: "hits", slot: "measures", header: "Hits", filterType: "number", accessor: (r) => r.hits, align: "right", cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.hits.toLocaleString()}</span>, width: "w-24" },
  ], [])

  const urlColumns = useMemo<DataTableColumn<{ url: string; base_url: string; count: number; last_seen: string }>[]>(() => [
    { id: "url", slot: "identity", header: "URL", filterType: "text", accessor: (r) => r.url, cell: (r) => (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[560px] truncate font-mono text-xs" title={r.url}>{r.url}</span>
        <IconButton icon={Search} label="Open in URL Investigation" onClick={() => openUrlInInvestigation(r.url)} />
      </span>
    )},
    { id: "count", slot: "measures", header: "Hits", filterType: "number", accessor: (r) => r.count, align: "right", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>, width: "w-20" },
  ], [openUrlInInvestigation])

  const rawColumns = useMemo<DataTableColumn<Finding>[]>(() => [
    { id: "log_timestamp", slot: "identity", header: "Timestamp", filterType: "datetime", accessor: (r) => r.log_timestamp, cell: (r) => <TimestampCell value={r.log_timestamp} />, width: "w-44", defaultSortDir: "desc" },
    { id: "url", slot: "object", header: "URL", filterType: "text", accessor: (r) => r.url, cell: (r) => <span className="block max-w-[420px] truncate font-mono text-xs" title={r.url}>{r.url}</span> },
    { id: "base_url", slot: "object", header: "Destination", filterType: "text", accessor: (r) => r.base_url, cell: (r) => <span className="block max-w-[200px] truncate font-mono text-xs text-muted-foreground" title={r.base_url}>{r.base_url}</span> },
    { id: "pattern", slot: "evidence", header: "Pattern", filterType: "text", enableSorting: false, accessor: (r) => { try { const p = r.matched_patterns ? JSON.parse(r.matched_patterns) : []; return Array.isArray(p) ? p : [] } catch { return [] } }, cell: (r) => {
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
            <span key={pat} className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground" title={pat}>{pat}</span>
          ))}
        </span>
      )
    } },
    { id: "volume", slot: "measures", header: "Volume", filterType: "number", accessor: (r) => { const dn = Number(r.bytes_downloaded) || 0; const up = Number(r.bytes_uploaded) || 0; if (dn || up) return dn + up; const dur = Number(r.duration_seconds) || 0; return dur > 0 ? Math.max(1, Math.round(dur)) * 8192 : 8192 }, align: "right", cell: (r) => {
      const dn = Number(r.bytes_downloaded) || 0; const up = Number(r.bytes_uploaded) || 0; const hasBytes = !!(dn || up); const dur = Number(r.duration_seconds) || 0; const vol = hasBytes ? dn + up : dur > 0 ? Math.max(1, Math.round(dur)) * 8192 : 8192
      return <span className="inline-flex items-center gap-1.5" title={hasBytes ? `Real: ↓${dn}+↑${up}` : `Est: ${dur}s×8KiB`}><span className="font-mono text-xs tabular-nums">{formatBytes(vol)}</span><Badge variant={hasBytes ? "success" : "secondary"}>{hasBytes ? "Real" : "Estimated"}</Badge></span>
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

  // Domain-level picture. An absent `domainMatchCount` reads "—" — never a
  // manufactured 0, which would look like a measured clean result; an absent
  // (or empty) `flaggedDomains` falls back to the client-side aggregation.
  const domainMatchValue =
    domainMatch?.count != null ? domainMatch.count.toLocaleString() : "—"
  const flaggedDomainsLoading = !!host && domainMatch === null && !sectionsError
  const topDomainItems: TopDomain[] = flaggedDomainsLoading
    ? []
    : sections
      ? flaggedDomainDomains(sections, domainMatch ?? { domains: [], count: null })
      : []
  // Both paths (backend `flaggedDomains` list OR the client-side flagged-frame
  // fallback) show flagged, pattern-matched domains, so the caption is set in
  // both — it never reads as total traffic and never claims more than the rows.
  const topDomainsCaption = "Flagged domains ranked by pattern matches · rules by trigger count"

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
            <Button variant="outline" onClick={handleViewReport} aria-label="View Report"><FileText className="h-4 w-4" aria-hidden="true" />View Report</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Export Report
            </Button>
            <Button variant="outline" onClick={handleViewReport} aria-label="View Report"><FileText className="h-4 w-4" aria-hidden="true" />View Report</Button>
          </>
        )}
      </PageHeader>

      {/* Standardized search toolbar - matches URL Investigation's card form. */}
      <div className="rounded-md border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Host / IP Search"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 min-w-[240px] font-mono text-[13px]"
            aria-label="Host or IP search"
          />
          {/* Fixed label + fixed min-width (sized for the longest label): the
              box is identical in both states, so the spinner swaps into the
              icon's own 4×4 cell without resizing the button or re-wrapping
              this flex-wrap row. `aria-busy` announces the lookup without a
              label flip. */}
          <Button className="min-w-[150px]" onClick={() => lookup(target)} disabled={loading} aria-busy={loading}>
            {loading ? <LoadingIcon /> : <Search className="h-4 w-4" aria-hidden="true" />}
            Lookup
          </Button>
          <Select
            value={timeRange}
            onChange={(v) => setTimeRange(v as typeof timeRange)}
            options={TIME_RANGE_OPTIONS}
            className="w-36 shrink-0"
            aria-label="Time range"
          />
          <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Data source">
            <button type="button" onClick={() => setHSource("live")} aria-pressed={hSource === "live"} className={`px-2.5 py-1 text-[11px] font-semibold transition-colors ${hSource === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm`}>Live</button>
            <button type="button" onClick={() => setHSource("findings")} aria-pressed={hSource === "findings"} className={`px-2.5 py-1 text-[11px] font-semibold transition-colors ${hSource === "findings" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm`}>Findings</button>
          </div>
        </div>
      </div>

      {/* A lookup clears the previous host first, so this is always a genuine
          first load — the elapsed figure is the honest part: live ES reads on
          a wide window routinely run 10-60s. */}
      {loading && (
        <>
          <LoadingIndicator
            label="Resolving host profile from Elasticsearch"
            active={loading}
            startedAt={loadingStartedAt}
            className="max-w-md"
          />
          <div className="space-y-5" aria-busy="true">
            {/* The resolved view is a HostEntityCard followed by the
                multi-section investigation — mirror that stack, not two flat
                blocks. */}
            <SkeletonShape variant="panel-stack" count={2} />
          </div>
        </>
      )}

      {!loading && error && (
        <Callout action={<Button variant="outline" size="sm" onClick={() => void lookup(target)}>Retry</Button>}>
          {error}
        </Callout>
      )}

      {!loading && !error && host && hSource === "live" && (
        <HostEntityCard host={host} risk={host.risk} jailed={!!jailedIndex[host.primaryIp]} />
      )}

      {!loading && !error && !host && hasSearched && (
        <EmptyState icon={SearchX} title="No host found" description={`No data for "${target}" in the selected window.`} action={<Button variant="outline" size="sm" onClick={() => void lookup(target)}>Retry</Button>} />
      )}

      {!loading && !error && !host && !hasSearched && (
        <EmptyState icon={SearchX} title="Host Investigation" description="Enter a host or IP and run Lookup. Live shows the live ES window; Findings shows all-time analytics." />
      )}

      {/* ── LIVE branch — Spec §3.2 sections (render only once a host is resolved) ── */}
      {showSections && (
        <>
          {sectionsError && (
            <Callout action={<Button variant="outline" size="sm" onClick={() => { void fetchSections(target.trim() || target, genNext()) }}>Retry</Button>}>
              {sectionsError}
            </Callout>
          )}
          {/* Refetch (time-range change / Retry) with sections already loaded:
              keep every panel below mounted and report the read out loud. The
              slot is ALWAYS rendered (same rationale as QueryPage) so the
              `space-y-5` child count never changes, and `mb-0` zeroes the gap
              it would otherwise own — spacing matches having no slot at all.
              The cue is `absolute`, adding no height. The per-panel skeletons
              only appear on the first sections load. */}
          <div className="relative mb-0">
            <LoadingIndicator
              active={sectionsLoading && Boolean(sections)}
              label="Refreshing host sections"
              startedAt={sectionsStartedAt}
              className="absolute inset-x-0 top-0 z-10 max-w-md"
            />
          </div>
          {/* 1) Visual Traffic Timeline & Anomaly Heatmap */}
          <Panel
            title="Visual Traffic Timeline & Anomaly Heatmap"
            icon={Activity}
            description={sections ? `${sections.logTotal.toLocaleString()} req · ${windowLabel(sections.window)} window` : "—"}
          >
            {sectionsLoading && !sections ? (
              <SkeletonShape variant="chart" height={240} />
            ) : sections && sections.timeline.length > 0 ? (
              <TrafficTimeline points={sections.timeline} anomalyAnnotation={sections.anomaly} />
            ) : (
              <EmptyState icon={Activity} title="No data in window" />
            )}
          </Panel>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              icon={Globe}
              label="Domain matches"
              value={domainMatchValue}
              tone="warning"
              hint={DOMAIN_MATCH_COUNT_LABEL}
            />
          </div>

          {/* 2) Top Destinations & Rule Matches */}
          {sectionsLoading && !sections ? (
            /* TopDestinations is a titled card with a two-column table body. */
            <SkeletonShape variant="panel-stack" count={1} />
          ) : sections ? (
            <TopDestinations
              topDomains={topDomainItems}
              triggeredPatterns={sections.triggeredPatterns}
              domainsCaption={topDomainsCaption}
            />
          ) : null}

          {/* 3) Ranked URLs — each row links into URL Investigation */}
          <Panel
            title="Top URLs Accessed"
            icon={Link2}
            description="Click a URL to investigate who else reached it"
          >
            {sectionsLoading && !sections ? (
              /* The loaded body is a divide-y list of one-line URL rows. */
              <SkeletonShape variant="feed-list" />
            ) : sections && sections.topUrls.length > 0 ? (
              <div className="divide-y divide-border">
                {sections.topUrls.map((u) => (
                  <button
                    key={u.url}
                    type="button"
                    onClick={() => handleOpenUrl(u.url)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
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
              <EmptyState icon={Link2} title="No data in window" />
            )}
          </Panel>

          {/* 3) Client behaviour flow — pattern → this client → Domain → dest IP */}
          <Panel
            title="Client Behaviour Flow"
            icon={Network}
            description="Pattern → this client → Domain → destination · hover traces a path · click isolates it"
          >
            {sectionsLoading && !sections ? (
              /* The loaded body is a Sankey node/link flow diagram. */
              <SkeletonShape variant="dag" />
            ) : behaviourFlow && behaviourFlow.links.length > 0 ? (
              <>
                {behaviourFocus && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
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
              <EmptyState icon={Network} title="No data in window" />
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
              loading={sectionsLoading && pageRows.length === 0}
              busy={sectionsLoading}
              empty={{
                icon: SearchX,
                title: "No log entries",
                description: "Try a broader time range or clear the action filter.",
                action: <Button variant="outline" size="sm" onClick={() => setTimeRange("30d")}>Broaden range</Button>,
              }}
              defaultSortBy="timestamp"
              defaultSortDir="desc"
              page={page}
              pageSize={pageSize}
              total={displayTotal}
              onPageChange={setPage}
              viewKey="host-log"
              ariaLabel="Host request logs"
            />
          </Panel>
        </>
      )}

      {/* ── FINDINGS branch — Client Report analytics ── */}
      {showReport && (
        <>
          {report && jailedIndex[report.client_ip] ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold">{report.client_ip}</span>
              <Badge variant="destructive">Jailed</Badge>
            </div>
          ) : null}
          {reportLoading && !report ? (
            <SkeletonShape variant="stat-grid" />
          ) : report && !hasRealData && hasSearched ? (
            <EmptyState icon={SearchX} title={`No findings for ${report.client_ip}`} description="This client has no findings in the database." action={<Button variant="outline" size="sm" onClick={() => void lookup(target)}>Search again</Button>} />
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
                <Panel title="Top domains" icon={Globe}>
                  <DataTable columns={domainColumns} data={report.top_domains} rowId={(r) => r.domain} viewKey="host-domains" empty={{ icon: Globe, title: "No domains in window", description: "Try a broader date range.", action: <Button variant="outline" size="sm" onClick={() => setTimeRange("30d")}>Broaden range</Button> }} ariaLabel="Top domains" />
                </Panel>
                <Panel title="Top patterns" icon={Link2}>
                  <DataTable columns={patternColumns} data={report.top_patterns} rowId={(r) => r.pattern} viewKey="host-patterns" empty={{ icon: SearchX, title: "No patterns in window", description: "No matched patterns.", action: <Button variant="outline" size="sm" onClick={() => setTimeRange("30d")}>Broaden range</Button> }} ariaLabel="Top patterns" />
                </Panel>
              </div>

              <Panel title="Top URLs" icon={Link2} description="Click to investigate">
                <DataTable columns={urlColumns} data={report.top_urls} rowId={(r) => r.url} viewKey="host-urls" empty={{ icon: SearchX, title: "No URLs in window", description: "Try a broader date range.", action: <Button variant="outline" size="sm" onClick={() => setTimeRange("30d")}>Broaden range</Button> }} ariaLabel="Top URLs" />
              </Panel>

              {rawError && (
                <Callout className="mb-3" action={<Button variant="outline" size="sm" onClick={() => void fetchRaw()}>Retry</Button>}>
                  {rawError}
                </Callout>
              )}
              <Panel title={`Raw Findings — ${report.client_ip}`} icon={Database} description={`${rawTotal.toLocaleString()} docs`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <SearchInput placeholder="Filter (URL)..." value={rawSearch} onChange={(v) => { setRawSearch(v); setRawPage(0) }} className="w-64" aria-label="Filter raw findings" />
                  <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">findings table · whitelist-excluded</span>
                </div>
                <DataTable columns={rawColumns} data={raw} rowId={(r) => String(r.id)} viewKey="host-raw" loading={rawLoading && raw.length === 0} busy={rawLoading} total={rawTotal} page={rawPage} pageSize={rawPageSize} onPageChange={setRawPage} empty={{ icon: SearchX, title: "No findings in window", description: "Try a broader date range or clear the filter.", action: <Button variant="outline" size="sm" onClick={() => setTimeRange("30d")}>Broaden range</Button> }} ariaLabel="Raw findings" />
              </Panel>
            </>
          ) : null}
        </>
      )}
    </div>
  )
}