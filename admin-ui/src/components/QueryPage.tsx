import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Ban,
  CheckCircle2,
  Copy,
  Database,
  Globe,
  Network,
  Play,
  RefreshCcw,
  Search,
  SearchX,
  Server,
  ShieldAlert,
  Users,
  Zap,
} from "lucide-react"
import { useDebounce, useAutoRefresh } from "../lib/utils"
import { useFilter } from "../contexts/FilterContext"
import { type LogRow } from "../lib/logRow"
import {
  type QueryDoc,
  type QueryResult,
  addBaseUrlToBlacklist,
  buildFlowSankey,
  formatBytes,
  runQuery,
  timeRangeToMinutesLive,
} from "../api"
import {
  Badge,
  Button,
  CopyUrlButton,
  EmptyState,
  ListBadge,
  LoadingIcon,
  PageHeader,
  Panel,
  RankedTable,
  SearchInput,
  Select,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { ListActionCell } from "./ListActionDropdown"
import { SankeyDiagram } from "./SankeyDiagram"
import { EventInspectorSidebar } from "./EventInspectorSidebar"

const DEFAULT_PAGE_SIZE = 25

// Shared workspace time window — same 1h/24h/7d/30d as FilterContext.
const TIME_RANGE_OPTIONS = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
]

const WHITELIST_OPTIONS = [
  { value: "include", label: "Include whitelisted" },
  { value: "exclude", label: "Exclude whitelisted" },
]

const BLACKLIST_OPTIONS = [
  { value: "include", label: "Include blacklisted" },
  { value: "exclude", label: "Exclude blacklisted" },
]

const ACTION_FILTER_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "ALLOW", label: "ALLOW" },
  { value: "DENY", label: "DENY" },
]

/** True when the URL/string's host is a bare IPv4 address. */
function isIpHost(url: string): boolean {
  const host = url.split("://").pop()?.split(/[/?#]/)[0] ?? url
  const octets = host.split(".")
  return (
    octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  )
}

/* ── Content sections use the shared Panel card (consistency) ─────── */

function formatTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatFull(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

/* Module-level handle to the page's state setter, synced each render. Keeps
 * QUERY_COLUMNS referentially stable at module scope while the actions cell's
 * onBlacklisted callback can still update component state. */
const queryUI: {
  setResult: (fn: (prev: QueryResult | null) => QueryResult | null) => void
  onInspectHost: (ip: string) => void
  onInspectUrl: (url: string) => void
} = {
  setResult: () => {},
  onInspectHost: () => {},
  onInspectUrl: () => {},
}

/** Stable row identity for the query-results table + bulk actions. */
function queryRowId(d: QueryDoc): string {
  return `${d.timestamp}|${d.client_ip}|${d.url}`
}

/** Copy button wrapped so its click never bubbles to the row's inspector sidebar. */
function CopyCell({ value, label }: { value: string; label: string }) {
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <CopyUrlButton value={value} label={label} />
    </span>
  )
}

/** Quick-nav icon button (opens Host Inspector / URL Investigation). */
function QuickNavCell({ kind, value, label }: { kind: "host" | "url"; value: string; label: string }) {
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => (kind === "host" ? queryUI.onInspectHost(value) : queryUI.onInspectUrl(value))}
        className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
        aria-label={label}
        title={label}
      >
        <Search className="h-3 w-3" />
      </button>
    </span>
  )
}

/* Module-scope column definitions — referentially stable, so DataTable never
 * re-sorts/re-renders when QueryPage re-renders. The actions cell updates
 * result state through the module-level queryUI handle. */
const QUERY_COLUMNS: DataTableColumn<QueryDoc>[] = [
  {
    id: "timestamp",
    header: "Timestamp",
    accessor: (d) => d.timestamp,
    cell: (d) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground">{formatFull(d.timestamp)}</span>
    ),
    className: "whitespace-nowrap",
    width: "w-44",
    defaultSortDir: "desc",
  },
  {
    id: "client_ip",
    header: "Client IP",
    accessor: (d) => d.client_ip,
    defaultSortDir: "asc",
    cell: (d) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs">{d.client_ip}</span>
        <QuickNavCell kind="host" value={d.client_ip} label="Open in Host Inspector" />
        <CopyCell value={d.client_ip} label="Client IP" />
      </span>
    ),
  },
  {
    id: "server_ip",
    header: "Server IP",
    accessor: (d) => d.server_ip,
    defaultSortDir: "asc",
    cell: (d) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-muted-foreground">{d.server_ip}</span>
        <CopyCell value={d.server_ip} label="Server IP" />
      </span>
    ),
  },
  {
    id: "url",
    header: "URL",
    accessor: (d) => d.url,
    defaultSortDir: "asc",
    cell: (d) => (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[340px] truncate font-mono text-xs" title={d.url}>
          {d.url}
        </span>
        <QuickNavCell kind="url" value={d.url} label="Open in URL Investigation" />
        <CopyCell value={d.url} label="URL" />
      </span>
    ),
  },
  {
    id: "base_url",
    header: "Base URL",
    accessor: (d) => d.base_url,
    defaultSortDir: "asc",
    cell: (d) => (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={d.base_url}>
          {d.base_url}
        </span>
        <QuickNavCell kind="url" value={d.base_url} label="Open in URL Investigation" />
        <CopyCell value={d.base_url} label="Base URL" />
      </span>
    ),
  },
  {
    id: "bytes_downloaded",
    header: "↓ Bytes",
    accessor: (d) => d.bytes_downloaded,
    align: "right",
    cell: (d) => {
      const b = Number(d.bytes_downloaded) || 0
      return b > 0 ? (
        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{formatBytes(b)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    },
    width: "w-24",
  },
  {
    id: "bytes_uploaded",
    header: "↑ Bytes",
    accessor: (d) => d.bytes_uploaded,
    align: "right",
    cell: (d) => {
      const b = Number(d.bytes_uploaded) || 0
      return b > 0 ? (
        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{formatBytes(b)}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    },
    width: "w-24",
  },
  {
    id: "duration",
    header: "Duration",
    accessor: (d) => d.duration_seconds,
    cell: (d) =>
      d.duration_seconds === null || d.duration_seconds === undefined ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="tabular-nums text-xs">{d.duration_seconds.toFixed(2)}s</span>
      ),
    align: "right",
    width: "w-20",
  },
  {
    id: "action",
    header: "Action",
    accessor: (d) => d.action,
    cell: (d) => (
      <Badge variant={d.action === "ALLOW" ? "success" : "warning"}>{d.action}</Badge>
    ),
    width: "w-24",
  },
  {
    id: "pattern",
    header: "Pattern",
    accessor: (d) => d.blocked_by,
    enableSorting: false,
    cell: (d) => (
      <span className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground" title={(d.blocked_by ?? []).join(", ") || undefined}>
        {(d.blocked_by ?? []).join(", ") || "—"}
      </span>
    ),
    width: "w-40",
  },
  {
    id: "coverage",
    header: "Lists",
    enableSorting: false,
    cell: (d) => (
      <div className="flex flex-wrap items-center gap-1">
        {d.blacklisted && d.action === "ALLOW" && (
          <ListBadge
            tone="danger"
            icon={ShieldAlert}
            title="Blacklisted destination still allowed through — highest risk"
          >
            blacklist risk
          </ListBadge>
        )}
        {d.whitelisted && (
          <ListBadge
            tone="success"
            icon={CheckCircle2}
            title="URL matches a whitelist pattern — excluded from findings"
          >
            whitelist
          </ListBadge>
        )}
        {d.blacklisted && d.action !== "ALLOW" && (
          <ListBadge
            tone="danger"
            icon={CheckCircle2}
            title={
              d.blacklist_source === "ip"
                ? "Destination IP is on the blacklist"
                : "Host is on the blacklist"
            }
          >
            blacklist{d.blacklist_source === "ip" ? " · ip" : ""}
          </ListBadge>
        )}
        {!d.whitelisted && !d.blacklisted && (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </div>
    ),
    width: "w-44",
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    cell: (d) => (
      <span onClick={(e) => e.stopPropagation()}>
        <ListActionCell
          baseUrl={d.base_url}
          onBlacklisted={() =>
            queryUI.setResult((prev) => {
              if (!prev) return prev
              const source = isIpHost(d.base_url) ? ("ip" as const) : ("url" as const)
              return {
                ...prev,
                items: prev.items.map((item) =>
                  item.base_url === d.base_url
                    ? { ...item, blacklisted: true, blacklist_source: source }
                    : item,
                ),
              }
            })
          }
        />
      </span>
    ),
    width: "w-12",
  },
]

/* ── Timeline area chart (pure SVG) ─────────────────────────────────── */

/* Timeline chart geometry — module constants so the memoized paths below have
 * no per-render closure deps. */
const CHART_W = 720
const CHART_H = 210
const CHART_PAD = { l: 42, r: 14, t: 14, b: 26 }

function TimelineChart({ points }: { points: { bucket: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Paths + scales are pure functions of `points` — recomputed only when the
  // timeline data changes, not on every hover/leave re-render.
  const chart = useMemo(() => {
    const max = Math.max(1, ...points.map((p) => p.count))
    const innerW = CHART_W - CHART_PAD.l - CHART_PAD.r
    const innerH = CHART_H - CHART_PAD.t - CHART_PAD.b
    const x = (i: number) =>
      CHART_PAD.l + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
    const y = (c: number) => CHART_PAD.t + innerH - (c / max) * innerH

    const linePath = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.count).toFixed(1)}`)
      .join(" ")
    const areaPath = `${linePath} L ${x(points.length - 1).toFixed(1)} ${CHART_PAD.t + innerH} L ${x(0).toFixed(1)} ${CHART_PAD.t + innerH} Z`

    const gridLines = [0, 0.5, 1].map((f) => ({
      y: y(max * f),
      label: Math.round(max * f).toLocaleString(),
    }))
    const xLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1]
    return { max, x, y, linePath, areaPath, gridLines, xLabels, innerW, innerH }
  }, [points])

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const px = ((e.clientX - rect.left) / rect.width) * CHART_W
    const ratio = (px - CHART_PAD.l) / chart.innerW
    const i = Math.round(ratio * (points.length - 1))
    setHover(Math.min(points.length - 1, Math.max(0, i)))
  }

  const hoverPoint = hover !== null ? points[hover] : null

  return (
    <div ref={wrapRef} className="relative w-full" onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Requests over time"
      >
        <defs>
          <linearGradient id="timeline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {chart.gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={CHART_PAD.l}
              x2={CHART_W - CHART_PAD.r}
              y1={g.y}
              y2={g.y}
              className="stroke-border/60"
              strokeDasharray={i === 0 ? undefined : "3 3"}
            />
            <text x={CHART_PAD.l - 6} y={g.y + 3} textAnchor="end" fontSize={9} className="fill-muted-foreground">
              {g.label}
            </text>
          </g>
        ))}

        <path d={chart.areaPath} fill="url(#timeline-fill)" />
        <path d={chart.linePath} fill="none" stroke="var(--color-primary)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />

        {chart.xLabels.map((i) => (
          <text
            key={i}
            x={chart.x(i)}
            y={CHART_H - 6}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            fontSize={9}
            className="fill-muted-foreground"
          >
            {formatTime(points[i].bucket)}
          </text>
        ))}

        {hoverPoint && (
          <g>
            <line
              x1={chart.x(hover ?? 0)}
              x2={chart.x(hover ?? 0)}
              y1={CHART_PAD.t}
              y2={CHART_PAD.t + chart.innerH}
              className="stroke-muted-foreground/50"
              strokeDasharray="3 3"
            />
            <circle cx={chart.x(hover ?? 0)} cy={chart.y(hoverPoint.count)} r={3.5} className="fill-primary stroke-background" strokeWidth={2} />
          </g>
        )}
      </svg>

      {hoverPoint && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 border-[2.5px] border-[#0A0A0A] bg-popover px-2.5 py-1.5 font-mono text-xs font-bold brutal-shadow-sm dark:border-[#F6F2E8]"
          style={{ left: `${(chart.x(hover) / CHART_W) * 100}%`, top: 0 }}
        >
          <p className="font-semibold tabular-nums">{hoverPoint.count.toLocaleString()} req</p>
          <p className="text-muted-foreground">{formatFull(hoverPoint.bucket)}</p>
        </div>
      )}
    </div>
  )
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function QueryPage({ onNavigate }: { onNavigate?: (view: "host" | "patterns" | "analytics" | "dashboard" | "query" | "findings" | "blacklist" | "redirects" | "logs" | "url") => void } = {}) {
  const { toast } = useToast()
  const { viewMode, setViewMode, setGlobalFilter, timeRange, setTimeRange } = useFilter()
  const [whitelistMode, setWhitelistMode] = useState<"include" | "exclude">("include")
  const [blacklistMode, setBlacklistMode] = useState<"include" | "exclude">("exclude")
  const [actionFilter, setActionFilter] = useState<"all" | "ALLOW" | "DENY">("all")
  const [uniqueDomainsOnly, setUniqueDomainsOnly] = useState(false)
  const [esSearch, setEsSearch] = useState("")
  const debouncedEsSearch = useDebounce(esSearch, 400)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawerRow, setDrawerRow] = useState<LogRow | null>(null)
  // Sankey adaptive controls — Focus + Detail (Track A)
  const [sankeyTopN, setSankeyTopN] = useState<10 | 20 | 50>(20)
  const [groupOthers, setGroupOthers] = useState(true)
  const [hideSingletons, setHideSingletons] = useState(true)
  const [flowCollapsed, setFlowCollapsed] = useState(false)
  const [focusedSankeyId, setFocusedSankeyId] = useState<string | null>(null)
  // Auto-collapse Sankey when entering a long window
  useEffect(() => {
    if (timeRange === "7d" || timeRange === "30d") setFlowCollapsed(true)
    else setFlowCollapsed(false)
  }, [timeRange])

  // Hand the stable setter to the module-scope QUERY_COLUMNS actions cell.
  queryUI.setResult = setResult
  queryUI.onInspectHost = (ip: string) => {
    setGlobalFilter(ip)
    try { window.localStorage.setItem("unetwatch_view", "host") } catch { /* ignore */ }
    onNavigate?.("host")
  }
  queryUI.onInspectUrl = (url: string) => {
    setGlobalFilter(url)
    try { window.localStorage.setItem("unetwatch_view", "url") } catch { /* ignore */ }
    onNavigate?.("url")
  }
  const columns: DataTableColumn<QueryDoc>[] = QUERY_COLUMNS

  const fetchQuery = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const q = debouncedEsSearch.trim() || undefined
    runQuery(timeRangeToMinutesLive(timeRange), {
      q,
      excludeWhitelist: whitelistMode === "exclude",
      excludeBlacklist: blacklistMode === "exclude",
      viewMode,
    })
      .then((res) => {
        if (!cancelled) setResult(res)
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message)
          setResult(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [timeRange, whitelistMode, blacklistMode, debouncedEsSearch, viewMode])

  // Auto-run when the ES-level filter or whitelist mode changes.
  useEffect(() => fetchQuery(), [fetchQuery])

  // Auto-refresh — every 30s by default when the tab is visible; skips when
  // hidden so background tabs don't hammer ES. Persists per-key in localStorage.
  const { refreshSeconds: _queryRefresh } = useAutoRefresh(fetchQuery, "query", 0)
  void _queryRefresh

  const handleRun = () => fetchQuery()

  // Flow (Pattern → client IP → URL → Destination) built from this page's own
  // result items — no second ES round-trip.
  const FLOW_SANKEY_OPTS = { maxPat: 12, maxSrc: sankeyTopN, maxUrl: sankeyTopN, maxDst: sankeyTopN, minWeight: hideSingletons ? 2 : 1, groupOthers, keepRisk: true } as const
  const flowSankey = useMemo(
    () => (result && result.items.length > 0 ? buildFlowSankey(result.items, FLOW_SANKEY_OPTS as any) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, sankeyTopN, groupOthers, hideSingletons],
  )
  const handleBulkBlacklist = async (ids: Set<string | number>) => {
    const rows = (result?.items ?? []).filter((d) => ids.has(queryRowId(d)))
    const bases = [...new Set(rows.map((r) => r.base_url).filter(Boolean))]
    if (!bases.length) return
    try {
      const results = await Promise.all(bases.map((b) => addBaseUrlToBlacklist(b)))
      const added = results.reduce((n, r) => n + r.added.length, 0)
      toast({
        title: added ? `${added} base URL${added === 1 ? "" : "s"} blacklisted` : "Already in blacklist",
        variant: added ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    }
  }

  const handleBulkCopy = async (ids: Set<string | number>) => {
    const rows = (result?.items ?? []).filter((d) => ids.has(queryRowId(d)))
    const urls = [...new Set(rows.map((r) => r.url).filter(Boolean))]
    if (!urls.length) return
    try {
      await navigator.clipboard.writeText(urls.join("\n"))
      toast({ title: `${urls.length} URL${urls.length === 1 ? "" : "s"} copied`, variant: "success" })
    } catch (e) {
      toast({ title: "Copy failed", description: (e as Error).message, variant: "error" })
    }
  }

  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [docSearch, setDocSearch] = useState("")
  const debouncedDocSearch = useDebounce(docSearch, 200)
  const q = debouncedDocSearch.trim().toLowerCase()

  // Reset to the first page whenever a new query result, search, or action filter arrives.
  useEffect(() => {
    setPage(0)
  }, [result, debouncedDocSearch, actionFilter, blacklistMode])

  // Client-side substring filter across IPs and URLs.
  const visibleItems = useMemo(() => {
    const items = result?.items ?? []
    if (!q) return items
    return items.filter((d) =>
      [d.client_ip, d.server_ip, d.url, d.base_url].some((field) =>
        field.toLowerCase().includes(q),
      ),
    )
  }, [result, q])

  // Client-side action filter (ALLOW / DENY) layered on top of the doc search.
  const actionFilteredItems = useMemo(() => {
    if (actionFilter === "all") return visibleItems
    return visibleItems.filter((d) => d.action === actionFilter)
  }, [visibleItems, actionFilter])

  // Optional dedupe to one row per unique domain (base_url).
  const tableItems = useMemo(() => {
    if (!uniqueDomainsOnly) return actionFilteredItems
    const seen = new Set<string>()
    const out: QueryDoc[] = []
    for (const d of actionFilteredItems) {
      const key = d.base_url || d.url
      if (seen.has(key)) continue
      seen.add(key)
      out.push(d)
    }
    return out
  }, [actionFilteredItems, uniqueDomainsOnly])

  const esOffline = result !== null && !result.es_online

  // ADR 0001 metrics: enforcements (DENY — proxy handled) + real bandwidth,
  // aggregated from the fetched items (was Live Monitor MetricCards).
  const deniedCount = useMemo(
    () => (result?.items ?? []).filter((d) => d.action === "DENY").length,
    [result],
  )
  const bandwidthValue = useMemo(() => {
    let total = 0
    for (const it of result?.items ?? []) {
      total += Number(it.bytes_downloaded) || 0
      total += Number(it.bytes_uploaded) || 0
    }
    return total > 0 ? formatBytes(total) : "—"
  }, [result])

  // Row click opens the EventInspectorSidebar for deep row detail (was Live Monitor).
  const handleRowClick = useCallback(
    (row: QueryDoc) => {
      setDrawerRow(row as unknown as LogRow)
    },
    [],
  )

  // Single pass over the filtered rows for the footer counts (was three
  // separate .filter() sweeps on every render).
  const coverageCounts = useMemo(() => {
    let risk = 0
    let whitelisted = 0
    let blacklisted = 0
    for (const d of actionFilteredItems) {
      if (d.blacklisted && d.action === "ALLOW") risk++
      if (d.whitelisted) whitelisted++
      if (d.blacklisted) blacklisted++
    }
    return { risk, whitelisted, blacklisted }
  }, [actionFilteredItems])

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Query"
        description="Live traffic matching block patterns."
      >
        <SearchInput
          placeholder="Filter inside ES (IP / URL)..."
          value={esSearch}
          onChange={setEsSearch}
          className="w-56"
          aria-label="Filter results inside Elasticsearch"
        />
        <Select
          value={whitelistMode}
          onChange={(v) => setWhitelistMode(v as "include" | "exclude")}
          options={WHITELIST_OPTIONS}
          className="w-44"
          aria-label="Whitelisted matches"
        />
        <Select
          value={blacklistMode}
          onChange={(v) => setBlacklistMode(v as "include" | "exclude")}
          options={BLACKLIST_OPTIONS}
          className="w-44"
          aria-label="Blacklisted matches"
        />
        <Select
          value={actionFilter}
          onChange={(v) => setActionFilter(v as "all" | "ALLOW" | "DENY")}
          options={ACTION_FILTER_OPTIONS}
          className="w-40"
          aria-label="Filter by action"
        />
        <span className="text-xs text-muted-foreground">Window</span>
        <Select
          value={timeRange}
          onChange={(v) => setTimeRange(v as typeof timeRange)}
          options={TIME_RANGE_OPTIONS}
          className="w-36"
          aria-label="Query time window"
        />
        {/* Full stream / Flagged only — shared workspace view mode (was Live Monitor). */}
        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="View mode">
          <button
            type="button"
            onClick={() => setViewMode("all")}
            aria-pressed={viewMode === "all"}
            className={`px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors ${
              viewMode === "all"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Full stream
          </button>
          <button
            type="button"
            onClick={() => setViewMode("flagged")}
            aria-pressed={viewMode === "flagged"}
            className={`px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors ${
              viewMode === "flagged"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Flagged only
          </button>
        </div>
        <Button onClick={handleRun} disabled={loading}>
          {loading ? <LoadingIcon /> : <Play className="h-4 w-4" />}
          {loading ? "Running…" : "Run"}
        </Button>
        <Button variant="outline" size="sm" onClick={handleRun} disabled={loading}>
          {loading ? <LoadingIcon /> : <RefreshCcw className="h-4 w-4" />}
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </PageHeader>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Zap}
          label="Total requests"
          value={result ? result.total_requests.toLocaleString() : "—"}
          tone="info"
          hint={`Matching block patterns · ${timeRange} window`}
        />
        <StatCard
          icon={Users}
          label="Unique client IPs"
          value={result ? result.unique_ips.toLocaleString() : "—"}
          tone="default"
          hint="Distinct clients in window"
        />
        <StatCard
          icon={ShieldAlert}
          label="Enforcements (handled)"
          value={result ? deniedCount.toLocaleString() : "—"}
          tone="success"
          hint="DENY — proxy already blocked"
        />
        <StatCard
          icon={Globe}
          label="Distinct URLs"
          value={result ? result.distinct_urls.toLocaleString() : "—"}
          tone="warning"
          hint="Flagged URLs matched"
        />
        <StatCard
          icon={Database}
          label="Bandwidth"
          value={result ? bandwidthValue : "—"}
          tone="default"
          hint="Download + upload, fetched window"
        />
        <StatCard
          icon={Server}
          label="ES status"
          value={result ? (result.es_online ? "Online" : "Offline") : "—"}
          tone={result ? (result.es_online ? "success" : "danger") : "default"}
          hint="Elasticsearch connectivity"
        />
      </div>

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        </div>
      ) : error ? (
        <EmptyState
          icon={SearchX}
          title="Query failed"
          description={error}
          action={
            <Button variant="outline" onClick={handleRun}>
              Try again
            </Button>
          }
        />
      ) : !result ? null : (
        <>
          {/* Timeline chart */}
          <Panel title="Requests over time" icon={Network}>
            {result.timeline.length > 0 ? (
              <TimelineChart points={result.timeline} />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No timestamped matches in this window
              </p>
            )}
          </Panel>

          {/* Top rankings */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Top URLs" icon={Globe}>
              <RankedTable rows={result.top_urls.map((u) => ({ label: u.url, count: u.count }))} />
            </Panel>
            <Panel title="Top client IPs" icon={Users}>
              <RankedTable rows={result.top_ips.map((u) => ({ label: u.client_ip, count: u.count }))} />
            </Panel>
          </div>

          {/* Flow visualization — Sankey (Pattern → client IP → URL → Destination).
              cv-auto skips the panel's paint until scrolled into view. */}
          <Panel
            title="Traffic flow"
            icon={Network}
            description="Pattern → client IP → URL → Destination · hover traces a path · click isolates it"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={String(sankeyTopN)}
                  onChange={(v) => setSankeyTopN(Number(v) as 10 | 20 | 50)}
                  options={[
                    { value: "10", label: "Top 10" },
                    { value: "20", label: "Top 20" },
                    { value: "50", label: "Top 50" },
                  ]}
                  className="w-28"
                  aria-label="Sankey top N"
                />
                <Button
                  variant={groupOthers ? "default" : "outline"}
                  size="sm"
                  onClick={() => setGroupOthers((v) => !v)}
                  aria-pressed={groupOthers}
                >
                  {groupOthers ? "Grouped" : "Group tail"}
                </Button>
                <Button
                  variant={hideSingletons ? "default" : "outline"}
                  size="sm"
                  onClick={() => setHideSingletons((v) => !v)}
                  aria-pressed={hideSingletons}
                >
                  {hideSingletons ? "Hiding 1-hit" : "Hide 1-hit"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setSankeyTopN(10); setGroupOthers(true); setHideSingletons(true); setFocusedSankeyId(null) }}
                >
                  Simplify
                </Button>
                <Button variant="outline" size="sm" onClick={handleRun} disabled={loading}>
                  {loading ? <LoadingIcon /> : <RefreshCcw className="h-4 w-4" />}
                  {loading ? "Refreshing…" : "Refresh"}
                </Button>
                {(timeRange === "7d" || timeRange === "30d") && (
                  <Button variant="ghost" size="sm" onClick={() => setFlowCollapsed((v) => !v)}>
                    {flowCollapsed ? "Show flow" : "Collapse"}
                  </Button>
                )}
              </div>
            }
          >
            {flowCollapsed ? (
              <div className="flex flex-col items-center gap-3 py-10">
                <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Flow collapsed for this window — {result?.total_requests.toLocaleString() ?? "—"} requests
                </p>
                <Button variant="outline" onClick={() => setFlowCollapsed(false)}>
                  Show flow{flowSankey ? ` — ${flowSankey.links.length} ribbons` : ""}
                </Button>
              </div>
            ) : esOffline ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Flow unavailable — Elasticsearch unreachable.
              </p>
            ) : flowSankey && flowSankey.links.length > 0 ? (
              <>
                {(flowSankey as any).meta && ((flowSankey as any).meta.othersCount > 0 || (flowSankey as any).meta.hiddenSingletons > 0) && (
                  <p className="mb-3 font-mono text-[11px] text-muted-foreground">
                    Showing top {sankeyTopN}
                    {(flowSankey as any).meta.othersCount > 0 ? ` · ${(flowSankey as any).meta.grouped.src + (flowSankey as any).meta.grouped.url + (flowSankey as any).meta.grouped.pat + (flowSankey as any).meta.grouped.dst} items grouped as Others` : ""}
                    {(flowSankey as any).meta.hiddenSingletons > 0 ? ` · ${(flowSankey as any).meta.hiddenSingletons} singletons hidden (risk kept)` : ""}
                    {" · "}
                    <button type="button" onClick={() => { setGroupOthers(false); setHideSingletons(false); setSankeyTopN(50) }} className="underline hover:text-foreground">Show all</button>
                  </p>
                )}
                {focusedSankeyId && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 border-[2px] border-[#0A0A0A] bg-secondary px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-[#0A0A0A] dark:border-[#F6F2E8]">
                    <span>Focused: {focusedSankeyId.replace(/^(stub:)?(src|pat|url|dom|dst|ip|base):/, "")}</span>
                    <span className="opacity-60">(trace isolated)</span>
                    <Button variant="outline" size="sm" onClick={() => setFocusedSankeyId(null)} className="ml-auto h-6 px-2 text-[10px]">Clear focus</Button>
                  </div>
                )}
                <div className="cv-auto">
                  <SankeyDiagram
                    nodes={flowSankey.nodes}
                    links={flowSankey.links}
                    focusedId={focusedSankeyId}
                    onNodeClick={(info) => { setGlobalFilter(info.name); setFocusedSankeyId(info.id) }}
                    ariaLabel="Traffic flow — Pattern to client IP to URL to destination IP"
                  />
                </div>
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No traffic in this window to visualize
              </p>
            )}
          </Panel>

          {/* Documents table */}
          <Panel
            title="Matching documents"
            icon={SearchX}
            description={`${actionFilteredItems.length.toLocaleString()}${q ? ` of ${result.items.length.toLocaleString()}` : ""} · ${coverageCounts.risk} blacklist risk · ${coverageCounts.whitelisted} whitelisted · ${coverageCounts.blacklisted} blacklisted`}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  placeholder="Filter by IP or URL..."
                  value={docSearch}
                  onChange={setDocSearch}
                  className="w-64"
                  aria-label="Filter documents by IP or URL"
                />
                <Button
                  variant={uniqueDomainsOnly ? "default" : "outline"}
                  size="sm"
                  onClick={() => setUniqueDomainsOnly((v) => !v)}
                  aria-pressed={uniqueDomainsOnly}
                  className={uniqueDomainsOnly ? "text-[#0A0A0A]" : ""}
                >
                  {uniqueDomainsOnly ? "Showing unique domains" : "Unique domains"}
                </Button>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Server className="h-3.5 w-3.5" aria-hidden="true" />
                  {result.es_online ? "Elasticsearch online" : "Elasticsearch unreachable"}
                </span>
              </div>
            }
          >
            {/* Badge legend */}
            <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-[2.5px] border-[#0A0A0A] bg-muted px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground brutal-shadow-sm dark:border-[#F6F2E8]">
              <span className="inline-flex items-center gap-1.5">
                <ListBadge tone="danger" icon={ShieldAlert}>
                  blacklist risk
                </ListBadge>
                blacklisted destination still allowed through
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ListBadge tone="success" icon={CheckCircle2}>
                  whitelist
                </ListBadge>
                matches a whitelist pattern — excluded from findings
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ListBadge tone="danger" icon={CheckCircle2}>
                  blacklist
                </ListBadge>
                host or destination IP on the blacklist
              </span>
            </div>
            <DataTable
              columns={columns}
              data={tableItems}
              rowId={queryRowId}
              selectable
              busy={loading}
              internalPagination
              bulkActions={[
                {
                  label: "Blacklist",
                  icon: Ban,
                  variant: "outline",
                  onClick: handleBulkBlacklist,
                  className: "text-destructive hover:text-destructive",
                },
                { label: "Copy URLs", icon: Copy, variant: "outline", onClick: handleBulkCopy },
              ]}
              empty={{
                icon: SearchX,
                title: "No matching documents",
                description: q
                  ? "Nothing matches your filter — try a different IP or URL substring."
                  : "Try a longer window or trigger a manual run.",
              }}
              defaultSortBy="timestamp"
              defaultSortDir="desc"
              page={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(0) }}
              onRowClick={handleRowClick}
              ariaLabel="Query results"
            />
          </Panel>
        </>
      )}

      {/* Deep row inspection (was Live Monitor) — click a row to open. */}
      {drawerRow && (
        <EventInspectorSidebar
          row={drawerRow}
          onClose={() => setDrawerRow(null)}
          onNavigate={(v) => {
            window.localStorage.setItem("unetwatch_view", v)
            onNavigate?.(v)
            setDrawerRow(null)
          }}
        />
      )}
    </div>
  )
}
