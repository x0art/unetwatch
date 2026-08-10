import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Ban,
  Copy,
  Database,
  FileSearch,
  Globe,
  Network,
  Play,
  RefreshCcw,
  SearchX,
  Server,
  Users,
  Zap,
} from "lucide-react"
import { useDebounce } from "../lib/utils"
import {
  type QueryDoc,
  type QueryFlow,
  type QueryResult,
  addBaseUrlToBlacklist,
  runQuery,
} from "../api"
import {
  Badge,
  Button,
  CopyUrlButton,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  Select,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"

const PAGE_SIZE = 25

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
]

const WHITELIST_OPTIONS = [
  { value: "include", label: "Include whitelisted" },
  { value: "exclude", label: "Exclude whitelisted" },
]

const ACTION_FILTER_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "ALLOW", label: "ALLOW" },
  { value: "DENY", label: "DENY" },
]

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

/* ── Timeline area chart (pure SVG) ─────────────────────────────────── */

function TimelineChart({ points }: { points: { bucket: string; count: number }[] }) {
  const W = 720
  const H = 210
  const PAD = { l: 42, r: 14, t: 14, b: 26 }
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const max = Math.max(1, ...points.map((p) => p.count))
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const x = (i: number) =>
    PAD.l + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const y = (c: number) => PAD.t + innerH - (c / max) * innerH

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.count).toFixed(1)}`)
    .join(" ")
  const areaPath = `${linePath} L ${x(points.length - 1).toFixed(1)} ${PAD.t + innerH} L ${x(0).toFixed(1)} ${PAD.t + innerH} Z`

  const gridLines = [0, 0.5, 1].map((f) => ({
    y: y(max * f),
    label: Math.round(max * f).toLocaleString(),
  }))
  const xLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1]

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const ratio = (px - PAD.l) / innerW
    const i = Math.round(ratio * (points.length - 1))
    setHover(Math.min(points.length - 1, Math.max(0, i)))
  }

  const hoverPoint = hover !== null ? points[hover] : null

  return (
    <div ref={wrapRef} className="relative w-full" onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
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

        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={g.y}
              y2={g.y}
              className="stroke-border/60"
              strokeDasharray={i === 0 ? undefined : "3 3"}
            />
            <text x={PAD.l - 6} y={g.y + 3} textAnchor="end" fontSize={9} className="fill-muted-foreground">
              {g.label}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#timeline-fill)" />
        <path d={linePath} fill="none" stroke="var(--color-primary)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />

        {xLabels.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 6}
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
              x1={x(hover ?? 0)}
              x2={x(hover ?? 0)}
              y1={PAD.t}
              y2={PAD.t + innerH}
              className="stroke-muted-foreground/50"
              strokeDasharray="3 3"
            />
            <circle cx={x(hover ?? 0)} cy={y(hoverPoint.count)} r={3.5} className="fill-primary stroke-background" strokeWidth={2} />
          </g>
        )}
      </svg>

      {hoverPoint && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: `${(x(hover) / W) * 100}%`, top: 0 }}
        >
          <p className="font-semibold tabular-nums">{hoverPoint.count.toLocaleString()} req</p>
          <p className="text-muted-foreground">{formatFull(hoverPoint.bucket)}</p>
        </div>
      )}
    </div>
  )
}

/* ── Horizontal ranking bars (top URLs / top IPs) ───────────────────── */

function RankBars({ rows }: { rows: { label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data in window</p>
  }
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} title={`${r.label} — ${r.count.toLocaleString()} requests`}>
          <div className="mb-0.5 flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-mono text-muted-foreground">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {r.count.toLocaleString()}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70 transition-[width] duration-500"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
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
  const [windowMinutes, setWindowMinutes] = useState("60")
  const [whitelistMode, setWhitelistMode] = useState<"include" | "exclude">("include")
  const [actionFilter, setActionFilter] = useState<"all" | "ALLOW" | "DENY">("all")
  const [esSearch, setEsSearch] = useState("")
  const debouncedEsSearch = useDebounce(esSearch, 400)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchQuery = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const q = debouncedEsSearch.trim() || undefined
    runQuery(Number(windowMinutes), {
      q,
      excludeWhitelist: whitelistMode === "exclude",
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
  }, [windowMinutes, whitelistMode, debouncedEsSearch])

  // Auto-run when the ES-level filter or whitelist mode changes.
  useEffect(() => fetchQuery(), [fetchQuery])

  const handleRun = () => fetchQuery()

  const flowSankey = useMemo(() => (result?.flow ? toSankey(result.flow) : null), [result])

  const rowId = useCallback((d: QueryDoc) => `${d.timestamp}|${d.client_ip}|${d.url}`, [])

  const handleBulkBlacklist = async (ids: Set<string | number>) => {
    const rows = (result?.items ?? []).filter((d) => ids.has(rowId(d)))
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
    const rows = (result?.items ?? []).filter((d) => ids.has(rowId(d)))
    const urls = [...new Set(rows.map((r) => r.url).filter(Boolean))]
    if (!urls.length) return
    try {
      await navigator.clipboard.writeText(urls.join("\n"))
      toast({ title: `${urls.length} URL${urls.length === 1 ? "" : "s"} copied`, variant: "success" })
    } catch (e) {
      toast({ title: "Copy failed", description: (e as Error).message, variant: "error" })
    }
  }

  const columns: DataTableColumn<QueryDoc>[] = [
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
      cell: (d) => <span className="font-mono text-xs">{d.client_ip}</span>,
    },
    {
      id: "server_ip",
      header: "Server IP",
      accessor: (d) => d.server_ip,
      defaultSortDir: "asc",
      cell: (d) => <span className="font-mono text-xs text-muted-foreground">{d.server_ip}</span>,
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
            <span
              title={`Matched block pattern${d.blocked_by.length > 1 ? "s" : ""}: ${d.blocked_by.join(", ")}`}
            >
              <Badge variant="warning">
                block{d.blocked_by.length > 1 ? ` · ${d.blocked_by.length}` : ""}
              </Badge>
            </span>
          )}
          {d.whitelisted && (
            <span title="URL matches a whitelist pattern — excluded from findings">
              <Badge variant="success">whitelist</Badge>
            </span>
          )}
          {d.blacklisted && (
            <span
              title={
                d.blacklist_source === "ip"
                  ? "Client IP is on the blacklist"
                  : "Host is on the blacklist"
              }
            >
              <Badge variant="destructive">
                blacklist{d.blacklist_source === "ip" ? " · ip" : ""}
              </Badge>
            </span>
          )}
          {d.blocked_by.length === 0 && !d.whitelisted && !d.blacklisted && (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
        </div>
      ),
      width: "w-44",
    },
  ]

  const [page, setPage] = useState(0)
  const [docSearch, setDocSearch] = useState("")
  const debouncedDocSearch = useDebounce(docSearch, 200)
  const q = debouncedDocSearch.trim().toLowerCase()

  // Reset to the first page whenever a new query result, search, or action filter arrives.
  useEffect(() => {
    setPage(0)
  }, [result, debouncedDocSearch, actionFilter])

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
          value={actionFilter}
          onChange={(v) => setActionFilter(v as "all" | "ALLOW" | "DENY")}
          options={ACTION_FILTER_OPTIONS}
          className="w-40"
          aria-label="Filter by action"
        />
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
          hint={`Matching block patterns · ${result?.window_minutes ?? 60}m window`}
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
          <Skeleton className="h-40 w-full rounded-lg" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Skeleton className="h-56 w-full rounded-lg" />
            <Skeleton className="h-56 w-full rounded-lg" />
            <Skeleton className="h-56 w-full rounded-lg" />
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
          <Panel title="Requests over time" icon={Network} description="Hover for details">
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
              <RankBars rows={result.top_urls.map((u) => ({ label: u.url, count: u.count }))} />
            </Panel>
            <Panel title="Top client IPs" icon={Users}>
              <RankBars rows={result.top_ips.map((u) => ({ label: u.client_ip, count: u.count }))} />
            </Panel>
          </div>

          {/* Flow visualization */}
          <Panel
            title="Access flow"
            icon={FileSearch}
            description="Client IPs clustered by destination host"
          >
            {esOffline ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Flow unavailable — Elasticsearch unreachable.
              </p>
            ) : flowSankey && flowSankey.links.length > 0 ? (
              <SankeyDiagram
                nodes={flowSankey.nodes}
                links={flowSankey.links}
                layerColors={{
                  0: "var(--color-info)",
                  1: "var(--color-danger)",
                }}
                ariaLabel="Client IP to destination host flow"
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No traffic in this window to visualize
              </p>
            )}
          </Panel>

          {/* Documents table */}
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">Matching documents</h3>
                <p className="text-xs text-muted-foreground">
                  {actionFilteredItems.length.toLocaleString()}
                  {q ? ` of ${result.items.length.toLocaleString()}` : ""} matching doc
                  {actionFilteredItems.length === 1 ? "" : "s"} ·{" "}
                  <span className="text-warning">
                    {actionFilteredItems.filter((d) => d.blocked_by.length > 0).length} blocked
                  </span>{" "}
                  ·{" "}
                  <span className="text-success">
                    {actionFilteredItems.filter((d) => d.whitelisted).length} whitelisted
                  </span>{" "}
                  ·{" "}
                  <span className="text-destructive">
                    {actionFilteredItems.filter((d) => d.blacklisted).length} blacklisted
                  </span>
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
            <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Badge variant="warning">block</Badge>
                matched a block pattern (why it is flagged)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Badge variant="success">whitelist</Badge>
                matches a whitelist pattern — excluded from findings
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Badge variant="destructive">blacklist</Badge>
                host or client IP already blacklisted
              </span>
            </div>
            <DataTable
              columns={columns}
              data={actionFilteredItems}
              rowId={rowId}
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
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              ariaLabel="Query results"
            />
          </div>
        </>
      )}
    </div>
  )
}
