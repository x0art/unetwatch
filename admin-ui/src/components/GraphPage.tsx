import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Link2,
  MousePointerClick,
  Network,
  RefreshCcw,
  SearchX,
  Server,
  Users,
} from "lucide-react"
import {
  type FindingsGraph,
  type GraphNode,
  getFindingsGraph,
} from "../api"
import {
  Button,
  CopyUrlButton,
  EmptyState,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  StatCard,
} from "./ui"
import { DataTable } from "./DataTable"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"
import { useDebounce } from "../lib/utils"

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

/** Strip a URL down to its host (FQDN), e.g. "https://sub.example.com/path?x=1" → "sub.example.com". */
function hostOf(url: string): string {
  const afterScheme = url.split("://").pop() ?? url
  return afterScheme.split(/[/?#]/)[0] || url
}

/** Sankey node with the search terms used by the highlight filter (host + full URLs). */
type FlowNode = SankeyNode & { searchable?: string[] }

function toSankey(graph: FindingsGraph): {
  nodes: FlowNode[]
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

  const nodes: FlowNode[] = [
    ...graph.nodes
      .filter((n) => n.kind !== "url")
      .map((n) => ({
        id: n.id,
        name: n.label,
        layer: layerOf(n.id),
        searchable: [n.label],
      })),
    ...[...hosts.values()].map((h) => ({
      id: h.id,
      name: h.host,
      layer: 2,
      searchable: [h.host, ...h.urls],
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
  const [search, setSearch] = useState("")

  const fetchGraph = useCallback(() => {
    let cancelled = false
    setLoading(true)
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

  const nodeKindCounts = useMemo(() => {
    const c: Record<Kind, number> = { ip: 0, server: 0, url: 0 }
    for (const n of graph?.nodes ?? []) c[n.kind] += 1
    return c
  }, [graph])

  const debouncedSearch = useDebounce(search, 200)
  const q = debouncedSearch.trim().toLowerCase()

  const sankey = useMemo(() => (graph ? toSankey(graph) : null), [graph])

  // Count of diagram nodes the search will highlight (host nodes match when
  // the host or any of their URLs contain the query).
  const matchCount = useMemo(
    () =>
      q && sankey
        ? sankey.nodes.filter((n) =>
            (n.searchable ?? [n.name]).some((s) => s.toLowerCase().includes(q)),
          ).length
        : 0,
    [q, sankey],
  )

  // Search-scoped data: filter the diagram to matching nodes + their edges.
  // Aggregated host nodes match when the host or any of their URLs match.
  const visibleSankey = useMemo(() => {
    if (!sankey || !q) return sankey
    const keep = new Set<string>()
    for (const n of sankey.nodes) {
      const searchable = n.searchable ?? [n.name]
      if (searchable.some((s) => s.toLowerCase().includes(q))) {
        keep.add(n.id)
        for (const l of sankey.links) {
          if (l.source === n.id) keep.add(l.target)
          if (l.target === n.id) keep.add(l.source)
        }
      }
    }
    return {
      nodes: sankey.nodes.filter((n) => keep.has(n.id)),
      links: sankey.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
    }
  }, [sankey, q])

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
        <Button variant="outline" size="sm" onClick={fetchGraph} disabled={loading}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </PageHeader>

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

      {/* Visualization: alluvial flow */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Traffic relations</h3>
            <p className="text-xs text-muted-foreground">
              Alluvial flow of client IPs reaching flagged URLs through server IPs. Flagged URLs
              are grouped by host so each appears once. Hover a node to highlight its connections ·
              scroll to zoom.
            </p>
          </div>
          {graph && !graphEmpty && (
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                placeholder="Highlight by IP or URL..."
                value={search}
                onChange={setSearch}
                className="w-52 [&_input]:h-9"
                aria-label="Highlight graph nodes"
              />
              {q.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-2.5 py-0.5 text-[11px] font-semibold text-info">
                  {matchCount} match{matchCount === 1 ? "" : "es"}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
                <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
                Hover to trace a flow
              </span>
            </div>
          )}
        </div>

        {/* Legend strip */}
        {graph && !graphEmpty && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-info" aria-hidden="true" />
              {nodeKindCounts.ip.toLocaleString()} client IP{nodeKindCounts.ip === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-warning" aria-hidden="true" />
              {nodeKindCounts.server.toLocaleString()} server IP
              {nodeKindCounts.server === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true" />
              {nodeKindCounts.url.toLocaleString()} URL{nodeKindCounts.url === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Network className="h-3.5 w-3.5" aria-hidden="true" />
              {graph.links.length.toLocaleString()} access flow
              {graph.links.length === 1 ? "" : "s"}
            </span>
          </div>
        )}

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
        ) : visibleSankey ? (
          <div className="p-3">
            <SankeyDiagram
              nodes={visibleSankey.nodes}
              links={visibleSankey.links}
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
            columns={[
              {
                id: "client_ip",
                header: "Client IP",
                accessor: (f) => f.client_ip,
                defaultSortDir: "asc",
                cell: (f) => <span className="font-mono text-xs">{f.client_ip}</span>,
              },
              {
                id: "server_ip",
                header: "Server IP",
                accessor: (f) => f.server_ip,
                defaultSortDir: "asc",
                cell: (f) =>
                  f.server_ip ? (
                    <span className="font-mono text-xs text-muted-foreground">{f.server_ip}</span>
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
                  <span className="flex items-center gap-1.5">
                    <span className="block max-w-[420px] truncate font-mono text-xs" title={f.url}>
                      {f.url}
                    </span>
                    <CopyUrlButton value={f.url} label="URL" />
                  </span>
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
            ]}
            data={graph.flows}
            rowId={(f) => `${f.client_ip}|${f.server_ip}|${f.url}|${f.base_url}`}
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
    </div>
  )
}
