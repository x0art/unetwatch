import { useEffect, useMemo, useRef } from "react"
import * as echarts from "echarts/core"
import { SankeyChart } from "echarts/charts"
import { TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import { useTheme } from "./Sidebar"

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer])

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

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)

    const colors = layerColors
      ? Object.fromEntries(Object.entries(layerColors).map(([k, c]) => [k, resolveColor(c)]))
      : undefined

    chart.setOption(
      {
        animationDuration: 500,
        animationEasing: "cubicOut",
        tooltip: {
          trigger: "item",
          triggerOn: "mousemove",
          backgroundColor: palette.card,
          borderColor: palette.border,
          textStyle: { color: palette.label, fontSize: 12 },
          formatter: (p: { dataType: string; name: string; value: number }) =>
            p.dataType === "edge"
              ? `${p.name} · ${p.value.toLocaleString()}`
              : p.name,
        },
        series: [
          {
            type: "sankey",
            data: nodes,
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
            },
            dataOpacity: 0.92,
            color: colors ?? [
              resolveColor("var(--color-info)"),
              resolveColor("var(--color-warning)"),
              resolveColor("var(--color-danger)"),
            ],
          },
        ],
      },
      true,
    )

    const onResize = () => chart.resize()
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      chart.dispose()
    }
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
