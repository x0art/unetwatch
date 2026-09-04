import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Copy,
  Database,
  Globe,
  Network,
  Play,
  RefreshCcw,
  SearchX,
  Server,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useDebounce } from "../lib/utils"
import { useFilter } from "../contexts/FilterContext"
import {
  type QueryDoc,
  type QueryFlow,
  type QueryResult,
  addBaseUrlToBlacklist,
  formatBytes,
  runQuery,
} from "../api"
import {
  Badge,
  Button,
  CopyUrlButton,
  EmptyState,
  ListBadge,
  PageHeader,
  RankedTable,
  SearchInput,
  Select,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { ListActionCell } from "./ListActionDropdown"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"

const DEFAULT_PAGE_SIZE = 25

const WINDOW_OPTIONS = [
  { value: "30", label: "Last 30 minutes" },
  { value: "60", label: "Last hour" },
  { value: "360", label: "Last 6 hours" },
  { value: "720", label: "Last 12 hours" },
  { value: "1440", label: "Last 24 hours" },
  { value: "2880", label: "Last 2 days" },
  { value: "4320", label: "Last 3 days" },
  { value: "10080", label: "Last 7 days" },
  { value: "20160", label: "Last 14 days" },
  { value: "43200", label: "Last 30 days" },
  { value: "0", label: "All time" },
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

/* ── De-boxed section: hairline + title + content (Query page) ──────── */

function QuerySection({
  title,
  icon: Icon,
  description,
  children,
}: {
  title: string
  icon?: LucideIcon
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t-[3px] border-[#0A0A0A] pt-4 dark:border-[#F6F2E8]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        <h3 className="font-mono text-xs font-extrabold uppercase tracking-widest">{title}</h3>
        {description && (
          <span className="ml-auto font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{description}</span>
        )}
      </div>
      {children}
    </section>
  )
}

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
} = {
  setResult: () => {},
}

/** Stable row identity for the query-results table + bulk actions. */
function queryRowId(d: QueryDoc): string {
  return `${d.timestamp}|${d.client_ip}|${d.url}`
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
        <CopyUrlButton value={d.client_ip} label="Client IP" />
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
        <CopyUrlButton value={d.server_ip} label="Server IP" />
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
        <CopyUrlButton value={d.url} label="URL" />
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
        <CopyUrlButton value={d.base_url} label="Base URL" />
      </span>
    ),
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
    id: "coverage",
    header: "Lists",
    enableSorting: false,
    cell: (d) => (
      <div className="flex flex-wrap items-center gap-1">
        {d.blocked_by.length > 0 && (
          <ListBadge
            tone="warning"
            icon={AlertTriangle}
            title={`Matched block pattern${d.blocked_by.length > 1 ? "s" : ""}: ${d.blocked_by.join(", ")}`}
          >
            block{d.blocked_by.length > 1 ? ` · ${d.blocked_by.length}` : ""}
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
        {d.blacklisted && (
          <ListBadge
            tone="danger"
            icon={CheckCircle2}
            title={
              d.blacklist_source === "ip"
                ? "IP address is on the blacklist"
                : "Host is on the blacklist"
            }
          >
            blacklist{d.blacklist_source === "ip" ? " · ip" : ""}
          </ListBadge>
        )}
        {d.blocked_by.length === 0 && !d.whitelisted && !d.blacklisted && (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </div>
    ),
    width: "w-44",
  },
  /* ── Rich flat proxy fields (logstash-proxy-* schema) ── */
  {
    id: "category",
    header: "Category",
    accessor: (d) => d.category,
    cell: (d) => <span className="font-mono text-xs text-muted-foreground">{d.category || "—"}</span>,
    width: "w-24",
  },
  {
    id: "method",
    header: "Method",
    accessor: (d) => d.http_method,
    cell: (d) => <span className="font-mono text-xs">{d.http_method || "—"}</span>,
    width: "w-20",
  },
  {
    id: "status",
    header: "Status",
    accessor: (d) => d.http_status_code,
    cell: (d) => <span className="font-mono text-xs tabular-nums">{d.http_status_code ?? "—"}</span>,
    width: "w-20",
    align: "right",
  },
  {
    id: "country",
    header: "Country",
    accessor: (d) => d.country_code,
    cell: (d) => <span className="font-mono text-xs">{d.country_code || "—"}</span>,
    width: "w-20",
  },
  {
    id: "bytes",
    header: "↓/↑ Bytes",
    accessor: (d) => (Number(d.bytes_downloaded) || 0) + (Number(d.bytes_uploaded) || 0),
    cell: (d) => {
      const dn = Number(d.bytes_downloaded) || 0
      const up = Number(d.bytes_uploaded) || 0
      if (!dn && !up) return <span className="text-xs text-muted-foreground">—</span>
      return (
        <span className="font-mono text-xs tabular-nums" title={`↓ ${dn.toLocaleString()} / ↑ ${up.toLocaleString()}`}>
          {formatBytes(dn + up)}
        </span>
      )
    },
    align: "right",
    width: "w-24",
  },
  {
    id: "rule",
    header: "Rule",
    accessor: (d) => d.rule_name ?? d.rule_info ?? "—",
    cell: (d) => {
      const rule = d.rule_name && d.rule_name !== "-" ? d.rule_name : d.rule_info
      return <span className="block max-w-[140px] truncate font-mono text-xs text-muted-foreground" title={rule}>{rule || "—"}</span>
    },
    width: "w-28",
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    cell: (d) => (
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

/* ── Flow: client IPs → destination host sankey ──────────────────────── */

function toSankey(flow: QueryFlow): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const nodes: SankeyNode[] = flow.nodes.map((n) => ({
    id: n.id,
    name: n.label,
    layer: n.kind === "ip" ? 0 : 1,
  }))
  const links: SankeyLink[] = flow.links.map((l) => ({
    source: l.source,
    target: l.target,
    value: Math.max(1, l.count),
  }))
  return { nodes, links }
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function QueryPage() {
  const { toast } = useToast()
  const { viewMode, setViewMode } = useFilter()
  const [windowMinutes, setWindowMinutes] = useState("60")
  const [whitelistMode, setWhitelistMode] = useState<"include" | "exclude">("include")
  const [blacklistMode, setBlacklistMode] = useState<"include" | "exclude">("exclude")
  const [actionFilter, setActionFilter] = useState<"all" | "ALLOW" | "DENY">("all")
  const [esSearch, setEsSearch] = useState("")
  const debouncedEsSearch = useDebounce(esSearch, 400)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Hand the stable setter to the module-scope QUERY_COLUMNS actions cell.
  queryUI.setResult = setResult
  const columns: DataTableColumn<QueryDoc>[] = QUERY_COLUMNS

  const fetchQuery = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const q = debouncedEsSearch.trim() || undefined
    runQuery(Number(windowMinutes), {
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
  }, [windowMinutes, whitelistMode, blacklistMode, debouncedEsSearch, viewMode])

  // Auto-run when the ES-level filter or whitelist mode changes.
  useEffect(() => fetchQuery(), [fetchQuery])

  const handleRun = () => fetchQuery()

  const flowSankey = useMemo(() => (result?.flow ? toSankey(result.flow) : null), [result])

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

  const esOffline = result !== null && !result.es_online

  // Single pass over the filtered rows for the footer counts (was three
  // separate .filter() sweeps on every render).
  const coverageCounts = useMemo(() => {
    let blocked = 0
    let whitelisted = 0
    let blacklisted = 0
    for (const d of actionFilteredItems) {
      if (d.blocked_by.length > 0) blocked++
      if (d.whitelisted) whitelisted++
      if (d.blacklisted) blacklisted++
    }
    return { blocked, whitelisted, blacklisted }
  }, [actionFilteredItems])

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Query"
        description="Live Elasticsearch queries against the block patterns — inspect raw matches, whitelisted and blacklisted coverage."
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
        <span className="text-xs text-muted-foreground">Window</span>
        <Select
          value={windowMinutes}
          onChange={setWindowMinutes}
          options={WINDOW_OPTIONS}
          className="w-44"
          aria-label="Query time window"
        />
        <Button onClick={handleRun} disabled={loading}>
          <Play className="h-4 w-4" />
          Run
        </Button>
        <Button variant="outline" size="sm" onClick={handleRun} disabled={loading}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </PageHeader>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Zap}
          label="Total requests"
          value={result ? result.total_requests.toLocaleString() : "—"}
          tone="info"
          hint={`Matching block patterns · ${result?.window_minutes === 0 ? "all-time" : `${result?.window_minutes ?? 60}m`} window`}
        />
        <StatCard
          icon={Users}
          label="Unique client IPs"
          value={result ? result.unique_ips.toLocaleString() : "—"}
          tone="default"
          hint="Distinct clients in window"
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
          <QuerySection title="Requests over time" icon={Network} description="Hover for details">
            {result.timeline.length > 0 ? (
              <TimelineChart points={result.timeline} />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No timestamped matches in this window
              </p>
            )}
          </QuerySection>

          {/* Top rankings */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <QuerySection title="Top URLs" icon={Globe}>
              <RankedTable rows={result.top_urls.map((u) => ({ label: u.url, count: u.count }))} />
            </QuerySection>
            <QuerySection title="Top client IPs" icon={Users}>
              <RankedTable rows={result.top_ips.map((u) => ({ label: u.client_ip, count: u.count }))} />
            </QuerySection>
          </div>

          {/* Flow visualization — cv-auto skips the sankey panel's paint
              until it's scrolled into view. */}
          <div className="cv-auto overflow-hidden border-[2.5px] border-[#0A0A0A] bg-card brutal-shadow-sm dark:border-[#F6F2E8]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b-[2.5px] border-[#0A0A0A] bg-muted/40 px-4 py-3 dark:border-[#F6F2E8]">
              <div>
                <h3 className="font-mono text-xs font-extrabold uppercase tracking-widest">Access flow</h3>
                <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  Client IPs clustered by destination host
                </p>
              </div>
              {flowSankey && flowSankey.links.length > 0 && (
                <span className="border-[2px] border-[#0A0A0A] bg-secondary px-2 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-widest text-[#0A0A0A] dark:border-[#F6F2E8]">
                  {flowSankey.links.length.toLocaleString()} flow{flowSankey.links.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {esOffline ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Flow unavailable — Elasticsearch unreachable.
              </p>
            ) : flowSankey && flowSankey.links.length > 0 ? (
              <div className="p-4 sm:p-6">
                <SankeyDiagram
                  nodes={flowSankey.nodes}
                  links={flowSankey.links}
                  layerColors={{
                    0: "var(--color-info)",
                    1: "var(--color-danger)",
                  }}
                  ariaLabel="Client IP to destination host flow"
                />
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No traffic in this window to visualize
              </p>
            )}
          </div>

          {/* Documents table */}
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b-[2.5px] border-[#0A0A0A] pb-3 dark:border-[#F6F2E8]">
              <div>
                <h3 className="font-mono text-xs font-extrabold uppercase tracking-widest">Matching documents</h3>
                <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  {actionFilteredItems.length.toLocaleString()}
                  {q ? ` of ${result.items.length.toLocaleString()}` : ""} matching doc
                  {actionFilteredItems.length === 1 ? "" : "s"} ·{" "}
                  <span className="text-warning">{coverageCounts.blocked} blocked</span>{" "}
                  ·{" "}
                  <span className="text-success">{coverageCounts.whitelisted} whitelisted</span>{" "}
                  ·{" "}
                  <span className="text-destructive">{coverageCounts.blacklisted} blacklisted</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  placeholder="Filter by IP or URL..."
                  value={docSearch}
                  onChange={setDocSearch}
                  className="w-64"
                  aria-label="Filter documents by IP or URL"
                />
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Server className="h-3.5 w-3.5" aria-hidden="true" />
                  {result.es_online ? "Elasticsearch online" : "Elasticsearch unreachable"}
                </span>
              </div>
            </div>

            {/* Badge legend */}
            <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-[2.5px] border-[#0A0A0A] bg-muted px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground brutal-shadow-sm dark:border-[#F6F2E8]">
              <span className="inline-flex items-center gap-1.5">
                <ListBadge tone="warning" icon={AlertTriangle}>
                  block
                </ListBadge>
                matched a block pattern (why it is flagged)
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
                host, base IP or client IP already blacklisted
              </span>
            </div>
            <DataTable
              columns={columns}
              data={actionFilteredItems}
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
              ariaLabel="Query results"
            />
          </div>
        </>
      )}
    </div>
  )
}
