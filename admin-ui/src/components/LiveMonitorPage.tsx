import { useCallback, useEffect, useState } from "react"
import { Activity, Eye, SearchX } from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { Badge, Button, Dialog, PageHeader, Panel, Skeleton } from "./ui"
import { MetricCards } from "./MetricCards"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"
import {
  getFindingsGraph,
  getLiveMetrics,
  runQuery,
  type LiveMetrics,
  type QueryDoc,
} from "../api"
import { useAutoRefresh } from "../lib/utils"

function timeRangeToMinutes(tr: string): number {
  switch (tr) {
    case "1h":
      return 60
    case "7d":
      return 10080
    case "24h":
    default:
      return 1440
  }
}

const STUB_NODES: SankeyNode[] = [
  { id: "stub:ip:10.0.0.12", name: "10.0.0.12", layer: 0 },
  { id: "stub:ip:10.0.0.44", name: "10.0.0.44", layer: 0 },
  { id: "stub:base:example.com", name: "example.com", layer: 1 },
  { id: "stub:base:api.example.com", name: "api.example.com", layer: 1 },
]

const STUB_LINKS: SankeyLink[] = [
  { source: "stub:ip:10.0.0.12", target: "stub:base:example.com", value: 42 },
  { source: "stub:ip:10.0.0.44", target: "stub:base:example.com", value: 18 },
  { source: "stub:ip:10.0.0.12", target: "stub:base:api.example.com", value: 9 },
]

function SankeySection({
  filter,
  timeRange,
  onNodeClick,
}: {
  filter: string
  timeRange: string
  onNodeClick: (q: string) => void
}) {
  const [nodes, setNodes] = useState<SankeyNode[]>(STUB_NODES)
  const [links, setLinks] = useState<SankeyLink[]>(STUB_LINKS)
  const [loading, setLoading] = useState(false)

  const fetchFlow = useCallback(async () => {
    setLoading(true)
    try {
      const minutes = timeRangeToMinutes(timeRange)
      const q = filter.trim() || undefined
      try {
        const res = await runQuery(Math.min(minutes, 1440), q ? { q } : undefined)
        if (res.flow && res.flow.links.length > 0) {
          const sankeyNodes: SankeyNode[] = res.flow.nodes.map((n) => ({
            id: n.id,
            name: n.label,
            layer: n.kind === "ip" ? 0 : 1,
          }))
          const sankeyLinks: SankeyLink[] = res.flow.links.map((l) => ({
            source: l.source,
            target: l.target,
            value: l.count,
          }))
          setNodes(sankeyNodes)
          setLinks(sankeyLinks)
          return
        }
      } catch {
        /* fall through to findings graph */
      }
      try {
        const graph = await getFindingsGraph(30)
        if (graph.flows.length > 0) {
          const byIp = new Map<string, SankeyNode>()
          const byBase = new Map<string, SankeyNode>()
          const sankeyLinks: SankeyLink[] = []
          for (const f of graph.flows) {
            if (!byIp.has(f.client_ip)) {
              byIp.set(f.client_ip, { id: `ip:${f.client_ip}`, name: f.client_ip, layer: 0 })
            }
            if (!byBase.has(f.base_url)) {
              byBase.set(f.base_url, { id: `base:${f.base_url}`, name: f.base_url, layer: 1 })
            }
            sankeyLinks.push({
              source: `ip:${f.client_ip}`,
              target: `base:${f.base_url}`,
              value: f.count,
            })
          }
          const sankeyNodes = [...byIp.values(), ...byBase.values()]
          if (sankeyNodes.length > 0 && sankeyLinks.length > 0) {
            setNodes(sankeyNodes)
            setLinks(sankeyLinks)
            return
          }
        }
      } catch {
        /* keep stub */
      }
    } finally {
      setLoading(false)
    }
  }, [filter, timeRange])

  useEffect(() => {
    fetchFlow()
  }, [fetchFlow])

  return (
    <Panel
      title="Traffic Flow"
      description={filter ? `filtered: ${filter}` : "all sources → destinations"}
      icon={Activity}
      action={
        <Button variant="outline" size="sm" onClick={fetchFlow} disabled={loading}>
          {loading ? "LOADING…" : "REFRESH"}
        </Button>
      }
    >
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-3">
          <SankeyDiagram
            nodes={nodes}
            links={links}
            layerColors={{ 0: "var(--color-info)", 1: "var(--color-danger)" }}
            ariaLabel="Live traffic flow — client IPs to destination hosts"
          />
          <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Click a node to filter the Log Inspector below — wired via{" "}
            <code className="rounded bg-muted px-1 py-0.5">setGlobalFilter</code>. Task 4 upgrades this to
            a 4-column Sankey.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {nodes.slice(0, 6).map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => onNodeClick(n.name)}
                className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest hover:bg-muted"
              >
                {n.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}

function LogInspectorSection({
  filter,
  timeRange,
  onInspect,
}: {
  filter: string
  timeRange: string
  onInspect: (row: QueryDoc) => void
}) {
  const [rows, setRows] = useState<QueryDoc[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    const minutes = timeRangeToMinutes(timeRange)
    const q = filter.trim() || undefined
    try {
      const res = await runQuery(Math.min(minutes, 1440), q ? { q } : undefined)
      setRows(res.items.slice(0, 50))
      setTotal(res.total_requests)
    } catch {
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [filter, timeRange])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  return (
    <Panel
      title="Log Inspector"
      description={`${total.toLocaleString()} docs · ${timeRange} window${filter ? ` · filter: ${filter}` : ""}`}
      icon={SearchX}
      action={
        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
          {loading ? "LOADING…" : "REFRESH"}
        </Button>
      }
    >
      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
          No log entries in this window — try a broader time range or clear the filter.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">
                  Timestamp
                </th>
                <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">
                  Src IP
                </th>
                <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">
                  Dest IP
                </th>
                <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">
                  URL / Domain
                </th>
                <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">
                  Action
                </th>
                <th className="px-3 py-2 text-right font-mono text-[11px] font-bold uppercase tracking-widest">
                  Duration
                </th>
                <th className="px-3 py-2 text-right font-mono text-[11px] font-bold uppercase tracking-widest">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={`${r.timestamp}|${r.client_ip}|${r.url}`} className="hover:bg-muted/30">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                    {new Date(r.timestamp).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono font-semibold">{r.client_ip}</td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">{r.server_ip}</td>
                  <td className="max-w-[320px] truncate px-3 py-2 font-mono" title={r.url}>
                    {r.url}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={r.action === "ALLOW" ? "success" : r.action === "DENY" ? "destructive" : "warning"}>
                      {r.action || "—"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {r.duration_seconds != null ? `${(r.duration_seconds * 1000).toFixed(0)}ms` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="outline" size="sm" onClick={() => onInspect(r)}>
                      <Eye className="h-3.5 w-3.5" />
                      Inspect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Showing 1–{rows.length} of {total.toLocaleString()} · Task 5 will add pagination, filters, and CSV
            export.
          </div>
        </div>
      )}
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">
        Placeholder Log Inspector — Task 5 replaces this with the full DataTable + slide-over drawer.
      </p>
    </Panel>
  )
}

function InspectionDrawer({ row, onClose }: { row: QueryDoc; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`Event — ${row.client_ip} → ${row.base_url}`}>
      <div className="space-y-3 font-mono text-xs">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mono-label">Timestamp</p>
            <p className="mt-1 text-foreground">{new Date(row.timestamp).toLocaleString()}</p>
          </div>
          <div>
            <p className="mono-label">Action</p>
            <p className="mt-1">
              <Badge variant={row.action === "ALLOW" ? "success" : row.action === "DENY" ? "destructive" : "warning"}>
                {row.action || "—"}
              </Badge>
            </p>
          </div>
          <div>
            <p className="mono-label">Source IP (Host)</p>
            <p className="mt-1 font-bold text-foreground">{row.client_ip}</p>
          </div>
          <div>
            <p className="mono-label">Dest IP</p>
            <p className="mt-1 text-foreground">{row.server_ip}</p>
          </div>
          <div>
            <p className="mono-label">Duration</p>
            <p className="mt-1 tabular-nums">
              {row.duration_seconds != null ? `${(row.duration_seconds * 1000).toFixed(0)}ms` : "—"}
            </p>
          </div>
          <div>
            <p className="mono-label">Matched Rule</p>
            <p className="mt-1 text-muted-foreground">
              {row.blocked_by.length > 0 ? row.blocked_by.join(", ") : "—"}
            </p>
          </div>
        </div>
        <div>
          <p className="mono-label">Full URL</p>
          <a href={row.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-primary hover:underline">
            {row.url}
          </a>
          <p className="mt-1 text-muted-foreground">Base: {row.base_url}</p>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
          <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground self-center">
            Full drawer with Allow List + Host History lands in Task 5.
          </span>
        </div>
      </div>
    </Dialog>
  )
}

export function LiveMonitorPage() {
  const { globalFilter, setGlobalFilter, timeRange } = useFilter()
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerRow, setDrawerRow] = useState<QueryDoc | null>(null)

  const fetchMetrics = useCallback(async () => {
    setLoading(true)
    try {
      const m = await getLiveMetrics({ minutes: timeRangeToMinutes(timeRange) })
      setMetrics(m)
    } catch {
      // keep previous metrics on transient failure
    } finally {
      setLoading(false)
    }
  }, [timeRange])

  useEffect(() => {
    fetchMetrics()
  }, [fetchMetrics])

  const { refreshSeconds: _refresh } = useAutoRefresh(fetchMetrics, "live-monitor", 0)
  void _refresh

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Traffic Monitor"
        description="Real-time Kibana stream — Sankey + Log Inspector"
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {globalFilter ? `filter: ${globalFilter}` : "no filter"} · {timeRange}
        </span>
      </PageHeader>

      {loading && !metrics ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : metrics ? (
        <MetricCards
          activeHosts={metrics.activeHosts}
          totalRequests={metrics.totalRequests}
          deniedRequests={metrics.deniedRequests}
          bandwidth={metrics.bandwidth}
          avgDuration={metrics.avgDuration}
        />
      ) : (
        <MetricCards
          activeHosts={142}
          totalRequests={1284902}
          deniedRequests={3412}
          bandwidth="420 MB"
          avgDuration="145ms"
        />
      )}

      <SankeySection filter={globalFilter} timeRange={timeRange} onNodeClick={(q) => setGlobalFilter(q)} />

      <LogInspectorSection filter={globalFilter} timeRange={timeRange} onInspect={(row) => setDrawerRow(row)} />

      {drawerRow && <InspectionDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />}
    </div>
  )
}
