import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  Link2,
  Network,
  RefreshCcw,
  SearchX,
  Server,
  Users,
  X,
} from "lucide-react"
import {
  type ClientBreakdown,
  type ClientUrlCount,
  type FindingsGraph,
  type GraphFlow,
  type GraphNode,
  getBlacklistSet,
  getClientBreakdown,
  getFindingsGraph,
  getTopClients,
  listPatterns,
  type Pattern,
  runClientQuery,
  type TopClient,
} from "../api"
import {
  Button,
  CopyUrlButton,
  EmptyState,
  ListBadge,
  PageHeader,
  Panel,
  RankedTable,
  RefreshIntervalSelect,
  SearchInput,
  Select,
  Skeleton,
  StatCard,
} from "./ui"
import { useAutoRefresh } from "../lib/utils"
import { DataTable, type DataTableColumn } from "./DataTable"
import { ListActionCell } from "./ListActionDropdown"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"
import { RadialDiagram } from "./RadialDiagram"

function formatDetected(ts: string) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

type Kind = GraphNode["kind"]

const LIMIT_OPTIONS = [
  { value: "15", label: "Top 15" },
  { value: "30", label: "Top 30" },
  { value: "50", label: "Top 50" },
  { value: "100", label: "Top 100" },
]

const SOURCE_OPTIONS = [
  { value: "findings", label: "Persisted findings" },
  { value: "es", label: "Live ES" },
]

const WINDOW_OPTIONS = [
  { value: "1440", label: "24h" },
  { value: "10080", label: "7d" },
  { value: "43200", label: "30d" },
  { value: "all", label: "All time" },
]

const CAP_OPTIONS = [
  { value: "6", label: "Top 6" },
  { value: "12", label: "Top 12" },
  { value: "24", label: "Top 24" },
]

/** Strip a URL down to its host (FQDN), e.g. "https://sub.example.com/path?x=1" → "sub.example.com". */
function hostOf(url: string): string {
  const afterScheme = url.split("://").pop() ?? url
  return afterScheme.split(/[/?#]/)[0] || url
}

/* Module-level handles to component state, synced each render, so the
 * flows-table columns stay referentially stable at module scope while the
 * URL cell still reads live whitelist/blacklist indexes. */
const GRAPH_UI: {
  whitelistIndex: Record<string, true>
  blacklistIndex: Record<string, true>
  onBlacklisted: (host: string) => void
} = {
  whitelistIndex: {},
  blacklistIndex: {},
  onBlacklisted: () => {},
}

/** Stable row identity for the access-flows table. */
function flowsRowId(f: GraphFlow): string {
  return `${f.client_ip}|${f.server_ip}|${f.url}|${f.base_url}`
}

/* Module-scope columns for the access-flows table — referentially stable so
 * DataTable never re-sorts/re-renders when GraphPage re-renders. */
const GRAPH_FLOWS_COLUMNS: DataTableColumn<GraphFlow>[] = [
  {
    id: "client_ip",
    header: "Client IP",
    accessor: (f) => f.client_ip,
    defaultSortDir: "asc",
    cell: (f) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs">{f.client_ip}</span>
        <CopyUrlButton value={f.client_ip} label="Client IP" />
      </span>
    ),
  },
  {
    id: "server_ip",
    header: "Server IP",
    accessor: (f) => f.server_ip,
    defaultSortDir: "asc",
    cell: (f) =>
      f.server_ip ? (
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">{f.server_ip}</span>
          <CopyUrlButton value={f.server_ip} label="Server IP" />
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/50">—</span>
      ),
  },
  {
    id: "url",
    header: "URL",
    accessor: (f) => f.url,
    defaultSortDir: "asc",
    cell: (f) => (
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block max-w-[420px] truncate font-mono text-xs" title={f.url}>
            {f.url}
          </span>
          <CopyUrlButton value={f.url} label="URL" />
        </span>
        {GRAPH_UI.whitelistIndex[f.base_url] ? (
          <ListBadge tone="success" icon={CheckCircle2} title="Already in whitelist">
            whitelist
          </ListBadge>
        ) : GRAPH_UI.blacklistIndex[f.base_url] ? (
          <ListBadge tone="danger" icon={CheckCircle2} title="In blacklist">
            blacklist
          </ListBadge>
        ) : null}
      </div>
    ),
  },
  {
    id: "count",
    header: "Accesses",
    accessor: (f) => f.count,
    defaultSortDir: "desc",
    cell: (f) => <span className="tabular-nums">{f.count.toLocaleString()}</span>,
    align: "right",
    width: "w-24",
  },
  {
    id: "last_seen",
    header: "Timestamp",
    accessor: (f) => f.last_seen,
    cell: (f) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatDetected(f.last_seen)}
      </span>
    ),
    width: "w-44",
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    cell: (f) => (
      <ListActionCell
        baseUrl={f.base_url}
        onBlacklisted={GRAPH_UI.onBlacklisted}
      />
    ),
    width: "w-12",
  },
]

/** Stable row identity for the per-client flows table. */
function clientUrlRowId(u: ClientUrlCount): string {
  return u.url
}

/* Module-scope columns for the focused per-client flows table — referentially
 * stable so DataTable never re-renders when GraphPage re-renders. */
const GRAPH_CLIENT_COLUMNS: DataTableColumn<ClientUrlCount>[] = [
  {
    id: "url",
    header: "URL",
    accessor: (u) => u.url,
    defaultSortDir: "asc",
    cell: (u) => (
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block max-w-[420px] truncate font-mono text-xs" title={u.url}>
            {u.url}
          </span>
          <CopyUrlButton value={u.url} label="URL" />
        </span>
        {GRAPH_UI.whitelistIndex[u.base_url] ? (
          <ListBadge tone="success" icon={CheckCircle2} title="Already in whitelist">
            whitelist
          </ListBadge>
        ) : GRAPH_UI.blacklistIndex[u.base_url] ? (
          <ListBadge tone="danger" icon={CheckCircle2} title="In blacklist">
            blacklist
          </ListBadge>
        ) : null}
      </div>
    ),
  },
  {
    id: "count",
    header: "Accesses",
    accessor: (u) => u.count,
    defaultSortDir: "desc",
    cell: (u) => <span className="tabular-nums">{u.count.toLocaleString()}</span>,
    align: "right",
    width: "w-24",
  },
  {
    id: "last_seen",
    header: "Last seen",
    accessor: (u) => u.last_seen,
    cell: (u) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatDetected(u.last_seen)}
      </span>
    ),
    width: "w-44",
  },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    cell: (u) => (
      <ListActionCell baseUrl={u.base_url} onBlacklisted={GRAPH_UI.onBlacklisted} />
    ),
    width: "w-12",
  },
]

function toSankey(graph: FindingsGraph): {
  nodes: SankeyNode[]
  links: SankeyLink[]
} {
  const layerOf = (id: string): number => {
    if (id.startsWith("ip:")) return 0
    if (id.startsWith("server:")) return 1
    return 2
  }

  // URLs are shown as host (FQDN) only, and every URL sharing a host merges
  // into a single node so the flow stays readable — the host appears once no
  // matter how many of its URLs are flagged. Full URLs are listed in the
  // tooltip and stay available in the Access flows table.
  const hosts = new Map<string, { id: string; host: string; urls: string[] }>()
  const urlNodeToHostId = new Map<string, string>()
  for (const n of graph.nodes) {
    if (n.kind !== "url") continue
    const host = hostOf(n.label)
    const hostId = `host:${host}`
    urlNodeToHostId.set(n.id, hostId)
    const h = hosts.get(host)
    if (h) h.urls.push(n.label)
    else hosts.set(host, { id: hostId, host, urls: [n.label] })
  }

  const nodes: SankeyNode[] = [
    ...graph.nodes
      .filter((n) => n.kind !== "url")
      .map((n) => ({
        id: n.id,
        name: n.label,
        layer: layerOf(n.id),
      })),
    ...[...hosts.values()].map((h) => ({
      id: h.id,
      name: h.host,
      layer: 2,
      // ECharts HTML tooltips need <br/> (a literal \n collapses to a space).
      detail:
        h.urls.length <= 4
          ? h.urls.join("<br/>")
          : [...h.urls.slice(0, 4), `… +${h.urls.length - 4} more`].join("<br/>"),
    })),
  ]

  // Rewrite url-node endpoints to their host node and merge parallel links.
  const linkByKey = new Map<string, SankeyLink>()
  for (const l of graph.links) {
    const source = urlNodeToHostId.get(l.source) ?? l.source
    const target = urlNodeToHostId.get(l.target) ?? l.target
    if (source === target) continue
    const key = `${source}|${target}`
    const prev = linkByKey.get(key)
    if (prev) prev.value += Math.max(1, l.count)
    else linkByKey.set(key, { source, target, value: Math.max(1, l.count) })
  }

  return { nodes, links: [...linkByKey.values()] }
}

export function GraphPage() {
  const [limit, setLimit] = useState("30")
  const [graph, setGraph] = useState<FindingsGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [whitelistIndex, setWhitelistIndex] = useState<Record<string, true>>({})
  const [blacklistIndex, setBlacklistIndex] = useState<Record<string, true>>({})

  // ── Drill-down state ────────────────────────────────────────────
  const [selectedClient, setSelectedClient] = useState<string | null>(null)
  const [source, setSource] = useState<"findings" | "es">("findings")
  const [windowMinutes, setWindowMinutes] = useState("all")
  const [cap, setCap] = useState("12")
  const [urlSearch, setUrlSearch] = useState("")
  const [urlFilter, setUrlFilter] = useState<string | null>(null)
  const [breakdown, setBreakdown] = useState<ClientBreakdown | null>(null)
  const [breakdownLoading, setBreakdownLoading] = useState(false)
  const [breakdownError, setBreakdownError] = useState<string | null>(null)
  const [topClients, setTopClients] = useState<TopClient[]>([])
  const [pickerQuery, setPickerQuery] = useState("")

  // Sync live state into the module-scope flows-table column handles.
  GRAPH_UI.whitelistIndex = whitelistIndex
  GRAPH_UI.blacklistIndex = blacklistIndex
  GRAPH_UI.onBlacklisted = (host) =>
    setBlacklistIndex((prev) => ({ ...prev, [host]: true }))

  // Keep the previous graph visible while an auto-refresh is in flight so
  // the page doesn't flicker back to skeletons every interval.
  const graphRef = useRef<FindingsGraph | null>(null)
  graphRef.current = graph

  // The auto-refresh tick reads the *current* selection through a ref so the
  // interval closure never goes stale across client changes.
  const selectedClientRef = useRef<string | null>(null)
  selectedClientRef.current = selectedClient

  const fetchGraph = useCallback(() => {
    let cancelled = false
    if (!graphRef.current) setLoading(true)
    setError(null)
    getFindingsGraph(Number(limit))
      .then((g) => {
        if (!cancelled) setGraph(g)
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message)
          setGraph(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [limit])

  useEffect(() => fetchGraph(), [fetchGraph])

  const fetchTopClients = useCallback((query: string) => {
    let cancelled = false
    getTopClients({ search: query.trim() || undefined, limit: 50 })
      .then((data) => {
        if (!cancelled) setTopClients(data.items)
      })
      .catch(() => {
        if (!cancelled) setTopClients([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced picker search — refetch the candidate list as the user types.
  useEffect(() => {
    const id = window.setTimeout(() => fetchTopClients(pickerQuery), 250)
    return () => window.clearTimeout(id)
  }, [pickerQuery, fetchTopClients])

  const fetchBreakdown = useCallback(() => {
    const ip = selectedClientRef.current
    if (!ip) return
    let cancelled = false
    setBreakdownLoading(true)
    setBreakdownError(null)
    const opts = {
      minutes: windowMinutes === "all" ? undefined : Number(windowMinutes),
      search: urlSearch.trim() || undefined,
      limit: Number(cap),
    }
    const call =
      source === "findings"
        ? getClientBreakdown(ip, opts)
        : runClientQuery(ip, opts)
    call
      .then((b) => {
        if (!cancelled) setBreakdown(b)
      })
      .catch((e) => {
        if (!cancelled) {
          setBreakdownError((e as Error).message)
          setBreakdown(null)
        }
      })
      .finally(() => {
        if (!cancelled) setBreakdownLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source, windowMinutes, urlSearch, cap])

  useEffect(() => fetchBreakdown(), [fetchBreakdown])

  // Live updates: refetch whichever view is active (aggregate graph or the
  // focused per-client breakdown) on an interval.
  const refreshActive = useCallback(() => {
    if (selectedClientRef.current) fetchBreakdown()
    else fetchGraph()
  }, [fetchBreakdown, fetchGraph])
  const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refreshActive, "graph", 0)

  const selectClient = useCallback((ip: string) => {
    setSelectedClient(ip)
    setPickerQuery("")
    setUrlFilter(null)
  }, [])

  const clearClient = useCallback(() => {
    setSelectedClient(null)
    setUrlFilter(null)
  }, [])

  // Load whitelist patterns and blacklist set for badge indicators.
  useEffect(() => {
    let cancelled = false
    listPatterns({ pattern_type: "whitelist", limit: 5000 })
      .then((items: Pattern[]) => {
        if (cancelled) return
        const next: Record<string, true> = {}
        for (const p of items) next[p.pattern] = true
        setWhitelistIndex(next)
      })
      .catch(() => {
        if (!cancelled) setWhitelistIndex({})
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    getBlacklistSet()
      .then((data) => {
        if (cancelled) return
        const next: Record<string, true> = {}
        for (const url of data.urls) next[url] = true
        for (const ip of data.ips) next[ip] = true
        setBlacklistIndex(next)
      })
      .catch(() => {
        if (!cancelled) setBlacklistIndex({})
      })
    return () => { cancelled = true }
  }, [])

  const nodeKindCounts = useMemo(() => {
    const c: Record<Kind, number> = { ip: 0, server: 0, url: 0 }
    for (const n of graph?.nodes ?? []) c[n.kind] += 1
    return c
  }, [graph])

  // Ranked lists for the Top URLs / Top client IPs tables, derived from
  // the same nodes the sankey renders.
  const topRanked = useMemo(() => {
    const urls: { label: string; count: number }[] = []
    const ips: { label: string; count: number }[] = []
    for (const n of graph?.nodes ?? []) {
      if (n.kind === "url") urls.push({ label: n.label, count: n.count })
      else if (n.kind === "ip") ips.push({ label: n.label, count: n.count })
    }
    const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count
    urls.sort(byCount)
    ips.sort(byCount)
    return { urls, ips }
  }, [graph])

  const sankey = useMemo(() => (graph ? toSankey(graph) : null), [graph])

  const graphEmpty = !loading && !error && (!graph || graph.nodes.length === 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Traffic"
        description="Flow of flagged URLs being accessed by client IPs (from persisted findings)"
      >
        <Select
          value={limit}
          onChange={setLimit}
          options={LIMIT_OPTIONS}
          className="w-32"
          aria-label="Nodes per layer"
        />
        <RefreshIntervalSelect value={refreshSeconds} onChange={setRefreshSeconds} />
        <Button variant="outline" size="sm" onClick={fetchGraph} disabled={loading}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </PageHeader>

      {selectedClient ? (
        /* ── Focused drill-down mode ─────────────────────────────── */
        <>
          {/* Drill-down bar */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
                <span className="font-mono text-sm font-semibold">{selectedClient}</span>
                {breakdown && (
                  <span className="text-xs text-muted-foreground">
                    {breakdown.total_accesses.toLocaleString()} accesses
                  </span>
                )}
                <button
                  type="button"
                  onClick={clearClient}
                  aria-label="Clear client drill-down"
                  className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
              <Select
                value={source}
                onChange={(v) => setSource(v as "findings" | "es")}
                options={SOURCE_OPTIONS}
                className="w-40"
                aria-label="Data source"
              />
              <Select
                value={windowMinutes}
                onChange={setWindowMinutes}
                options={WINDOW_OPTIONS}
                className="w-28"
                aria-label="Time window"
              />
              <Select
                value={cap}
                onChange={setCap}
                options={CAP_OPTIONS}
                className="w-28"
                aria-label="Top URLs"
              />
              <SearchInput
                value={urlSearch}
                onChange={setUrlSearch}
                placeholder="Filter URL…"
                className="w-48"
                aria-label="Filter by URL substring"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={fetchBreakdown}
                disabled={breakdownLoading}
              >
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
            {breakdown && !breakdown.es_online && (
              <p className="mt-2 text-xs text-destructive">
                Live ES source unavailable — showing last known data.
              </p>
            )}
            {urlFilter && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Filtered to:</span>
                <span className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs">
                  {urlFilter}
                  <button
                    type="button"
                    onClick={() => setUrlFilter(null)}
                    aria-label="Clear URL filter"
                    className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
            )}
          </div>

          {/* Radial visualization */}
          <div className="cv-auto overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold tracking-tight">URL access radial</h3>
              <p className="text-xs text-muted-foreground">
                Hover a URL to highlight its connection; click to filter the table.
              </p>
            </div>
            {breakdownLoading && !breakdown ? (
              <div className="space-y-3 p-4" aria-busy="true">
                <Skeleton className="h-[540px] w-full rounded-lg" />
              </div>
            ) : breakdownError ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
                <SearchX className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm font-medium text-destructive">{breakdownError}</p>
                <Button variant="outline" size="sm" onClick={fetchBreakdown}>
                  Try again
                </Button>
              </div>
            ) : breakdown && breakdown.urls.length > 0 ? (
              <div className="p-4 sm:p-6">
                <RadialDiagram
                  clientIp={breakdown.client_ip}
                  totalAccesses={breakdown.total_accesses}
                  urls={breakdown.urls}
                  onSelectUrl={setUrlFilter}
                  ariaLabel={`URL access radial for ${breakdown.client_ip}`}
                />
              </div>
            ) : (
              <EmptyState
                icon={Network}
                title="No URLs for this client"
                description={
                  breakdown && !breakdown.es_online
                    ? "Live ES is unreachable — no data to graph."
                    : "No flagged URLs match the current filters in this window."
                }
              />
            )}
          </div>

          {/* Per-client flows table */}
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">Access flows</h3>
                <p className="text-xs text-muted-foreground">
                  URLs accessed by {selectedClient}
                  {urlFilter ? ` — filtered to ${urlFilter}` : ""}
                </p>
              </div>
            </div>
            {breakdownLoading && !breakdown ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-48 w-full rounded-lg" />
              </div>
            ) : breakdown && breakdown.urls.length > 0 ? (
              <DataTable
                columns={GRAPH_CLIENT_COLUMNS}
                data={
                  urlFilter
                    ? breakdown.urls.filter((u) => u.url === urlFilter)
                    : breakdown.urls
                }
                rowId={clientUrlRowId}
                internalPagination
                defaultSortBy="count"
                defaultSortDir="desc"
                ariaLabel="Per-client access flows"
              />
            ) : (
              <EmptyState
                icon={Network}
                title="No access flows"
                description="Per-client URL flows appear here once the radial has data."
              />
            )}
          </div>
        </>
      ) : (
        /* ── Aggregate mode (existing view + drill-down picker) ── */
        <>
      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Network}
          label="Access flows"
          value={(graph?.links.length ?? 0).toLocaleString()}
          tone="info"
          hint="Client → server → URL edges"
        />
        <StatCard
          icon={Users}
          label="Client IPs"
          value={nodeKindCounts.ip.toLocaleString()}
          tone="default"
          hint="Unique clients in window"
        />
        <StatCard
          icon={Server}
          label="Server IPs"
          value={nodeKindCounts.server.toLocaleString()}
          tone="warning"
          hint="Unique servers in window"
        />
        <StatCard
          icon={Link2}
          label="Flagged URLs"
          value={nodeKindCounts.url.toLocaleString()}
          tone="danger"
          hint="URLs matching blocked patterns"
        />
      </div>

      {/* Drill-down picker */}
      <Panel title="Client drill-down" icon={Users}>
        <p className="mb-3 text-xs text-muted-foreground">
          Pick a client IP to see exactly which URLs it accessed, and how often.
        </p>
        <SearchInput
          value={pickerQuery}
          onChange={setPickerQuery}
          placeholder="Search client IP…"
          className="w-full"
          aria-label="Search client IP"
        />
        {pickerQuery.trim() && topClients.length > 0 && (
          <ul className="mt-2 max-h-56 divide-y divide-border overflow-auto rounded-md border border-border bg-popover">
            {topClients.slice(0, 8).map((t) => (
              <li key={t.client_ip}>
                <button
                  type="button"
                  onClick={() => selectClient(t.client_ip)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono">{t.client_ip}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {t.count.toLocaleString()} accesses
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Visualization: alluvial flow — cv-auto skips the (potentially
          large) sankey panel's paint until it's scrolled into view. */}
      <div className="cv-auto overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Traffic flow</h3>
            <p className="text-xs text-muted-foreground">
              Client IPs → server IPs → flagged URLs. Hover a node to highlight its connections.
            </p>
          </div>
          {graph && !graphEmpty && (
            <span className="text-xs text-muted-foreground">
              {graph.links.length.toLocaleString()} access flow{graph.links.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {loading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
            <SearchX className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchGraph}>
              Try again
            </Button>
          </div>
        ) : graphEmpty ? (
          <EmptyState
            icon={Network}
            title="No traffic to graph"
            description="Findings appear here once the ES poll detects matching log entries. The graph maps which client IPs are hitting which flagged URLs."
            action={
              <Button variant="outline" onClick={fetchGraph}>
                Refresh
              </Button>
            }
            className="border-0"
          />
        ) : sankey ? (
          <div className="p-4 sm:p-6">
            <SankeyDiagram
              nodes={sankey.nodes}
              links={sankey.links}
              layerColors={{
                0: "var(--color-info)",
                1: "var(--color-warning)",
                2: "var(--color-danger)",
              }}
              ariaLabel="Client to server to URL alluvial flow"
            />
          </div>
        ) : null}
      </div>

      {/* Top rankings — top 10, matching the Query page ranking panels */}
      {graph && graph.nodes.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Top URLs" icon={Link2}>
            <RankedTable rows={topRanked.urls.slice(0, 10)} />
          </Panel>
          <Panel title="Top client IPs" icon={Users}>
            <RankedTable rows={topRanked.ips.slice(0, 10)} onRowClick={selectClient} />
          </Panel>
        </div>
      )}

      {/* Per-triple access flows table */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Access flows</h3>
            <p className="text-xs text-muted-foreground">
              Client → server → URL triples for the flagged URLs shown above
            </p>
          </div>
        </div>
        {loading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : graph && graph.flows.length > 0 ? (
          <DataTable
            columns={GRAPH_FLOWS_COLUMNS}
            data={graph.flows}
            rowId={flowsRowId}
            internalPagination
            defaultSortBy="count"
            defaultSortDir="desc"
            ariaLabel="Access flows"
          />
        ) : (
          <EmptyState
            icon={Network}
            title="No access flows"
            description="Per-triple flows appear here once the graph has traffic data."
          />
        )}
      </div>
      </>
      )}
    </div>
  )
}
