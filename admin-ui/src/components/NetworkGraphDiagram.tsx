import { useCallback, useEffect, useRef } from "react"
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
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react"
import { useTheme } from "./Sidebar"
import { resolveAllColors, type ResolvedColors } from "./SankeyDiagram"

echarts.use([GraphChart, TooltipComponent, CanvasRenderer])

const MAX_LABEL = 36

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

export interface NetworkNode {
  id: string
  name: string
  kind?: string
  detail?: string
  value?: number
  clickable?: boolean
}

export interface NetworkLink {
  source: string
  target: string
  value?: number
  name?: string
}

function sameNodes(a: NetworkNode[], b: NetworkNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id || x.name !== y.name || x.kind !== y.kind ||
      x.detail !== y.detail || x.value !== y.value || x.clickable !== y.clickable
    )
      return false
  }
  return true
}

function sameLinks(a: NetworkLink[], b: NetworkLink[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.source !== y.source || x.target !== y.target || x.value !== y.value || x.name !== y.name)
      return false
  }
  return true
}

function kindColorIndex(kind: string | undefined): number {
  switch (kind) {
    case "ip": return 0
    case "server": return 1
    case "url":
    case "destination": return 2
    default: return 0
  }
}

function buildOption(params: {
  nodes: NetworkNode[]
  links: NetworkLink[]
  resolved: ResolvedColors
  directed: boolean
}): EChartsOption {
  const { nodes, links, resolved, directed } = params
  const { palette, paletteColors } = resolved

  const maxValue = Math.max(1, ...nodes.map((n) => n.value ?? 1))

  const graphData = nodes.map((n) => {
    const colorIdx = kindColorIndex(n.kind)
    const size = n.value ? 14 + 18 * (n.value / maxValue) : 16
    return {
      id: n.id,
      name: n.name,
      detail: n.detail,
      url: n.clickable ? (n.detail ?? n.id) : undefined,
      symbolSize: size,
      itemStyle: {
        color: paletteColors[colorIdx],
        borderColor: palette.border,
        borderWidth: 1.5,
        shadowBlur: 8,
        shadowColor: `${paletteColors[colorIdx]}44`,
      },
      label: {
        show: true,
        position: "bottom" as const,
        distance: 6,
        color: palette.label,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 10,
        formatter: () => formatLabel(n.name),
      },
    }
  })

  const graphLinks = links.map((l) => {
    const w = l.value ? 1 + Math.min(4, l.value * 0.6) : 1.5
    return {
      source: l.source,
      target: l.target,
      value: l.value ?? 1,
      name: l.name,
      lineStyle: {
        color: palette.muted,
        width: w,
        opacity: 0.35,
        curveness: 0.15 + Math.random() * 0.15,
      },
    }
  })

  return {
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
          const label = (params as { name?: string }).name
          const val = (params as { value?: number }).value
          const valStr = val ? ` (${val.toLocaleString()} accesses)` : ""
          return label
            ? `${label} ${src} → ${tgt}${valStr}`
            : `${src} → ${tgt}${valStr}`
        }
        const data = params.data as
          | { detail?: string; url?: string; name?: string; value?: number }
          | undefined
        const detail = data?.detail ?? data?.name ?? ""
        const val = data?.value
        const lines = [detail]
        if (val) lines.push(`${val.toLocaleString()} accesses`)
        if (data?.url) lines.push("Click to filter")
        return lines.join("<br/>")
      },
    },
    series: [
      {
        type: "graph",
        layout: "force",
        roam: true,
        draggable: true,
        force: {
          repulsion: nodes.length > 30 ? 140 : 100,
          gravity: 0.08,
          edgeLength: nodes.length > 30 ? 70 : 100,
          friction: 0.55,
          layoutAnimation: true,
        },
        data: graphData as unknown as GraphSeriesOption["data"],
        links: graphLinks,
        emphasis: {
          focus: "adjacency",
          itemStyle: { borderWidth: 3, shadowBlur: 16 },
          lineStyle: { opacity: 0.85, width: 3 },
        },
        blur: {
          itemStyle: { opacity: 0.1 },
          lineStyle: { opacity: 0.04 },
        },
        stateAnimation: { duration: 200 },
        edgeSymbol: directed ? ["none", "arrow"] : ["none", "none"],
        edgeSymbolSize: directed ? [0, 7] : [0, 0],
        label: { show: false },
        animationDurationUpdate: 300,
        animationEasingUpdate: "cubicOut",
      } as GraphSeriesOption,
    ],
  }
}

/** Update zoom and center on the existing graph series without restarting
 *  the force layout. Uses default merge mode (no notMerge, no replaceMerge)
 *  so only the listed properties are patched into series[0]. */
function applyView(chart: ECharts, zoom: number) {
  chart.setOption({ series: [{ zoom, center: ["50%", "50%"] }] } as EChartsOption)
}

export function NetworkGraphDiagram({
  nodes,
  links,
  height = 540,
  directed = true,
  onSelectUrl,
  onNodeClick,
  className,
  ariaLabel,
}: {
  nodes: NetworkNode[]
  links: NetworkLink[]
  height?: number
  directed?: boolean
  onSelectUrl?: (url: string) => void
  onNodeClick?: (kind: string, name: string) => void
  className?: string
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const { theme } = useTheme()
  const reduced =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false)

  const resolved = resolveAllColors(theme, undefined)

  const prev = useRef<{ nodes: NetworkNode[]; links: NetworkLink[] } | null>(null)
  const prevPalette = useRef<ResolvedColors["palette"] | null>(null)

  // ── Init: create chart, ensure correct dimensions, then dispose on unmount ──
  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Force a read of the container's layout so ECharts gets correct dimensions.
    // This avoids the race where echarts.init runs before the browser has laid
    // out the flex/grid parent, resulting in a 0-width canvas and all nodes
    // collapsing into the top-left corner.
    void el.offsetWidth

    const chart = echarts.init(el)
    chartRef.current = chart
    prev.current = null
    prevPalette.current = null

    // Resize once after init to pick up any pending layout.
    chart.resize()

    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // ── Data: push new nodes/links into the chart ──────────────────────────
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const contentChanged =
      prev.current === null ||
      !sameNodes(prev.current.nodes, nodes) ||
      !sameLinks(prev.current.links, links)
    const paletteChanged =
      prevPalette.current === null ||
      prevPalette.current.label !== resolved.palette.label ||
      prevPalette.current.muted !== resolved.palette.muted ||
      prevPalette.current.card !== resolved.palette.card ||
      prevPalette.current.border !== resolved.palette.border

    if (!contentChanged && !paletteChanged) return

    prev.current = { nodes, links }
    prevPalette.current = resolved.palette

    // Replace the entire option — this restarts the force simulation.
    chart.setOption(
      buildOption({ nodes, links, resolved, directed }),
      true,
    )

    // After the force layout settles, fit content to the viewport.
    if (contentChanged && nodes.length > 0) {
      const settleTime = reduced ? 0 : 600
      const timer = setTimeout(() => {
        // Ensure the canvas dimensions are still correct after layout.
        chart.resize()
        // Center the graph and zoom to fit.
        applyView(chart, 0.85)
        chart.getZr().flush()
      }, settleTime)
      return () => clearTimeout(timer)
    }
  }, [nodes, links, resolved, reduced, directed])

  // ── Click handler ──────────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const hasHandler = !!onSelectUrl || !!onNodeClick
    if (!hasHandler) return
    const onClick = (params: ECElementEvent) => {
      const data = params.data as
        | { id?: string; url?: string; name?: string; detail?: string }
        | undefined
      if (!data) return
      if (data.url && onSelectUrl) onSelectUrl(data.url)
      if (onNodeClick && data.id) {
        const kind = data.id.startsWith("ip:") ? "ip"
          : data.id.startsWith("url:") ? "url"
          : data.id.startsWith("server:") ? "server"
          : data.id.startsWith("host:") ? "url"
          : "unknown"
        onNodeClick(kind, data.name ?? data.detail ?? data.id)
      }
    }
    chart.on("click", onClick)
    return () => {
      chart.off("click", onClick)
    }
  }, [onSelectUrl, onNodeClick])

  // ── Zoom controls ──────────────────────────────────────────────────────
  const handleZoomIn = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    // Read the current zoom, multiply by 1.4x.
    const opt = chart.getOption() as { series?: { zoom?: number }[] }
    const current = opt.series?.[0]?.zoom ?? 1
    applyView(chart, current * 1.4)
  }, [])

  const handleZoomOut = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    const opt = chart.getOption() as { series?: { zoom?: number }[] }
    const current = opt.series?.[0]?.zoom ?? 1
    applyView(chart, current * 0.7)
  }, [])

  const handleFitView = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    // Reset the entire graph option (re-runs the force simulation) then
    // center + zoom to fit.
    chart.setOption(
      buildOption({ nodes, links, resolved, directed }),
      true,
    )
    chart.getZr().flush()
    const settleTime = reduced ? 0 : 500
    setTimeout(() => {
      chart.resize()
      applyView(chart, 0.85)
      chart.getZr().flush()
    }, settleTime)
  }, [nodes, links, resolved, reduced, directed])

  return (
    <div className="relative">
      <div
        ref={ref}
        role="img"
        aria-label={ariaLabel ?? "Network graph diagram"}
        className={className}
        style={{ width: "100%", height }}
      />
      {/* Zoom controls — bottom-right overlay */}
      <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1">
        <button
          type="button"
          onClick={handleZoomIn}
          aria-label="Zoom in"
          className="inline-flex h-8 w-8 items-center justify-center border-[2.5px] border-[#0A0A0A] bg-card text-muted-foreground brutal-shadow-sm transition-colors hover:bg-secondary hover:text-[#0A0A0A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-[#F6F2E8]"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          aria-label="Zoom out"
          className="inline-flex h-8 w-8 items-center justify-center border-[2.5px] border-[#0A0A0A] bg-card text-muted-foreground brutal-shadow-sm transition-colors hover:bg-secondary hover:text-[#0A0A0A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-[#F6F2E8]"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleFitView}
          aria-label="Reset zoom"
          className="inline-flex h-8 w-8 items-center justify-center border-[2.5px] border-[#0A0A0A] bg-card text-muted-foreground brutal-shadow-sm transition-colors hover:bg-secondary hover:text-[#0A0A0A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-[#F6F2E8]"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
