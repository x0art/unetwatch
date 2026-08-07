import { useEffect, useMemo, useRef } from "react"
// Root import: the modular subpaths (echarts/core, echarts/charts, …) are
// not resolvable under every echarts install / bundler setup, so use the
// full package (which registers the sankey chart + tooltip + canvas by
// default). Cost is a larger bundle; reliability is guaranteed.
import * as echarts from "echarts"
import type { ECharts, EChartsOption, TooltipComponentFormatterCallbackParams } from "echarts"
import { useTheme } from "./Sidebar"

/* ════════════════════════════════════════════════════════════════
 * SankeyDiagram — reusable ECharts Sankey wrapper
 *
 * Renders a layered flow (client IP → server IP → URL, redirect source
 * → final URL, …) as an ECharts sankey/alluvial diagram. The container
 * sizes to its content: height is derived from the number of nodes so
 * a small flow never renders a huge empty box, and the node layers are
 * spread across the available width (no overlap).
 *
 * App colors are oklch() CSS vars, which ECharts can't consume, so the
 * resolved palette is computed at render time from the live CSS values.
 *
 * Chart lifecycle — the two-effect split matters:
 *   • A mount effect creates the ECharts instance ONCE and wires resize
 *     observers; it never re-runs.
 *   • A sync effect pushes option only when the props actually changed
 *     by content. The parent re-renders constantly (the countdown timer
 *     in App re-renders the whole tree once a second, and callers pass
 *     fresh array/object literals every render), and those re-renders
 *     MUST NOT touch the chart. A dispose+init or a notMerge setOption
 *     on identical data restarts the 500ms enter animation, which is
 *     exactly the "blinking" bug. Content is diffed by value here.
 * ════════════════════════════════════════════════════════════════ */

export interface SankeyNode {
  id: string
  name: string
  /** Optional layer index (0,1,2…). Grouped left→right. */
  layer?: number
}

export interface SankeyLink {
  source: string
  target: string
  value: number
}

/* Resolve a `var(--token)` to the live computed color. oklch() values
 * aren't parseable by ECharts, so map the app's semantic tokens to fixed
 * hex equivalents (dark-theme values; the diagram re-renders on theme
 * flip and the fallback keeps it legible in both modes). */
const FALLBACK: Record<string, string> = {
  "--color-info": "#5b8def",
  "--color-warning": "#e8a33d",
  "--color-danger": "#ef6a6a",
  "--color-success": "#4fbf7a",
  "--color-primary": "#5b8def",
  "--color-foreground": "#e8e8ee",
  "--color-muted-foreground": "#a0a0ac",
  "--color-card": "#232331",
  "--color-border": "#3f3f4d",
}

function resolveColor(raw: string): string {
  const m = raw.match(/var\((--[\w-]+)\)/)
  if (!m) return raw
  const live = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim()
  if (live && !live.startsWith("oklch")) return live
  return FALLBACK[m[1]] ?? "#888"
}

/* Content equality for the props that matter. The parent re-renders
 * constantly (countdown ticker, stats refresh) and passes fresh array /
 * object literals; compare by value so those re-renders are no-ops for
 * the chart instead of a rebuild. */
function sameNodes(a: SankeyNode[], b: SankeyNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.name !== y.name || x.layer !== y.layer) return false
  }
  return true
}

function sameLinks(a: SankeyLink[], b: SankeyLink[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.source !== y.source || x.target !== y.target || x.value !== y.value) return false
  }
  return true
}

function sameLayerColors(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/* Derive a diagram height from the largest layer so small graphs stay
 * compact and dense ones grow without clipping. */
function contentHeight(nodes: SankeyNode[], nodeHeight = 18, nodeGap = 12, pad = 40) {
  const byLayer: Record<number, number> = {}
  for (const n of nodes) {
    const layer = n.layer ?? 0
    byLayer[layer] = (byLayer[layer] ?? 0) + 1
  }
  const max = Math.max(1, ...Object.values(byLayer))
  return Math.max(180, Math.min(640, pad + max * nodeHeight + (max - 1) * nodeGap))
}

function buildOption(
  nodes: SankeyNode[],
  links: SankeyLink[],
  layerColors: Record<string, string> | undefined,
  palette: { label: string; muted: string; card: string; border: string },
): EChartsOption {
  /* Sankey layer colors are applied per-node (itemStyle.color on each
   * data item) — a sankey series does NOT accept a per-layer color map
   * on the series `color` option (that's a plain palette array). Without
   * a layerColors prop we fall back to the classic info/warning/danger
   * palette. */
  const paletteColors = [
    resolveColor("var(--color-info)"),
    resolveColor("var(--color-warning)"),
    resolveColor("var(--color-danger)"),
  ]
  const nodeItemStyle =
    layerColors && Object.keys(layerColors).length > 0
      ? (n: SankeyNode) => ({
          color: resolveColor(layerColors[String(n.layer ?? 0)] ?? paletteColors[0]),
        })
      : undefined
  const data = nodes.map((n) => (nodeItemStyle ? { ...n, itemStyle: nodeItemStyle(n) } : n))

  return {
    animationDuration: 500,
    animationEasing: "cubicOut",
    tooltip: {
      trigger: "item",
      triggerOn: "mousemove",
      backgroundColor: palette.card,
      borderColor: palette.border,
      textStyle: { color: palette.label, fontSize: 12 },
      formatter: (params: TooltipComponentFormatterCallbackParams) => {
        const p = Array.isArray(params) ? params[0] : params
        return p.dataType === "edge"
          ? `${p.name} · ${Number(p.value ?? 0).toLocaleString()}`
          : p.name
      },
    },
    series: [
      {
        type: "sankey",
        data,
        links,
        left: 8,
        right: 8,
        top: 12,
        bottom: 12,
        nodeWidth: 14,
        nodeGap: 10,
        layoutIterations: 32,
        emphasis: { focus: "adjacency" },
        lineStyle: {
          color: "gradient",
          curveness: 0.5,
          opacity: 0.45,
        },
        label: {
          color: palette.label,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11,
          position: "right",
          formatter: (p: { name: string }) => (p.name.length > 42 ? `${p.name.slice(0, 41)}…` : p.name),
        },
        itemStyle: {
          borderColor: palette.border,
          borderWidth: 1,
          opacity: 0.92,
        },
        color: paletteColors,
      },
    ],
  }
}

export function SankeyDiagram({
  nodes,
  links,
  layerColors,
  height,
  className,
  ariaLabel,
}: {
  nodes: SankeyNode[]
  links: SankeyLink[]
  /** Per-layer color: key = layer index, value = CSS var or color. */
  layerColors?: Record<string, string>
  /** Fixed height (px). Defaults to content-derived height. */
  height?: number
  className?: string
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const { theme } = useTheme()
  const h = height ?? contentHeight(nodes)

  const palette = useMemo(
    () => ({
      label: resolveColor("var(--color-foreground)"),
      muted: resolveColor("var(--color-muted-foreground)"),
      card: resolveColor("var(--color-card)"),
      border: resolveColor("var(--color-border)"),
    }),
    // Re-resolve on theme flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme],
  )

  /* Create the chart once. Cleanup disposes it on unmount only — this
   * effect has no props in its deps, so parent re-renders never touch
   * the instance. */
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

  /* Push option only when the content actually changed. The parent may
   * re-render every second with identical data (fresh literals); those
   * renders must not re-run setOption, because notMerge on identical
   * data restarts the enter animation → the diagram blinks. */
  const prevNodes = useRef<SankeyNode[] | null>(null)
  const prevLinks = useRef<SankeyLink[] | null>(null)
  const prevLayerColors = useRef<Record<string, string> | undefined>(undefined)
  const prevPalette = useRef(palette)

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const contentChanged =
      prevNodes.current === null ||
      !sameNodes(prevNodes.current, nodes) ||
      !sameLinks(prevLinks.current ?? [], links) ||
      !sameLayerColors(prevLayerColors.current, layerColors)
    const paletteChanged = prevPalette.current !== palette

    if (!contentChanged && !paletteChanged) {
      // Parent re-render with identical data/palette — nothing to do.
      return
    }

    prevNodes.current = nodes
    prevLinks.current = links
    prevLayerColors.current = layerColors
    prevPalette.current = palette

    chart.setOption(buildOption(nodes, links, layerColors, palette), contentChanged)
    chart.resize()
  }, [nodes, links, layerColors, palette, h])

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel ?? "Sankey flow diagram"}
      className={className}
      style={{ width: "100%", height: h }}
    />
  )
}
