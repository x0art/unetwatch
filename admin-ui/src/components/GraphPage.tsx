import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUpRight,
  Ban,
  Link2,
  Maximize,
  MousePointerClick,
  Network,
  RefreshCcw,
  Search,
  SearchX,
  Server,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import {
  type FindingsGraph,
  type GraphLink,
  type GraphNode,
  addBaseUrlToBlacklist,
  getFindingsGraph,
} from "../api"
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { DataTable } from "./DataTable"
import { type View } from "./Sidebar"
import { cn, useDebounce } from "../lib/utils"

type Kind = GraphNode["kind"]

interface LayoutNode extends GraphNode {
  x: number
  y: number
  width: number
  height: number
}

interface GraphTransform {
  scale: number
  tx: number
  ty: number
}

/* ── Layer geometry (fixed 3-column flow: client IP → server IP → URL) ── */

const KIND_COLUMN: Record<Kind, { x: number; width: number; label: string }> = {
  ip: { x: 24, width: 180, label: "Client IP" },
  server: { x: 268, width: 180, label: "Server IP" },
  url: { x: 512, width: 380, label: "URL" },
}

const KIND_LABEL: Record<Kind, string> = {
  ip: "Client IP",
  server: "Server IP",
  url: "URL",
}

const KIND_PLURAL: Record<Kind, string> = {
  ip: "client IPs",
  server: "server IPs",
  url: "URLs",
}

const KIND_BADGE: Record<Kind, "secondary" | "warning" | "destructive"> = {
  ip: "secondary",
  server: "warning",
  url: "destructive",
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

const MIN_SCALE = 0.2
const MAX_SCALE = 3
const PAGE_SIZE = 25

function clampScale(s: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
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
  const [search, setSearch] = useState("")
  const [transform, setTransform] = useState<GraphTransform>({
    scale: 1,
    tx: 0,
    ty: 0,
  })
  const [dragging, setDragging] = useState(false)
  // Rich tooltip: content + cursor position (fixed coords, clamped to graph).
  const [tip, setTip] = useState<{ node: LayoutNode; x: number; y: number } | null>(null)

  // Table state (endpoints derived from the graph nodes).
  const [tablePage, setTablePage] = useState(0)
  const [bulkBusy, setBulkBusy] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const debouncedSearch = useDebounce(search, 200)
  const q = debouncedSearch.trim().toLowerCase()
  // Spotlight target: keyboard focus takes precedence over hover.
  const activeId = focused ?? hovered

  const fetchGraph = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setTip(null) // drop a stale tooltip when the graph is replaced
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

  // Reset client-side table state whenever the underlying graph changes.
  useEffect(() => {
    setTablePage(0)
  }, [graph])

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

  // Total access count per layer — used for the tooltip share percentage.
  const layerTotals = useMemo(() => {
    const t: Record<Kind, number> = { ip: 0, server: 0, url: 0 }
    for (const n of graph?.nodes ?? []) t[n.kind] += n.count
    return t
  }, [graph])

  // Node ids that match the search query, plus their direct neighbours, so
  // spotlighting a match reveals its connections.
  const searchMatches = useMemo(() => {
    const ids = new Set<string>()
    if (!q) return ids
    const links = graph?.links ?? []
    for (const n of graph?.nodes ?? []) {
      if (!n.label.toLowerCase().includes(q)) continue
      ids.add(n.id)
      for (const l of links) {
        if (l.source === n.id) ids.add(l.target)
        if (l.target === n.id) ids.add(l.source)
      }
    }
    return ids
  }, [q, graph])

  const matchCount = useMemo(
    () =>
      q ? (graph?.nodes ?? []).filter((n) => n.label.toLowerCase().includes(q)).length : 0,
    [q, graph],
  )

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

  // Hover/focus spotlight takes precedence; otherwise the search query dims
  // everything that doesn't match (or isn't connected to a match).
  const isNodeDimmed = (id: string) => {
    if (activeId !== null) return !isNodeActive(id)
    return q.length > 0 && !searchMatches.has(id)
  }

  const isEdgeDimmed = (l: GraphLink) => {
    if (activeId !== null) return !isLinkActive(l)
    return q.length > 0 && !(searchMatches.has(l.source) && searchMatches.has(l.target))
  }

  const openFindings = (n: GraphNode) => {
    toast({
      title: "Viewing findings",
      description: `Filtered by ${n.label}`,
      variant: "info",
    })
    onNavigate("findings", n.label)
  }

  /* ── Rich tooltip ────────────────────────────────────────────────── */

  const showTooltip = (n: LayoutNode, cx: number, cy: number) => {
    let x = cx + 14
    let y = cy + 14
    const vp = viewportRef.current
    if (vp) {
      const rect = vp.getBoundingClientRect()
      x = Math.max(rect.left + 4, Math.min(x, rect.right - 276))
      y = Math.max(rect.top + 4, Math.min(y, rect.bottom - 96))
    }
    setTip({ node: n, x, y })
  }

  const moveTooltip = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!tip) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(rect.left + 4, Math.min(e.clientX + 14, rect.right - 276))
    const y = Math.max(rect.top + 4, Math.min(e.clientY + 14, rect.bottom - 96))
    setTip((prev) => (prev ? { ...prev, x, y } : prev))
  }

  /* ── Zoom & pan ──────────────────────────────────────────────────── */

  const zoomBy = (factor: number) => {
    const vp = viewportRef.current
    const cx = vp ? vp.clientWidth / 2 : 0
    const cy = vp ? vp.clientHeight / 2 : 0
    setTransform((t) => {
      const scale = clampScale(t.scale * factor)
      const k = scale / t.scale
      return { scale, tx: cx - (cx - t.tx) * k, ty: cy - (cy - t.ty) * k }
    })
  }

  const fitView = useCallback(() => {
    const vp = viewportRef.current
    if (!vp || !layout) return
    const pad = 32
    const w = Math.max(200, vp.clientWidth - pad)
    const h = Math.max(200, vp.clientHeight - pad)
    const scale = clampScale(Math.min(w / layout.width, h / layout.height, 1))
    const tx = Math.max(0, (vp.clientWidth - layout.width * scale) / 2)
    const ty = Math.max(0, (vp.clientHeight - layout.height * scale) / 2)
    setTransform({ scale, tx, ty })
  }, [layout])

  // Ctrl + wheel zooms around the cursor (non-passive so preventDefault works).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setTransform((t) => {
        const scale = clampScale(t.scale * (e.deltaY < 0 ? 1.12 : 0.89))
        const k = scale / t.scale
        return { scale, tx: px - (px - t.tx) * k, ty: py - (py - t.ty) * k }
      })
    }
    vp.addEventListener("wheel", onWheel, { passive: false })
    return () => vp.removeEventListener("wheel", onWheel)
  }, [])

  // Drag to pan (background only — node presses keep their click behaviour).
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest?.("[role='button']")) return
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: transform.tx,
      ty: transform.ty,
    }
    setDragging(true)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (d) {
      setTransform((t) => ({
        ...t,
        tx: d.tx + (e.clientX - d.x),
        ty: d.ty + (e.clientY - d.y),
      }))
    }
  }

  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
  }

  /* ── Endpoint table (client-side over graph nodes) ───────────────── */

  const allNodes = useMemo(() => graph?.nodes ?? [], [graph])

  const filteredNodes = useMemo(() => {
    if (!q) return allNodes
    return allNodes.filter((n) => n.label.toLowerCase().includes(q))
  }, [q, allNodes])

  useEffect(() => {
    setTablePage(0)
  }, [q])

  const handleBulkBlacklist = async (ids: Set<string | number>) => {
    const nodes = filteredNodes.filter((n) => ids.has(n.id) && n.label.trim())
    if (!nodes.length) return
    setBulkBusy(true)
    try {
      const results = await Promise.all(nodes.map((n) => addBaseUrlToBlacklist(n.label)))
      const added = results.reduce((sum, r) => sum + r.added.length, 0)
      toast({
        title: added
          ? `${added} entr${added === 1 ? "y" : "ies"} added to blacklist`
          : "Already in blacklist",
        variant: added ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBulkBusy(false)
    }
  }

  const shareOf = (n: GraphNode) =>
    layerTotals[n.kind] > 0 ? Math.round((n.count / layerTotals[n.kind]) * 100) : 0

  const graphEmpty = !loading && !error && (!graph || graph.nodes.length === 0)
  const tableEmpty = !loading && (!!error || filteredNodes.length === 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Traffic Graph</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Flow of flagged URLs being accessed by client IPs (from persisted findings)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      {/* Visualization: traffic relations */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Traffic relations</h3>
            <p className="text-xs text-muted-foreground">
              Client IPs reaching flagged URLs through server IPs. Hover to highlight · click a
              node to open its findings.
            </p>
          </div>
          {graph && !graphEmpty && (
            <div className="flex flex-wrap items-center gap-2">
              {q.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-2.5 py-0.5 text-[11px] font-semibold text-info">
                  {matchCount} match{matchCount === 1 ? "" : "es"}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
                <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
                Ctrl+scroll zooms · drag pans
              </span>
              <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => zoomBy(1.2)}
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
                <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
                  {Math.round(transform.scale * 100)}%
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => zoomBy(0.8)}
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={fitView}
                  aria-label="Fit graph to view"
                >
                  <Maximize className="h-3.5 w-3.5" />
                </Button>
              </div>
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
        ) : layout && graph ? (
          <div
            ref={viewportRef}
            className={cn(
              "overflow-auto",
              dragging ? "cursor-grabbing" : "cursor-grab",
            )}
            onMouseMove={moveTooltip}
            onMouseLeave={() => setTip(null)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="min-w-fit p-2">
              <svg
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-label="IP to URL access flow graph"
                className="block overflow-visible"
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

                <g
                  transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}
                >
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
                    const dimmed = isEdgeDimmed(l)
                    const strokeWidth = 1 + (l.count / layout.maxLinkCount) * 6
                    return (
                      <g key={i}>
                        {!dimmed && !(activeId !== null && active) && (
                          <path
                            d={edgePath(src, dst)}
                            fill="none"
                            className={cn("edge-flow", EDGE_STYLES[kindOf(l.target)])}
                            style={{ strokeWidth }}
                            opacity={0.4}
                          />
                        )}
                        <path
                          d={edgePath(src, dst)}
                          fill="none"
                          className={cn(
                            "transition-opacity duration-150",
                            active && activeId ? EDGE_STYLES[kindOf(l.target)] : "stroke-muted",
                          )}
                          style={{
                            strokeWidth,
                            opacity: dimmed ? 0.12 : active && activeId !== null ? 1 : 0.55,
                          }}
                          markerEnd="url(#flow-arrow)"
                        >
                          <title>{`${src.label} → ${dst.label} · ${l.count} access${l.count === 1 ? "" : "es"}`}</title>
                        </path>
                      </g>
                    )
                  })}

                  {/* Nodes */}
                  {layout.nodes.map((n) => (
                    <g
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${n.label} — ${n.count} accesses. Open findings.`}
                      aria-describedby="traffic-graph-tooltip"
                      onClick={() => openFindings(n)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          openFindings(n)
                        }
                      }}
                      onMouseEnter={(e) => {
                        if (dragRef.current) return // ignore nodes under the cursor while panning
                        setHovered(n.id)
                        showTooltip(n, e.clientX, e.clientY)
                      }}
                      onMouseLeave={() => {
                        setHovered(null)
                        setTip(null)
                      }}
                      onFocus={() => setFocused(n.id)}
                      onBlur={() => setFocused(null)}
                      className="cursor-pointer transition-opacity duration-150"
                      style={{ opacity: isNodeDimmed(n.id) ? 0.15 : 1 }}
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
                    </g>
                  ))}
                </g>
              </svg>
            </div>
          </div>
        ) : null}
      </div>

      {/* Endpoints table */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {filteredNodes.length.toLocaleString()} endpoint
            {filteredNodes.length !== 1 ? "s" : ""}
            {q.length > 0 && ` matching "${debouncedSearch.trim()}"`}
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search endpoints..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 pl-8 pr-8"
              aria-label="Search endpoints"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-2.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : tableEmpty ? (
          <EmptyState
            icon={SearchX}
            title={error ? "Unable to load endpoints" : q ? "No matching endpoints" : "No endpoints"}
            description={
              error
                ? error
                : q
                  ? "Try adjusting your search."
                  : "Endpoints appear here once the graph has traffic data."
            }
          />
        ) : (
          <DataTable
            columns={[
              {
                id: "kind",
                header: "Kind",
                accessor: (n) => n.kind,
                defaultSortDir: "asc",
                cell: (n) => <Badge variant={KIND_BADGE[n.kind]}>{KIND_LABEL[n.kind]}</Badge>,
                width: "w-24",
              },
              {
                id: "endpoint",
                header: "Endpoint",
                accessor: (n) => n.label,
                defaultSortDir: "asc",
                cell: (n) => (
                  <span className="font-mono text-xs" title={n.label}>
                    {truncate(n.label, 56)}
                  </span>
                ),
              },
              {
                id: "accesses",
                header: "Accesses",
                accessor: (n) => n.count,
                cell: (n) => <span className="tabular-nums">{n.count.toLocaleString()}</span>,
                align: "right",
                width: "w-24",
                defaultSortDir: "desc",
              },
              {
                id: "share",
                header: "Share",
                enableSorting: false,
                cell: (n) => (
                  <span className="tabular-nums text-muted-foreground">{shareOf(n)}%</span>
                ),
                align: "right",
                width: "w-20",
              },
              {
                id: "actions",
                header: <span className="sr-only">Actions</span>,
                enableSorting: false,
                align: "right",
                width: "w-16",
                cell: (n) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    onClick={() => openFindings(n)}
                    aria-label={`View findings for ${n.label}`}
                  >
                    <ArrowUpRight className="h-4 w-4" />
                  </Button>
                ),
              },
            ]}
            data={filteredNodes}
            rowId={(n) => n.id}
            selectable
            busy={bulkBusy}
            internalPagination
            bulkActions={[
              {
                label: "Add to blacklist",
                icon: Ban,
                variant: "outline",
                onClick: handleBulkBlacklist,
              },
            ]}
            defaultSortBy="accesses"
            defaultSortDir="desc"
            page={tablePage}
            pageSize={PAGE_SIZE}
            onPageChange={setTablePage}
            ariaLabel="Endpoints"
          />
        )}
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
                  <span className="block max-w-[420px] truncate font-mono text-xs" title={f.url}>
                    {f.url}
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
            ]}
            data={graph.flows}
            rowId={(f) => `${f.client_ip}|${f.server_ip}|${f.url}`}
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

      {/* Rich tooltip (fixed-positioned outside the scroll container) */}
      {tip && (
        <div
          id="traffic-graph-tooltip"
          className="pointer-events-none fixed z-50 w-64 rounded-lg border border-border bg-popover/95 p-3 shadow-xl backdrop-blur"
          style={{ left: tip.x, top: tip.y }}
          role="tooltip"
        >
          <p className="font-mono text-xs leading-snug break-all">{tip.node.label}</p>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {KIND_LABEL[tip.node.kind]}
            </span>
            <span className="text-sm font-bold tabular-nums">
              {tip.node.count.toLocaleString()}
              <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                {layerTotals[tip.node.kind] > 0
                  ? `${Math.round((tip.node.count / layerTotals[tip.node.kind]) * 100)}% of ${KIND_PLURAL[tip.node.kind]}`
                  : ""}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
