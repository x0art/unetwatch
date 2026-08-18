import { useEffect, useRef } from "react"
import * as echarts from "echarts/core"
import { SankeyChart } from "echarts/charts"
import { TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type { ECharts, EChartsOption, TooltipComponentFormatterCallbackParams } from "echarts"
import { useTheme } from "./Sidebar"

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer])

export interface SankeyNode {
  id: string
  name: string
  /** Optional layer index (0,1,2…). Grouped left→right. */
  layer?: number
  /** Optional full detail shown in the tooltip (e.g. the full URL behind a host-only label). */
  detail?: string
}

export interface SankeyLink {
  source: string
  target: string
  value: number
  /** Optional edge label shown in the tooltip (e.g. "302 →"). */
  name?: string
}

// Fallbacks used only when the live token can't be read or parsed (e.g. a
// headless/jsdom render). They must match the THEME they belong to — the
// production CSS minifier rewrites `oklch(0.47 0.13 235)` to the shorter
// `oklch(47% .13 235)`, which older parsing missed and silently fell back to
// the dark palette, leaving light-mode diagrams with light text on white.
const FALLBACK_DARK: Record<string, string> = {
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

const FALLBACK_LIGHT: Record<string, string> = {
  "--color-info": "#006398",
  "--color-warning": "#8A5700",
  "--color-danger": "#C10000",
  "--color-success": "#006C15",
  "--color-primary": "#006398",
  "--color-foreground": "#070B14",
  "--color-muted-foreground": "#454E5B",
  "--color-card": "#FFFFFF",
  "--color-border": "#D0D4DB",
}

/** Parse an oklch() light/color/hue triple. Accepts both the decimal form
 * browsers serialize in dev (`oklch(0.47 0.13 235)`) and the percentage
 * form the production CSS minifier emits (`oklch(47% .13 235)`); hue may
 * carry an optional `deg` suffix. Any trailing `/ alpha` is ignored. */
function parseOklch(input: string): [number, number, number] | null {
  const m = input.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?/)
  if (!m) return null
  const num = (s: string) => (s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s))
  return [num(m[1]), num(m[2]), Number(m[3])]
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

function resolveColor(raw: string, fallback: Record<string, string>): string {
  const m = raw.match(/var\((--[\w-]+)\)/)
  if (!m) return raw
  const token = m[1]
  const live = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  if (!live) return fallback[token] ?? "#888"

  if (live.startsWith("oklch")) {
    const parsed = parseOklch(live)
    if (parsed) return oklchToSrgb(parsed[0], parsed[1], parsed[2])
    return fallback[token] ?? "#888"
  }
  // Not oklch — a plain hex/rgb/named color passes straight through.
  return live
}

function sameNodes(a: SankeyNode[], b: SankeyNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.name !== y.name || x.layer !== y.layer) return false
    if (x.detail !== y.detail) return false
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

function contentHeight(nodes: SankeyNode[], nodeHeight = 30, nodeGap = 16, pad = 44) {
  const byLayer: Record<number, number> = {}
  for (const n of nodes) {
    const layer = n.layer ?? 0
    byLayer[layer] = (byLayer[layer] ?? 0) + 1
  }
  const counts = Object.values(byLayer)
  const maxLayerNodes = Math.max(1, ...counts)
  const numLayers = Math.max(1, counts.length)
  // Height must fit the densest layer *and* give every layer vertical room:
  // dense layers drive per-node height, and more layers add inter-layer gap.
  const nodesSpace = maxLayerNodes * nodeHeight + (maxLayerNodes - 1) * nodeGap
  const layersSpace = (numLayers - 1) * 12
  return Math.max(240, Math.min(720, pad + nodesSpace + layersSpace))
}

const MAX_LABEL = 60

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

export interface ResolvedColors {
  palette: { label: string; muted: string; card: string; border: string }
  paletteColors: string[]
  /** Layer index → resolved color (from the layerColors CSS vars). */
  nodeColors: Record<string, string>
}

// getComputedStyle forces a style recalc, so resolved tokens are cached per
// (theme, layerColors) key — the expensive lookups only re-run when the theme
// or a layer color actually changes. The theme class is applied synchronously
// by ThemeProvider before this render commits, so the cached values are always
// the authoritative ones for the active theme.
const _resolvedColorsCache = new Map<string, ResolvedColors>()

export function resolveAllColors(
  theme: string,
  layerColors: Record<string, string> | undefined,
): ResolvedColors {
  const key = `${theme}|${JSON.stringify(layerColors ?? {})}`
  const cached = _resolvedColorsCache.get(key)
  if (cached) return cached
  // Fallbacks are theme-matched so an unreadable/unparseable token never
  // paints dark-theme text onto the light-theme card (and vice versa).
  const fallback = theme === "light" ? FALLBACK_LIGHT : FALLBACK_DARK
  const value: ResolvedColors = {
    palette: {
      label: resolveColor("var(--color-foreground)", fallback),
      muted: resolveColor("var(--color-muted-foreground)", fallback),
      card: resolveColor("var(--color-card)", fallback),
      border: resolveColor("var(--color-border)", fallback),
    },
    paletteColors: [
      resolveColor("var(--color-info)", fallback),
      resolveColor("var(--color-warning)", fallback),
      resolveColor("var(--color-danger)", fallback),
    ],
    nodeColors: Object.fromEntries(
      Object.entries(layerColors ?? {}).map(([layer, raw]) => [layer, resolveColor(raw, fallback)]),
    ),
  }
  _resolvedColorsCache.set(key, value)
  return value
}

function buildOption(
  nodes: SankeyNode[],
  links: SankeyLink[],
  layerColors: Record<string, string> | undefined,
  resolved: ResolvedColors,
  layoutIterations: number,
): EChartsOption {
  const { palette, paletteColors, nodeColors } = resolved
  const nodeItemStyle =
    layerColors && Object.keys(layerColors).length > 0
      ? (n: SankeyNode) => ({
          color: nodeColors[String(n.layer ?? 0)] ?? paletteColors[0],
        })
      : undefined
  const maxLayer = nodes.reduce((m, n) => Math.max(m, n.layer ?? 0), 0)
  const layerCounts: Record<number, number> = {}
  for (const n of nodes) {
    const layer = n.layer ?? 0
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1
  }
  const maxLayerNodes = Math.max(1, ...Object.values(layerCounts))
  // Give packed layers more breathing room so adjacent nodes don't collide.
  const nodeGap = maxLayerNodes > 14 ? 20 : maxLayerNodes > 8 ? 18 : 16
  // ECharts' sankey `nodeAlign: 'justify'` pushes every node without outgoing
  // edges (sinks) into the last column regardless of its layer, so the last
  // column holds both `maxLayer` nodes AND all sinks. Flip those labels to the
  // left too — otherwise short chains end up with right-side text sitting next
  // to left-side text in the same (rightmost) column.
  const hasOutgoing = new Set(links.map((l) => l.source))
  const isLastColumn = (n: SankeyNode) =>
    (n.layer ?? 0) === maxLayer || !hasOutgoing.has(n.id)
  const data = nodes.map((n) => {
    const item: (SankeyNode & { itemStyle?: { color: string }; label?: { position: "left" } }) = {
      ...n,
      ...(nodeItemStyle ? { itemStyle: nodeItemStyle(n) } : {}),
      ...(isLastColumn(n) ? { label: { position: "left" } } : {}),
    }
    return item
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
      formatter: (params: TooltipComponentFormatterCallbackParams) => {
        const p = Array.isArray(params) ? params[0] : params
        if (p.dataType === "edge") {
          const src = (p as { source?: string }).source ?? ""
          const tgt = (p as { target?: string }).target ?? ""
          if (p.name) return `${p.name} ${src} → ${tgt}`
          return src ? `${src} → ${tgt}` : p.name
        }
        // Node: prefer the full detail (e.g. the URL behind a host-only label).
        const nodeDetail = (p.data as SankeyNode | undefined)?.detail
        return nodeDetail ?? p.name
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
        nodeGap,
        layoutIterations,
        emphasis: { focus: "adjacency" },
        // Default stateAnimation duration is 300ms, which animates the
        // emphasis/blur state of EVERY node+link on each hover — laggy on big
        // graphs. Snap state transitions to 0ms; data-change animation stays.
        stateAnimation: { duration: 0 },
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

  // Resolve every theme token once per (theme, layerColors) — see the
  // resolveAllColors cache above; the getComputedStyle calls never re-run for
  // an unchanged theme or layer set.
  const resolved = resolveAllColors(theme, layerColors)

  // Sankey layout is ~O(iterations × nodes²) — scale iterations down on big
  // graphs so hover/resize stays responsive without visible layout change.
  const layoutIterations = nodes.length > 60 ? 8 : nodes.length > 30 ? 12 : 16

  // Last-pushed content, used to skip no-op re-renders. Reset whenever a
  // fresh chart instance is created (see the init effect below): React
  // StrictMode in dev mounts → unmounts → remounts, and the remounted chart
  // must receive its option even though the data is unchanged — otherwise
  // the new instance stays blank forever.
  const prevNodes = useRef<SankeyNode[] | null>(null)
  const prevLinks = useRef<SankeyLink[] | null>(null)
  const prevLayerColors = useRef<Record<string, string> | undefined>(undefined)
  const prevPalette = useRef<{
    label: string
    muted: string
    card: string
    border: string
  } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart
    // A brand-new instance has never received an option — make the data
    // effect below push one regardless of the unchanged-data guard.
    prevNodes.current = null
    prevLinks.current = null
    prevLayerColors.current = undefined
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

    // Colors come from the theme-keyed memo above (theme class is applied
    // synchronously, so the memo is authoritative); the paletteChanged diff
    // below still guards against a no-op re-render with identical values.
    const resolvedPalette = resolved.palette
    const paletteChanged =
      prevPalette.current === null ||
      resolvedPalette.label !== prevPalette.current.label ||
      resolvedPalette.muted !== prevPalette.current.muted ||
      resolvedPalette.card !== prevPalette.current.card ||
      resolvedPalette.border !== prevPalette.current.border

    const contentChanged =
      prevNodes.current === null ||
      !sameNodes(prevNodes.current, nodes) ||
      !sameLinks(prevLinks.current ?? [], links) ||
      !sameLayerColors(prevLayerColors.current, layerColors)

    if (!contentChanged && !paletteChanged) {
      // Parent re-render with identical data/palette — nothing to do.
      return
    }

    prevNodes.current = nodes
    prevLinks.current = links
    prevLayerColors.current = layerColors
    prevPalette.current = resolvedPalette

    chart.setOption(
      buildOption(nodes, links, layerColors, resolved, layoutIterations),
      contentChanged,
    )
    chart.resize()
  }, [nodes, links, layerColors, theme, h, resolved, layoutIterations])

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
