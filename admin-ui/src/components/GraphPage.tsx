import { useCallback, useEffect, useMemo, useState } from "react"
import { MousePointerClick, Network, RefreshCcw, SearchX } from "lucide-react"
import {
  type FindingsGraph,
  type GraphLink,
  type GraphNode,
  getFindingsGraph,
} from "../api"
import { Button, EmptyState, Select, Skeleton, useToast } from "./ui"
import { type View } from "./Sidebar"
import { cn } from "../lib/utils"

type Kind = GraphNode["kind"]

interface LayoutNode extends GraphNode {
  x: number
  y: number
  width: number
  height: number
}

/* ── Layer geometry (fixed 3-column flow: client IP → server IP → URL) ── */

const KIND_COLUMN: Record<Kind, { x: number; width: number; label: string }> = {
  ip: { x: 24, width: 180, label: "Client IP" },
  server: { x: 268, width: 180, label: "Server IP" },
  url: { x: 512, width: 380, label: "URL" },
}

const NODE_HEIGHT = 40
const TOP_PAD = 84
const BOTTOM_PAD = 32
const CANVAS_WIDTH = 512 + 380 + 40
const MAX_CANVAS_HEIGHT = 760

const LIMIT_OPTIONS = [
  { value: "15", label: "Top 15" },
  { value: "30", label: "Top 30" },
  { value: "50", label: "Top 50" },
  { value: "100", label: "Top 100" },
]

const KIND_STYLES: Record<Kind, { rect: string; label: string }> = {
  ip: { rect: "fill-info/15 stroke-info", label: "fill-info" },
  server: { rect: "fill-warning/15 stroke-warning", label: "fill-warning" },
  url: { rect: "fill-danger/15 stroke-danger", label: "fill-danger" },
}

const EDGE_STYLES: Record<Kind, string> = {
  ip: "stroke-info",
  server: "stroke-warning",
  url: "stroke-danger",
}

function kindOf(id: string): Kind {
  if (id.startsWith("ip:")) return "ip"
  if (id.startsWith("server:")) return "server"
  return "url"
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function buildLayout(graph: FindingsGraph): {
  nodes: LayoutNode[]
  width: number
  height: number
  maxLinkCount: number
} {
  const byKind: Record<Kind, GraphNode[]> = { ip: [], server: [], url: [] }
  for (const n of graph.nodes) byKind[n.kind].push(n)
  for (const k of Object.keys(byKind) as Kind[]) {
    byKind[k].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }

  const maxPerLayer = Math.max(1, ...Object.values(byKind).map((l) => l.length))
  const slot = Math.max(
    52,
    Math.min(66, Math.floor((MAX_CANVAS_HEIGHT - TOP_PAD - BOTTOM_PAD) / maxPerLayer)),
  )
  const height = Math.max(360, TOP_PAD + maxPerLayer * slot + BOTTOM_PAD)

  const nodes: LayoutNode[] = graph.nodes.map((n) => {
    const idx = byKind[n.kind].indexOf(n)
    const col = KIND_COLUMN[n.kind]
    return {
      ...n,
      x: col.x,
      y: TOP_PAD + idx * slot + (slot - NODE_HEIGHT) / 2,
      width: col.width,
      height: NODE_HEIGHT,
    }
  })

  const maxLinkCount = Math.max(1, ...graph.links.map((l) => l.count))
  return { nodes, width: CANVAS_WIDTH, height, maxLinkCount }
}

function edgePath(a: LayoutNode, b: LayoutNode) {
  const sx = a.x + a.width
  const sy = a.y + a.height / 2
  const tx = b.x
  const ty = b.y + b.height / 2
  const dx = Math.max(40, (tx - sx) / 2)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

export function GraphPage({
  onNavigate,
}: {
  onNavigate: (view: View, search?: string) => void
}) {
  const { toast } = useToast()
  const [limit, setLimit] = useState("30")
  const [graph, setGraph] = useState<FindingsGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  // Spotlight target: keyboard focus takes precedence over hover.
  const activeId = focused ?? hovered

  const fetchGraph = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setGraph(await getFindingsGraph(Number(limit)))
    } catch (e) {
      setError((e as Error).message)
      setGraph(null)
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => {
    fetchGraph()
  }, [fetchGraph])

  const layout = useMemo(() => (graph ? buildLayout(graph) : null), [graph])
  const layoutById = useMemo(
    () => new Map((layout?.nodes ?? []).map((n) => [n.id, n])),
    [layout],
  )

  const nodeKindCounts = useMemo(() => {
    const c: Record<Kind, number> = { ip: 0, server: 0, url: 0 }
    for (const n of graph?.nodes ?? []) c[n.kind] += 1
    return c
  }, [graph])

  const isNodeActive = (id: string) =>
    activeId === null ||
    id === activeId ||
    !!graph?.links.some(
      (l) =>
        (l.source === activeId && l.target === id) ||
        (l.source === id && l.target === activeId),
    )

  const isLinkActive = (l: GraphLink) =>
    activeId === null || l.source === activeId || l.target === activeId

  const openFindings = (n: GraphNode) => {
    toast({
      title: "Viewing findings",
      description: `Filtered by ${n.label}`,
      variant: "info",
    })
    onNavigate("findings", n.label)
  }

  const empty = !loading && !error && (!graph || graph.nodes.length === 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Traffic Graph</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Flow of flagged URLs being accessed by client IPs (from persisted findings)
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* Legend + summary */}
      {graph && !empty && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-info" aria-hidden="true" />
            {nodeKindCounts.ip.toLocaleString()} client IP{nodeKindCounts.ip === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-warning" aria-hidden="true" />
            {nodeKindCounts.server.toLocaleString()} server IP{nodeKindCounts.server === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true" />
            {nodeKindCounts.url.toLocaleString()} URL{nodeKindCounts.url === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5" aria-hidden="true" />
            {graph.links.length.toLocaleString()} access flow{graph.links.length === 1 ? "" : "s"}
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground/70">
            <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
            Hover to highlight · Click a node to view its findings
          </span>
        </div>
      )}

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-64 w-full rounded-lg" />
          <div className="flex gap-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-32" />
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
          <SearchX className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={fetchGraph}>
            Try again
          </Button>
        </div>
      ) : empty ? (
        <EmptyState
          icon={Network}
          title="No traffic to graph"
          description="Findings appear here once the ES poll detects matching log entries. The graph maps which client IPs are hitting which flagged URLs."
          action={
            <Button variant="outline" onClick={fetchGraph}>
              Refresh
            </Button>
          }
        />
      ) : layout && graph ? (
        <div className="overflow-auto rounded-lg border border-border bg-card shadow-sm">
            <div className="min-w-fit p-2">
              <svg
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-label="IP to URL access flow graph"
                className="block"
              >
                <defs>
                  <marker
                    id="flow-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/60" />
                  </marker>
                </defs>

                {/* Column headers */}
                {(Object.keys(KIND_COLUMN) as Kind[]).map((k) => (
                  <text
                    key={k}
                    x={KIND_COLUMN[k].x + KIND_COLUMN[k].width / 2}
                    y={TOP_PAD - 30}
                    textAnchor="middle"
                    fontSize={10}
                    letterSpacing="0.14em"
                    className="fill-muted-foreground font-medium uppercase"
                  >
                    {KIND_COLUMN[k].label}
                  </text>
                ))}

                {/* Edges */}
                {graph.links.map((l, i) => {
                  const src = layoutById.get(l.source)
                  const dst = layoutById.get(l.target)
                  if (!src || !dst) return null
                  const active = isLinkActive(l)
                  return (
                    <path
                      key={i}
                      d={edgePath(src, dst)}
                      fill="none"
                      className={cn(
                        "transition-opacity duration-150",
                        active && activeId ? EDGE_STYLES[kindOf(l.target)] : "stroke-muted",
                      )}
                      style={{
                        strokeWidth: 1 + (l.count / layout.maxLinkCount) * 6,
                        opacity: active ? (activeId ? 1 : 0.55) : 0.12,
                      }}
                      markerEnd="url(#flow-arrow)"
                    >
                      <title>{`${src.label} → ${dst.label} · ${l.count} access${l.count === 1 ? "" : "es"}`}</title>
                    </path>
                  )
                })}

                {/* Nodes */}
                {layout.nodes.map((n) => (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.label} — ${n.count} accesses. Open findings.`}
                    onClick={() => openFindings(n)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        openFindings(n)
                      }
                    }}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setFocused(n.id)}
                    onBlur={() => setFocused(null)}
                    className="cursor-pointer transition-opacity duration-150"
                    style={{ opacity: isNodeActive(n.id) ? 1 : 0.25 }}
                  >
                    <rect
                      x={n.x}
                      y={n.y}
                      width={n.width}
                      height={n.height}
                      rx={9}
                      strokeWidth={activeId === n.id ? 2 : 1.2}
                      className={cn(KIND_STYLES[n.kind].rect, "transition-all duration-150")}
                    />
                    <text
                      x={n.x + n.width / 2}
                      y={n.y + n.height / 2 - 5}
                      textAnchor="middle"
                      fontSize={11}
                      className={cn(KIND_STYLES[n.kind].label, "font-mono")}
                    >
                      {truncate(n.label, n.kind === "url" ? 44 : 21)}
                    </text>
                    <text
                      x={n.x + n.width / 2}
                      y={n.y + n.height / 2 + 10}
                      textAnchor="middle"
                      fontSize={9.5}
                      className="fill-muted-foreground"
                    >
                      {n.count.toLocaleString()} access{n.count === 1 ? "" : "es"}
                    </text>
                    <title>{`${n.label} — ${n.count} access${n.count === 1 ? "" : "es"}`}</title>
                  </g>
                ))}
              </svg>
          </div>
        </div>
      ) : null}
    </div>
  )
}
