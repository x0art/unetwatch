import { useEffect, useMemo, useRef, useState } from "react"
import * as echarts from "echarts/core"
import { GraphChart } from "echarts/charts"
import type { GraphSeriesOption } from "echarts/charts"
import { TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type {
  ECharts,
  EChartsOption,
  ECElementEvent,
  TooltipComponentFormatterCallbackParams,
} from "echarts"
import { useTheme } from "./Sidebar"
import {
  FALLBACK_DARK,
  FALLBACK_LIGHT,
  resolveAllColors,
  resolveColor,
  type ResolvedColors,
} from "./SankeyDiagram"

echarts.use([GraphChart, TooltipComponent, CanvasRenderer])

const MAX_LABEL = 30

export interface FlowNode {
  id: string
  /** Short label shown next to the node (e.g. host + trimmed path). */
  name: string
  /** Longest-path layer: sources at 0, terminals on the last layer. */
  layer: number
  /** Full detail shown in the tooltip (e.g. the full URL). */
  detail?: string
  /** Tracked-URL status; nodes without one are redirect targets. */
  status?: "ok" | "redirect" | "error" | "unknown"
  /** Whether clicking this node filters the table. */
  clickable?: boolean
}

export interface FlowLink {
  source: string
  target: string
  value: number
  /** Optional edge label (e.g. the HTTP status "302"). */
  name?: string
}

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

/* Tracked-URL status → label + theme token. Nodes without a status are
 * redirect targets (waypoints / destinations) and use the info color. */
const STATUS_META: Record<string, { label: string; color: string }> = {
  ok: { label: "OK", color: "var(--color-success)" },
  redirect: { label: "Redirecting", color: "var(--color-warning)" },
  error: { label: "Error", color: "var(--color-danger)" },
  unknown: { label: "Unknown", color: "var(--color-muted-foreground)" },
}
const DESTINATION_COLOR = "var(--color-info)"

interface LayoutNode {
  id: string
  name: string
  x: number
  y: number
  symbolSize: number
}

/* Margins (px) around the node area. The right margin is generous because
 * terminal-column labels sit to the LEFT of their nodes and need room. */
const LAYOUT = { left: 28, right: 200, top: 26, bottom: 26 }

/** Deterministic layered layout in pixel space: nodes are placed by
 * longest-path layer (sources left, terminals right) and spread vertically
 * within their layer, so redirect chains read left → right. Pixel
 * coordinates keep the diagram filling the canvas — ECharts' graph view
 * coord system fits the data bounding box aspect-preservingly, so a square
 * 0-100 data space would collapse into a small centered box on a wide
 * panel. */
function layout(
  nodes: FlowNode[],
  links: FlowLink[],
  width: number,
  height: number,
): LayoutNode[] {
  const byLayer = new Map<number, FlowNode[]>()
  for (const n of nodes) {
    const layer = n.layer ?? 0
    if (!byLayer.has(layer)) byLayer.set(layer, [])
    byLayer.get(layer)!.push(n)
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  const maxLayer = Math.max(0, ...layers)

  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const l of links) {
    inDeg.set(l.target, (inDeg.get(l.target) ?? 0) + l.value)
    outDeg.set(l.source, (outDeg.get(l.source) ?? 0) + l.value)
  }

  const spanX = Math.max(1, width - LAYOUT.left - LAYOUT.right)
  const spanY = Math.max(1, height - LAYOUT.top - LAYOUT.bottom)

  const result: LayoutNode[] = []
  for (const layer of layers) {
    const group = [...(byLayer.get(layer) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    const count = group.length
    group.forEach((n, i) => {
      const x = maxLayer === 0 ? width / 2 : LAYOUT.left + (layer / maxLayer) * spanX
      const y =
        count === 1 ? LAYOUT.top + spanY / 2 : LAYOUT.top + (i / (count - 1)) * spanY
      // Busy nodes (many redirects in/out) get slightly larger symbols.
      const degree = (inDeg.get(n.id) ?? 0) + (outDeg.get(n.id) ?? 0)
      result.push({
        id: n.id,
        name: n.name,
        x,
        y,
        symbolSize: 12 + Math.min(14, degree * 1.5),
      })
    })
  }
  return result
}

function buildOption(params: {
  nodes: FlowNode[]
  layoutNodes: LayoutNode[]
  links: FlowLink[]
  resolved: ResolvedColors
  statusColors: Record<string, string>
  hasClick: boolean
}): EChartsOption {
  const { nodes, layoutNodes, links, resolved, statusColors, hasClick } = params
  const { palette } = resolved
  const maxLayer = nodes.reduce((m, n) => Math.max(m, n.layer ?? 0), 0)

  const nodeColor = (n: FlowNode): string => {
    const meta = n.status ? STATUS_META[n.status] : null
    return meta ? statusColors[meta.color] : statusColors.destination
  }

  // Structural type: ECharts graph data items accept arbitrary extra fields
  // (used here for click-to-filter), but GraphNodeItemOption isn't exported
  // from echarts/charts — this local shape is structurally checked when
  // assigned into the series option below.
  type GraphDataItem = {
    id: string
    name: string
    url?: string
    x: number
    y: number
    fixed: boolean
    symbolSize: number
    itemStyle: { color: string; borderColor: string; borderWidth: number }
    label: {
      show: boolean
      position: string
      distance: number
      color: string
      fontFamily: string
      fontSize: number
      formatter: string | (() => string)
    }
  }
  const graphData: GraphDataItem[] = layoutNodes.map((ln) => {
    const n = nodes.find((x) => x.id === ln.id) ?? {
      id: ln.id,
      name: ln.name,
      layer: 0,
    }
    // Terminal-column labels flip to the left so they don't run off the
    // right edge; everything else reads left → right.
    const isLastColumn = (n.layer ?? 0) === maxLayer
    return {
      id: ln.id,
      name: ln.name,
      url: n.clickable ? (n.detail ?? n.id) : undefined,
      x: ln.x,
      y: ln.y,
      fixed: true,
      symbolSize: ln.symbolSize,
      itemStyle: {
        color: nodeColor(n),
        borderColor: palette.border,
        borderWidth: 1,
      },
      label: {
        show: true,
        position: isLastColumn ? "left" : "right",
        distance: 8,
        color: palette.label,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 10,
        formatter: () => formatLabel(ln.name),
      },
    }
  })

  // Directed edges with an arrow; thickness/opacity scale with the value.
  const graphLinks = links.map((l) => {
    const w = Math.min(4, 1 + l.value * 0.4)
    return {
      source: l.source,
      target: l.target,
      value: l.value,
      label: l.name
        ? {
            show: true,
            formatter: l.name,
            position: "middle" as const,
            fontSize: 9,
            color: statusColors.edge,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }
        : undefined,
      lineStyle: {
        color: statusColors.edge,
        width: w,
        opacity: 0.55,
        curveness: 0.2,
      },
    }
  })

  return {
    // No enter/update animation: the first paint must not depend on
    // requestAnimationFrame ticks (stalled rAF in embedded webviews / hidden
    // tabs leaves the chart blank forever).
    animation: false,
    animationDuration: 0,
    animationEasing: "cubicOut",
    animationDurationUpdate: 0,
    animationEasingUpdate: "cubicOut",
    tooltip: {
      trigger: "item",
      triggerOn: "mousemove",
      backgroundColor: palette.card,
      borderColor: palette.border,
      textStyle: { color: palette.label, fontSize: 12 },
      formatter: (p: TooltipComponentFormatterCallbackParams) => {
        const params = Array.isArray(p) ? p[0] : p
        if (params.dataType === "edge") {
          const src = (params as { source?: string }).source ?? ""
          const tgt = (params as { target?: string }).target ?? ""
          const status = (params as { name?: string }).name
          return status ? `${status} ${src} → ${tgt}` : `${src} → ${tgt}`
        }
        const data = params.data as
          | { detail?: string; url?: string; status?: string }
          | undefined
        if (data?.detail) {
          const meta = data.status ? STATUS_META[data.status] : null
          const lines = [
            data.detail,
            meta?.label ? `${meta.label} status` : "Redirect destination",
          ].filter(Boolean)
          if (hasClick && data.url) lines.push("Click to filter the table")
          return lines.join("<br/>")
        }
        return params.name
      },
    },
    series: [
      {
        type: "graph",
        // Deliberately NO `coordinateSystem`: a graph series without one maps
        // its x/y (0-100) onto its own view coordinate system and renders
        // synchronously — a cartesian2d graph defers its first paint to the
        // rAF frame loop, so a stalled rAF leaves the chart blank forever.
        layout: "none",
        // graphData carries extra `url` fields and label `position` values
        // ECharts' LabelOption union types reject, so the shape is verified
        // structurally above and narrowed at the edge.
        data: graphData as unknown as GraphSeriesOption["data"],
        links: graphLinks,
        roam: false,
        draggable: false,
        emphasis: { focus: "adjacency" },
        // State changes snap; only data-change animation runs (cheap hover).
        stateAnimation: { duration: 0 },
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: [0, 7],
        label: { show: false },
      },
    ],
  }
}

function sameNodes(a: FlowNode[], b: FlowNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.layer !== y.layer ||
      x.detail !== y.detail ||
      x.status !== y.status ||
      x.clickable !== y.clickable
    ) {
      return false
    }
  }
  return true
}

function sameLinks(a: FlowLink[], b: FlowLink[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.source !== y.source || x.target !== y.target || x.value !== y.value || x.name !== y.name) {
      return false
    }
  }
  return true
}

export function RedirectFlowDiagram({
  nodes,
  links,
  height,
  className,
  ariaLabel,
  onSelectUrl,
}: {
  nodes: FlowNode[]
  links: FlowLink[]
  /** Fixed height (px). Defaults to content-derived height. */
  height?: number
  className?: string
  ariaLabel?: string
  onSelectUrl?: (url: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const { theme } = useTheme()
  // Measured container width — the pixel-space layout depends on it.
  const [width, setWidth] = useState(0)

  // Height must fit the densest layer with room for node + label.
  const maxRows = useMemo(() => {
    const counts = new Map<number, number>()
    for (const n of nodes) {
      const layer = n.layer ?? 0
      counts.set(layer, (counts.get(layer) ?? 0) + 1)
    }
    return Math.max(1, ...counts.values())
  }, [nodes])
  const h = height ?? Math.max(340, Math.min(760, 88 + maxRows * 52))

  // Resolve every theme token once per (theme) — see the resolveAllColors
  // cache in SankeyDiagram; the getComputedStyle calls never re-run for an
  // unchanged theme.
  const resolved = resolveAllColors(theme, undefined)

  const statusColors = useMemo(() => {
    const fallback = theme === "light" ? FALLBACK_LIGHT : FALLBACK_DARK
    const out: Record<string, string> = { destination: "", edge: "" }
    for (const meta of Object.values(STATUS_META)) {
      out[meta.color] = resolveColor(meta.color, fallback)
    }
    out.destination = resolveColor(DESTINATION_COLOR, fallback)
    out.edge = resolveColor("var(--color-muted-foreground)", fallback)
    return out
  }, [theme])

  const layoutNodes = useMemo(
    () => (width > 0 ? layout(nodes, links, width, h) : []),
    [nodes, links, width, h],
  )

  // Last-pushed content, used to skip no-op re-renders. Reset whenever a
  // fresh chart instance is created (see the init effect below): React
  // StrictMode in dev mounts → unmounts → remounts, and the remounted chart
  // must receive its option even though the data is unchanged — otherwise
  // the new instance stays blank forever.
  const prev = useRef<{
    nodes: FlowNode[]
    links: FlowLink[]
    layoutNodes: LayoutNode[]
  } | null>(null)
  const prevPalette = useRef<ResolvedColors["palette"] | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    // A brand-new instance has never received an option — make the data
    // effect below push one regardless of the unchanged-data guard.
    prev.current = null
    prevPalette.current = null

    const onResize = () => {
      chart.resize()
      // Re-layout: node positions are in pixels, so a size change must
      // recompute them (the data effect below picks it up via layoutNodes).
      setWidth(el.clientWidth)
    }
    const onWindowResize = () => onResize()
    window.addEventListener("resize", onWindowResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    setWidth(el.clientWidth)

    return () => {
      window.removeEventListener("resize", onWindowResize)
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // Wait for the first container measurement — positions are pixels.
    if (width === 0) return

    const contentChanged =
      prev.current === null ||
      prev.current.layoutNodes !== layoutNodes ||
      !sameNodes(prev.current.nodes, nodes) ||
      !sameLinks(prev.current.links, links)
    const paletteChanged =
      prevPalette.current === null ||
      prevPalette.current.label !== resolved.palette.label ||
      prevPalette.current.muted !== resolved.palette.muted ||
      prevPalette.current.card !== resolved.palette.card ||
      prevPalette.current.border !== resolved.palette.border

    if (!contentChanged && !paletteChanged) {
      // Parent re-render with identical data/palette — nothing to do.
      return
    }

    prev.current = { nodes, links, layoutNodes }
    prevPalette.current = resolved.palette

    chart.setOption(
      buildOption({
        nodes,
        layoutNodes,
        links,
        resolved,
        statusColors,
        hasClick: !!onSelectUrl,
      }),
      contentChanged,
    )
    // Force a synchronous zrender flush. Without it the first paint is
    // scheduled on the next rAF frame, so a stalled rAF (embedded webviews,
    // backgrounded tabs, power-save) leaves the chart blank forever — the
    // animation-off flag above is not enough because zrender still defers the
    // initial render to its frame loop.
    chart.getZr().flush()
    chart.resize()
  }, [nodes, links, layoutNodes, width, h, resolved, statusColors, onSelectUrl])

  // Click a node → filter the tracked-URLs table (sources only — see the
  // `clickable` flag on FlowNode).
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onSelectUrl) return
    const onClick = (params: ECElementEvent) => {
      const data = (params.data as { url?: string } | undefined)
      if (data?.url) onSelectUrl(data.url)
    }
    chart.on("click", onClick)
    return () => {
      chart.off("click", onClick)
    }
  }, [onSelectUrl])

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel ?? "Redirect flow diagram"}
      className={className}
      style={{ width: "100%", height: h }}
    />
  )
}
