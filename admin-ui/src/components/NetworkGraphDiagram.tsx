import { useEffect, useRef } from "react"
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
import { resolveAllColors, type ResolvedColors } from "./SankeyDiagram"

echarts.use([GraphChart, TooltipComponent, CanvasRenderer])

const MAX_LABEL = 36

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

export interface NetworkNode {
  id: string
  name: string
  /** Node kind for coloring (e.g. "ip", "server", "url", "destination"). */
  kind?: string
  /** Full detail shown in tooltip. */
  detail?: string
  /** Numeric value for sizing. */
  value?: number
  /** Whether clicking this node triggers a callback. */
  clickable?: boolean
}

export interface NetworkLink {
  source: string
  target: string
  value?: number
  /** Optional edge label (e.g. HTTP status code). */
  name?: string
}

function sameNodes(a: NetworkNode[], b: NetworkNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.kind !== y.kind ||
      x.detail !== y.detail ||
      x.value !== y.value ||
      x.clickable !== y.clickable
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

/** Map a node kind to a palette color index. */
function kindColorIndex(kind: string | undefined): number {
  switch (kind) {
    case "ip":
      return 0 // info (blue)
    case "server":
      return 1 // warning (amber)
    case "url":
    case "destination":
      return 2 // danger (red)
    default:
      return 0
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
      itemStyle: {
        color: paletteColors[colorIdx],
        borderColor: palette.border,
        borderWidth: 1.5,
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
    const w = l.value ? 1 + Math.min(3, l.value * 0.5) : 1.5
    return {
      source: l.source,
      target: l.target,
      value: l.value ?? 1,
      name: l.name,
      lineStyle: {
        color: palette.muted,
        width: w,
        opacity: 0.4,
        curveness: 0.2,
      },
    }
  })

  return {
    // No enter animation: the first paint must not depend on
    // requestAnimationFrame ticks (stalled rAF in embedded webviews / hidden
    // tabs leaves the chart blank forever).
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
          return label ? `${label} ${src} → ${tgt}` : `${src} → ${tgt}`
        }
        const data = params.data as
          | { detail?: string; url?: string; name?: string }
          | undefined
        const detail = data?.detail ?? data?.name ?? ""
        if (data?.url) return `${detail}<br/>Click to filter`
        return detail
      },
    },
    series: [
      {
        type: "graph",
        layout: "force",
        roam: true,
        draggable: true,
        force: {
          repulsion: nodes.length > 30 ? 120 : 80,
          gravity: 0.1,
          edgeLength: nodes.length > 30 ? 60 : 80,
          friction: 0.6,
          layoutAnimation: !reduced,
        },
        data: graphData as unknown as GraphSeriesOption["data"],
        links: graphLinks,
        emphasis: {
          // Use adjacency focus: ECharts natively highlights the hovered node
          // and its direct neighbors, dimming everything else. No need to
          // rebuild the option on every mouse event.
          focus: "adjacency",
          itemStyle: { borderWidth: 2.5 },
          lineStyle: { opacity: 0.8 },
        },
        blur: {
          itemStyle: { opacity: 0.12 },
          lineStyle: { opacity: 0.05 },
        },
        // State changes snap; only data-change animation runs (cheap hover).
        stateAnimation: { duration: 0 },
        edgeSymbol: directed ? ["none", "arrow"] : ["none", "none"],
        edgeSymbolSize: directed ? [0, 6] : [0, 0],
        label: { show: false },
      },
    ],
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
  /** Whether edges have arrows (directed graph). Default true. */
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

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel ?? "Network graph diagram"}
      className={className}
      style={{ width: "100%", height }}
    />
  )
}
