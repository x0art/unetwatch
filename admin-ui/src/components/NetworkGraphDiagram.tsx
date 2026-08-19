import { useCallback, useEffect, useRef } from "react"
import * as echarts from "echarts/core"
import { GraphChart, EffectScatterChart } from "echarts/charts"
import type { GraphSeriesOption, EffectScatterSeriesOption } from "echarts/charts"
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

echarts.use([GraphChart, EffectScatterChart, TooltipComponent, CanvasRenderer])

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
  reduced: boolean
  directed: boolean
}): EChartsOption {
  const { nodes, links, resolved, reduced, directed } = params
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
      x: 0,
      y: 0,
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

  const glowNodes = nodes
    .filter((n) => (n.value ?? 0) > maxValue * 0.4)
    .map((n) => {
      const colorIdx = kindColorIndex(n.kind)
      return {
        id: `glow:${n.id}`,
        name: n.name,
        symbolSize: (n.value ? 14 + 18 * (n.value / maxValue) : 16) + 12,
        itemStyle: {
          color: paletteColors[colorIdx],
          opacity: 0.15,
        },
      }
    })

  const series: (GraphSeriesOption | EffectScatterSeriesOption)[] = [
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
        layoutAnimation: !reduced,
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
    },
  ]

  if (!reduced && glowNodes.length > 0) {
    series.push({
      type: "effectScatter",
      z: 0,
      silent: true,
      coordinateSystem: undefined as never,
      data: glowNodes as unknown as EffectScatterSeriesOption["data"],
      rippleEffect: {
        brushType: "stroke",
        scale: 3,
        period: 5,
      },
      label: { show: false },
    } as EffectScatterSeriesOption)
  }

  return {
    animation: false,
    animationDuration: 0,
    animationEasing: "cubicOut",
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
    series,
  }
}

export function NetworkGraphDiagram({
  nodes,
  links,
  height = 540,
  directed = true,
  onSelectUrl,
  className,
  ariaLabel,
}: {
  nodes: NetworkNode[]
  links: NetworkLink[]
  height?: number
  directed?: boolean
  onSelectUrl?: (url: string) => void
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

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    prev.current = null
    prevPalette.current = null

    const onResize = () => chart.resize()
    const onWindowResize = () => onResize()
    window.addEventListener("resize", onWindowResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(el)

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

    chart.setOption(
      buildOption({ nodes, links, resolved, reduced, directed }),
      true,
    )
    chart.getZr().flush()
  }, [nodes, links, resolved, reduced, directed])

  // Click a URL node → let the parent filter the table.
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

  const handleZoomIn = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.dispatchAction({ type: "graphRoam", zoom: 1.3 })
  }, [])

  const handleZoomOut = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.dispatchAction({ type: "graphRoam", zoom: 0.77 })
  }, [])

  const handleFitView = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    // Reset to the original option which resets the zoom/pan state.
    chart.setOption(
      buildOption({ nodes, links, resolved, reduced, directed }),
      true,
    )
    chart.getZr().flush()
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
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          aria-label="Zoom out"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleFitView}
          aria-label="Reset zoom"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
