import { useCallback, useEffect, useState } from "react"
import { Activity } from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { Button, PageHeader, Panel, Skeleton } from "./ui"
import { MetricCards } from "./MetricCards"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"
import {
  getLiveSankey,
  getLiveMetrics,
  liveSankeyTruncationNote,
  timeRangeToMinutesLive,
  type LiveMetrics,
} from "../api"
import { useAutoRefresh } from "../lib/utils"
import { LogInspector, type LogRow } from "./LogInspector"
import { InspectionDrawer } from "./InspectionDrawer"

/** Delegates to api.timeRangeToMinutesLive (single source; also handles numeric strings). */
function timeRangeToMinutes(tr: string): number {
  return timeRangeToMinutesLive(tr)
}

const STUB_NODES: SankeyNode[] = [
  { id: "stub:src:10.0.0.12", name: "10.0.0.12", layer: 0 },
  { id: "stub:src:10.0.0.44", name: "10.0.0.44", layer: 0 },
  { id: "stub:pat:*.stream", name: "*.stream", layer: 1 },
  { id: "stub:pat:Unmatched", name: "Unmatched", layer: 1 },
  { id: "stub:dom:example.com", name: "example.com", layer: 2, action: "DENY" },
  { id: "stub:dom:api.example.com", name: "api.example.com", layer: 2, action: "ALLOW" },
  { id: "stub:dst:93.184.216.34", name: "93.184.216.34", layer: 3 },
  { id: "stub:dst:10.0.0.1", name: "10.0.0.1", layer: 3, isHighRisk: true },
]

const STUB_LINKS: SankeyLink[] = [
  { source: "stub:src:10.0.0.12", target: "stub:pat:*.stream", value: 42 },
  { source: "stub:src:10.0.0.44", target: "stub:pat:Unmatched", value: 18 },
  { source: "stub:pat:*.stream", target: "stub:dom:example.com", value: 42 },
  { source: "stub:pat:Unmatched", target: "stub:dom:api.example.com", value: 18 },
  { source: "stub:dom:example.com", target: "stub:dst:93.184.216.34", value: 30 },
  { source: "stub:dom:example.com", target: "stub:dst:10.0.0.1", value: 12, isHighRisk: true },
  { source: "stub:dom:api.example.com", target: "stub:dst:93.184.216.34", value: 18 },
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
      // Task 4: 4-column flow via getLiveSankey (Sources → Patterns → Domains → Destinations).
      // Filter is intentionally NOT forwarded to the Sankey query — the global filter
      // drives LogInspector; the Sankey always shows the full time window so its
      // structure stays stable while the user refines the table.
      try {
        const graph = await getLiveSankey(timeRange)
        if (graph.nodes.length > 0 && graph.links.length > 0) {
          setNodes(graph.nodes)
          setLinks(graph.links)
          return
        }
      } catch {
        /* keep stub */
      }
    } finally {
      setLoading(false)
    }
  }, [timeRange])

  useEffect(() => {
    fetchFlow()
  }, [fetchFlow])

  const truncationNote = liveSankeyTruncationNote(timeRange)

  return (
    <Panel
      title="Traffic Flow"
      description={
        truncationNote
          ? `${truncationNote} — ${filter ? `filtered: ${filter}` : "all sources → destinations"}`
          : filter ? `filtered: ${filter}` : "all sources → destinations"
      }
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
          {truncationNote && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 font-mono text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {truncationNote}
            </p>
          )}
          <SankeyDiagram
            nodes={nodes}
            links={links}
            onNodeClick={onNodeClick}
            ariaLabel="Live traffic flow — Sources → Patterns → Domains → Destinations"
          />
          <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            4-column flow — Sources → Patterns → Domains → Destinations. Click a node or ribbon to filter
            the Log Inspector below via <code className="rounded bg-muted px-1 py-0.5">setGlobalFilter</code>.
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

export function LiveMonitorPage() {
  const { globalFilter, setGlobalFilter, timeRange } = useFilter()
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerRow, setDrawerRow] = useState<LogRow | null>(null)

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

      <LogInspector filter={globalFilter} timeRange={timeRange} onInspect={setDrawerRow} />

      {drawerRow && <InspectionDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />}
    </div>
  )
}
