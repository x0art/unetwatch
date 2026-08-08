import { useEffect, useMemo, useRef } from "react"
// Modular echarts: import only the sankey chart, the tooltip component and
// the canvas renderer instead of the full bundle. This keeps the shared
// chunk small — the full "echarts" root import was pulling in every chart
// type and pushing the bundle over the warning threshold.
import * as echarts from "echarts/core"
import { SankeyChart } from "echarts/charts"
import { TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type { ECharts, EChartsOption, TooltipComponentFormatterCallbackParams } from "echarts"
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
 * App colors are oklch() CSS vars, which ECharts' canvas renderer can't
 * parse. They are converted to sRGB here with the standard OKLab → sRGB
 * math (Björn Ottosson, as used by CSS Color 4) — pure functions, no DOM
 * access, so it's safe to call from render.
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
  /** Optional edge label shown in the tooltip (e.g. "302 →"). */
  name?: string
}

/* Static fallback palette (dark theme). Used when the live CSS token is
 * not a parseable oklch()/color(). Kept legible on dark surfaces. */
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

/* ── oklch() → sRGB ─────────────────────────────────────────────
 * ECharts' canvas renderer (zrender) cannot parse oklch()/color()
 * strings, and browsers serialize computed colors as oklch() in modern
 * engines — so a getComputedStyle-based "probe" returns oklch back and
 * the chart fails to render. Convert numerically instead.
 *
 * The math is the standard OKLab → sRGB (Björn Ottosson, CSS Color 4):
 *   OKLab → LMS (cube-root encoded) → cube → linear LMS → linear sRGB
 *   → gamma-encoded sRGB. The cube step is critical: without it the
 *   values stay in the compressed cube-root space and dark colors come
 *   out far too light.
 * ────────────────────────────────────────────────────────────────── */

function parseOklch(input: string): [number, number, number] | null {
  const m = input.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function oklchToSrgb(L: number, C: number, Hdeg: number): string {
  const H = (Hdeg * Math.PI) / 180
  const a = C * Math.cos(H)
  const b = C * Math.sin(H)

  // OKLab → LMS (cube-root encoded)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  // Cube → linear LMS
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  // linear LMS → linear sRGB
  const r_lin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g_lin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b_lin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  // linear → gamma sRGB
  const lin = (c: number) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c)
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(lin(v) * 255)))
  return `rgb(${clamp(r_lin)}, ${clamp(g_lin)}, ${clamp(b_lin)})`
}

/* Resolve a `var(--token)` to a color ECharts can consume. Reads the
 * live CSS custom property (theme-aware) and converts oklch → sRGB.
 * Pure function — safe to call during render. */
function resolveColor(raw: string): string {
  const m = raw.match(/var\((--[\w-]+)\)/)
  if (!m) return raw
  const token = m[1]
  const live = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  if (!live) return FALLBACK[token] ?? "#888"

  if (live.startsWith("oklch")) {
    const parsed = parseOklch(live)
    if (parsed) return oklchToSrgb(parsed[0], parsed[1], parsed[2])
    return FALLBACK[token] ?? "#888"
  }
  // Not oklch — a plain hex/rgb/named color passes straight through.
  return live
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

/* Derive a diagram height from the largest layer. The height is the
 * main lever for readable nodes: ECharts sizes sankey node heights
 * proportional to their value share of the chart, so when a layer has
 * few nodes a short container shrinks each node until the 11px label
 * text no longer fits. Keep a generous minimum and a roomy per-node
 * budget so even a handful of connections renders labels at full size. */
function contentHeight(nodes: SankeyNode[], nodeHeight = 30, nodeGap = 16, pad = 44) {
  const byLayer: Record<number, number> = {}
  for (const n of nodes) {
    const layer = n.layer ?? 0
    byLayer[layer] = (byLayer[layer] ?? 0) + 1
  }
  const max = Math.max(1, ...Object.values(byLayer))
  return Math.max(240, Math.min(700, pad + max * nodeHeight + (max - 1) * nodeGap))
}

/* Label formatting. Long names are truncated to keep the diagram tidy;
 * the truncation is a pure function, so it's safe during render. */
const MAX_LABEL = 42

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
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
  /* Last layer: labels point LEFT into the chart (per-node label
   * override) so the diagram uses the full container width. The widest
   * last-layer label no longer needs to be reserved as `right` margin.
   * Other layers inherit the series-level `position: "right"`. */
  const maxLayer = nodes.reduce((m, n) => Math.max(m, n.layer ?? 0), 0)
  const data = nodes.map((n) => {
    const item: (SankeyNode & { itemStyle?: { color: string }; label?: { position: "left" } }) = {
      ...n,
      ...(nodeItemStyle ? { itemStyle: nodeItemStyle(n) } : {}),
      ...((n.layer ?? 0) === maxLayer ? { label: { position: "left" } } : {}),
    }
    return item
  })

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
        if (p.dataType === "edge") {
          // Redirect hops carry a "302 →" style name; fall back to
          // "source → target" when no name is set. Sankey edges expose
          // source/target at runtime even though the base param type
          // doesn't declare them.
          const src = (p as { source?: string }).source ?? ""
          const tgt = (p as { target?: string }).target ?? ""
          if (p.name) return `${p.name} ${src} → ${tgt}`
          return src ? `${src} → ${tgt}` : p.name
        }
        return p.name
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
        nodeWidth: 16,
        nodeGap: 16,
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
          // Default position for non-last-layer nodes; last-layer nodes
          // override this to "left" via their per-node `label`.
          position: "right",
          formatter: (p: { name: string }) => formatLabel(p.name),
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
