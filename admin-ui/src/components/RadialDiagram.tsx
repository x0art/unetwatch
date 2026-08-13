import { useEffect, useMemo, useRef } from "react"
import * as echarts from "echarts/core"
import { GraphChart, LinesChart } from "echarts/charts"
import type { GraphSeriesOption, LinesSeriesOption } from "echarts/charts"
import { GridComponent, TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type {
  ECharts,
  EChartsOption,
  ECElementEvent,
  TooltipComponentFormatterCallbackParams,
} from "echarts"
import { useTheme } from "./Sidebar"
import { resolveAllColors, type ResolvedColors } from "./SankeyDiagram"
import type { ClientUrlCount } from "../api"

echarts.use([GraphChart, LinesChart, GridComponent, TooltipComponent, CanvasRenderer])

const MAX_LABEL = 40

/** Strip a URL down to its host (FQDN) for the satellite label. */
function shortHost(url: string): string {
  const afterScheme = url.split("://").pop() ?? url
  return afterScheme.split(/[/?#]/)[0] || url
}

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

interface RadialNode {
  id: string
  name: string
  url: string
  count: number
  x: number
  y: number
  symbolSize: number
}

/** Deterministic radial coordinates: hub at (50,50), satellites on a circle
 * of radius R in a hidden 0-100 × 0-100 cartesian grid, sorted by count desc
 * so the biggest URL sits at 12 o'clock. Fixed positions mean no force
 * simulation, no jitter, and no re-layout on identical data. */
function layout(urls: ClientUrlCount[]): { nodes: RadialNode[]; center: [number, number] } {
  const sorted = [...urls].sort((a, b) => b.count - a.count)
  const max = Math.max(1, ...sorted.map((u) => u.count))
  const center: [number, number] = [50, 50]
  const R = 40
  const nodes: RadialNode[] = sorted.map((u, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(1, sorted.length) - Math.PI / 2
    return {
      id: `url:${u.url}`,
      name: shortHost(u.url),
      url: u.url,
      count: u.count,
      x: center[0] + R * Math.cos(angle),
      y: center[1] + R * Math.sin(angle),
      symbolSize: 12 + 16 * (u.count / max),
    }
  })
  return { nodes, center }
}

function buildOption(params: {
  clientIp: string
  totalAccesses: number
  nodes: RadialNode[]
  center: [number, number]
  resolved: ResolvedColors
  reduced: boolean
}): EChartsOption {
  const { clientIp, totalAccesses, nodes, center, resolved, reduced } = params
  const { palette, paletteColors } = resolved
  const hubColor = paletteColors[0] // info
  const urlColor = paletteColors[2] // danger
  const maxCount = Math.max(1, ...nodes.map((n) => n.count))

  // Structural type: ECharts graph data items accept arbitrary extra fields
  // (used here for the click-to-filter URL), but GraphNodeItemOption isn't
  // exported from echarts/charts — this local shape is structurally checked
  // when assigned into the series option below.
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
  const graphData: GraphDataItem[] = [
    {
      id: "hub",
      name: clientIp,
      x: center[0],
      y: center[1],
      fixed: true,
      symbolSize: 52,
      itemStyle: { color: hubColor, borderColor: palette.border, borderWidth: 2 },
      label: {
        show: true,
        position: "bottom",
        distance: 8,
        color: palette.label,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 12,
        formatter: `${clientIp}\n${totalAccesses.toLocaleString()} accesses`,
      },
    },
    ...nodes.map((n) => ({
      id: n.id,
      name: n.name,
      url: n.url,
      x: n.x,
      y: n.y,
      fixed: true,
      symbolSize: n.symbolSize,
      itemStyle: { color: urlColor, borderColor: palette.border, borderWidth: 1 },
      label: {
        show: true,
        position: "outside",
        distance: 6,
        color: palette.label,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 10,
        formatter: () => formatLabel(n.name),
      },
    })),
  ]

  // Static connection lines — thickness + opacity scale with the count.
  const links = nodes.map((n) => ({
    source: "hub",
    target: n.id,
    value: n.count,
    lineStyle: {
      width: 1 + 4 * (n.count / maxCount),
      opacity: 0.4 + 0.5 * (n.count / maxCount),
      color: urlColor,
    },
  }))

  // Animated flow-trail overlay: invisible line, moving symbol only.
  const trailData = nodes.map((n) => ({
    coords: [center, [n.x, n.y]] as [number, number][],
  }))

  // Typed explicitly: the graph + lines series have disjoint option shapes,
  // so the array literal won't unify to a single SeriesOption on its own.
  const series: (GraphSeriesOption | LinesSeriesOption)[] = [
    {
      type: "graph",
      // Deliberately NO `coordinateSystem: "cartesian2d"`: a graph series on
      // cartesian2d defers its first paint to the rAF frame loop, so a stalled
      // rAF (embedded webviews, backgrounded tabs, power-save) leaves the chart
      // blank forever. Without it the graph maps x/y (0-100) onto its own view
      // coordinate system and renders synchronously.
      layout: "none",
      // graphData carries an extra `url` field (used for click-to-filter) and
      // label `position` values ECharts' LabelOption union types reject, so
      // the shape is verified structurally above and narrowed at the edge.
      data: graphData as unknown as GraphSeriesOption["data"],
      links,
      roam: false,
      draggable: false,
      emphasis: { focus: "adjacency" },
      // State changes snap; only data-change animation runs (cheap hover).
      stateAnimation: { duration: 0 },
      lineStyle: { color: "gradient", curveness: 0.15 },
      edgeSymbol: ["none", "arrow"],
      edgeSymbolSize: [0, 6],
      label: { show: false },
    },
    {
      type: "lines",
      // Same dead-rAF rationale as the graph series above — no cartesian2d.
      z: 3,
      silent: true,
      data: trailData,
      effect: reduced
        ? { show: false }
        : {
            show: true,
            period: 3.5,
            trailLength: 0.35,
            symbol: "circle",
            symbolSize: 3.5,
            color: urlColor,
          },
      lineStyle: { opacity: 0, width: 0 },
    },
  ]

  return {
    // No enter/update animation: the first paint must not depend on
    // requestAnimationFrame ticks. When rAF is stalled (embedded webviews,
    // backgrounded tabs, power-save) the intro animation never progresses
    // and the chart stays blank. The trails effect still animates where rAF
    // works.
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
        const data = params.data as
          | { url?: string; name?: string; value?: number }
          | undefined
        if (data?.url) return `${data.url}<br/>${Number(data.value ?? 0).toLocaleString()} accesses`
        return data?.name ?? ""
      },
    },
    series,
  }
}

export function RadialDiagram({
  clientIp,
  totalAccesses,
  urls,
  height = 540,
  onSelectUrl,
  className,
  ariaLabel,
}: {
  clientIp: string
  totalAccesses: number
  urls: ClientUrlCount[]
  height?: number
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
  const { nodes, center } = useMemo(() => layout(urls), [urls])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart

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

  const prev = useRef<{ clientIp: string; nodes: RadialNode[] } | null>(null)
  const prevPalette = useRef<ResolvedColors["palette"] | null>(null)

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const sameNodes = (a: RadialNode[], b: RadialNode[]) =>
      a.length === b.length &&
      a.every(
        (n, i) =>
          n.id === b[i].id &&
          n.count === b[i].count &&
          n.x === b[i].x &&
          n.y === b[i].y,
      )
    const contentChanged =
      prev.current === null ||
      prev.current.clientIp !== clientIp ||
      !sameNodes(prev.current.nodes, nodes)
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

    prev.current = { clientIp, nodes }
    prevPalette.current = resolved.palette

    chart.setOption(
      buildOption({ clientIp, totalAccesses, nodes, center, resolved, reduced }),
      contentChanged,
    )
    // Force a synchronous zrender flush. Without it the first paint is
    // scheduled on the next rAF frame, so a stalled rAF (embedded webviews,
    // backgrounded tabs, power-save) leaves the chart blank forever — the
    // animation-off flag above is not enough because zrender still defers the
    // initial render to its frame loop.
    chart.getZr().flush()
    chart.resize()
  }, [clientIp, totalAccesses, nodes, center, resolved, reduced])

  // Click a URL node → let GraphPage filter the flows table.
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
      aria-label={ariaLabel ?? `URL access radial for ${clientIp}`}
      className={className}
      style={{ width: "100%", height }}
    />
  )
}
