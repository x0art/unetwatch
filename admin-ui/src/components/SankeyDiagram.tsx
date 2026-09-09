import { useEffect, useRef } from "react"
import * as echarts from "echarts/core"
import { SankeyChart } from "echarts/charts"
import { TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type {
  ECharts,
  EChartsOption,
  ECElementEvent,
  TooltipComponentFormatterCallbackParams,
} from "echarts"
import { useTheme } from "./Sidebar"
import type { SankeyNode, SankeyLink } from "../types/sankey"
import { resolveAllColors } from "../lib/echartsTheme"
import type { ResolvedColors } from "../lib/echartsTheme"

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer])

// Re-export shared types and the shared theme resolver so existing
// `from "./SankeyDiagram"` imports keep working unchanged.
export type { SankeyNode, SankeyLink } from "../types/sankey"
export {
  FALLBACK_DARK,
  FALLBACK_LIGHT,
  parseOklch,
  oklchToSrgb,
  resolveColor,
  resolveAllColors,
  type ResolvedColors,
} from "../lib/echartsTheme"

/** Neobrutalist palette — ink/paper/hazard on the flow columns.
 * Column order: 0 Patterns · 1 Sources (client IPs) · 2 URLs · 3 Destinations.
 * Layer 2 is the requested URL (not the collapsed host), and it carries no
 * ALLOW/DENY verdict color — action on a domain is noise for tracing what a
 * client reached. Destinations keep their high-risk red only.
 */
export const LAYER_COLORS: Record<number, string> = {
  0: "#6B6560", // Patterns — muted slate
  1: "#0A7AFF", // Sources — info blue
  2: "#0A0A0A", // URLs — neutral ink (no action coloring)
  3: "#9A9590", // Destinations — muted; high-risk override hazard red
}

/** Layer color resolved for the active theme. LAYER_COLORS holds the
 * light-mode hexes; dark mode swaps the two hexes that vanish on the ink
 * background (#0A0A0A URLs) or read too dim (#6B6560 patterns). */
function layerColor(layer: number, isDark: boolean): string {
  if (isDark) {
    switch (layer) {
      case 0: return "#9A9590" // Patterns — lighter than muted on dark
      case 2: return "#F6F2E8" // URLs — paper on ink bg
      default: return LAYER_COLORS[layer]
    }
  }
  return LAYER_COLORS[layer]
}

function destColor(isHighRisk?: boolean, isDark?: boolean): string {
  return isHighRisk ? "#FF3B30" : isDark ? "#D4CFC5" : "#9A9590"
}

function stripSankeyPrefix(id: string): string {
  return id.replace(/^(stub:)?(src|pat|dom|dst|ip|base):/, "")
}

function displayNameForId(id: string, lookup?: Map<string, string>): string {
  if (lookup?.has(id)) return lookup.get(id)!
  return stripSankeyPrefix(id)
}

/** Walk `links` from `start`, traversing only in the given direction, and
 * return every node reached along a single connected run of that direction.
 * Unlike an undirected flood-fill, this never crosses an earlier layer that a
 * node does not actually touch — so a hovered URL lights only the client IPs
 * that reached it (upstream) and the dest IPs it fanned to (downstream), not
 * every unrelated node sharing a pattern.
 * Returns `{ nodes, edges }`: the trace nodes plus the edges fully on the path. */
function tracePath(
  start: string,
  links: SankeyLink[],
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([start])
  const edges = new Set<string>()
  // Outgoing: follow source → target.
  let frontier = [start]
  while (frontier.length) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const l of links) {
        if (l.source !== cur) continue
        const key = `${l.source}\u0001${l.target}`
        if (edges.has(key)) continue
        edges.add(key)
        if (!nodes.has(l.target)) {
          nodes.add(l.target)
          next.push(l.target)
        }
      }
    }
    frontier = next
  }
  // Incoming: follow target → source.
  frontier = [start]
  while (frontier.length) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const l of links) {
        if (l.target !== cur) continue
        const key = `${l.source}\u0001${l.target}`
        if (edges.has(key)) continue
        edges.add(key)
        if (!nodes.has(l.source)) {
          nodes.add(l.source)
          next.push(l.source)
        }
      }
    }
    frontier = next
  }
  return { nodes, edges }
}

/** Highlight set for a hovered edge: the two endpoint chains. */
function traceEdge(
  source: string,
  target: string,
  links: SankeyLink[],
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([source, target])
  const edges = new Set<string>([`${source}\u0001${target}`])
  const out = tracePath(target, links)
  for (const n of out.nodes) nodes.add(n)
  for (const e of out.edges) edges.add(e)
  const inUp = tracePath(source, links)
  for (const n of inUp.nodes) nodes.add(n)
  for (const e of inUp.edges) edges.add(e)
  return { nodes, edges }
}

function sameNodes(a: SankeyNode[], b: SankeyNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.name !== y.name || x.layer !== y.layer) return false
    if (x.detail !== y.detail) return false
    if (x.action !== y.action) return false
    if (x.isHighRisk !== y.isHighRisk) return false
  }
  return true
}

function sameLinks(a: SankeyLink[], b: SankeyLink[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.source !== y.source || x.target !== y.target || x.value !== y.value) return false
    if (x.action !== y.action) return false
    if (x.isHighRisk !== y.isHighRisk) return false
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

function buildOption(
  nodes: SankeyNode[],
  links: SankeyLink[],
  layerColors: Record<string, string> | undefined,
  resolved: ResolvedColors,
  layoutIterations: number,
  hover: { nodes: Set<string>; edges: Set<string> } | null,
  isDark: boolean,
): EChartsOption {
  const { palette, paletteColors, nodeColors } = resolved
  // Resolve per-node color: spec palette + per-node overrides take precedence
  // over any caller-provided layerColors. Only destinations carry a color
  // override (high-risk red); every other layer uses its neutral layer color.
  const resolveNodeColor = (n: SankeyNode): string => {
    const layer = n.layer ?? 0
    // Only destinations carry a color override (high-risk red). URL/domain
    // nodes are neutral ink — ALLOW/DENY verdicts are noise for tracing.
    if (layer === 3) {
      let hr = n.isHighRisk
      if (hr === undefined) {
        const flags = links
          .filter((l) => l.target === n.id || l.source === n.id)
          .map((l) => l.isHighRisk)
          .filter((v): v is boolean => v !== undefined)
        if (flags.length) hr = flags.some(Boolean)
      }
      if (hr !== undefined) return destColor(hr, isDark)
      return layerColor(3, isDark)
    }
    if (layerColors && layerColors[String(layer)]) {
      return nodeColors[String(layer)] ?? layerColor(layer, isDark)
    }
    return layerColor(layer, isDark)
  }
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

  // Path-trace hover emphasis: when a node/edge is hovered, only the items on
  // that item's directed path stay fully visible — the URL's upstream client
  // IPs and its downstream dest IPs — everything else dims. This is a real
  // trace, not the whole connected component.
  const data = nodes.map((n) => {
    const onPath = hover === null || hover.nodes.has(n.id)
    const item: SankeyNode & {
      itemStyle: { color: string; opacity: number }
      label?: { position?: "left"; opacity: number }
    } = {
      ...n,
      itemStyle: {
        color: resolveNodeColor(n),
        opacity: hover === null ? 0.92 : onPath ? 1 : 0.1,
      },
      label: {
        ...(isLastColumn(n) ? { position: "left" as const } : {}),
        opacity: hover === null ? 1 : onPath ? 1 : 0.2,
      },
    }
    return item
  })
  const linkData = links.map((l) => {
    const onPath =
      hover === null || hover.edges.has(`${l.source}\u0001${l.target}`)
    return {
      ...l,
      lineStyle: {
        color: "gradient",
        curveness: 0.5,
        opacity: hover === null ? 0.45 : onPath ? 0.8 : 0.03,
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
      formatter: (params: TooltipComponentFormatterCallbackParams) => {
        const p = Array.isArray(params) ? params[0] : params
        if (p.dataType === "edge") {
          const src = (p as { source?: string }).source ?? ""
          const tgt = (p as { target?: string }).target ?? ""
          if (p.name) return `${p.name} ${src} → ${tgt}`
          return src ? `${src} → ${tgt}` : p.name
        }
        // Node: surface domain action / high-risk in tooltip so the badge isn't color-only.
        const nd = p.data as SankeyNode | undefined
        const nodeDetail = nd?.detail
        const badge =
          nd?.layer === 2 && nd?.action ? ` [${nd.action}]` :
          nd?.layer === 3 && nd?.isHighRisk ? " [high-risk]" : ""
        const base = nodeDetail ?? p.name
        return badge ? `${base}${badge}` : base
      },
    },
    series: [
      {
        type: "sankey",
        data,
        links: linkData,
        left: 8,
        right: 8,
        top: 12,
        bottom: 12,
        nodeWidth: 16,
        nodeGap,
        layoutIterations,
        emphasis: {
          focus: "adjacency",
          blurScope: "coordinateSystem",
          itemStyle: { borderWidth: 2.5 },
        },
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
          formatter: (p: { name: string; data?: unknown }) => formatLabel(p.name),
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
  focusedId,
  onNodeClick,
}: {
  nodes: SankeyNode[]
  links: SankeyLink[]
  /** Per-layer color: key = layer index, value = CSS var or color. */
  layerColors?: Record<string, string>
  /** Fixed height (px). Defaults to content-derived height. */
  height?: number
  className?: string
  ariaLabel?: string
  /** Node id currently focused (persistent path trace until parent clears it). */
  focusedId?: string | null
  /** Click handler — receives the clicked node id + a display-name search term. */
  onNodeClick?: (info: { id: string; name: string; kind: "node" | "edge" }) => void
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
  // Connected-component hover is driven imperatively from event handlers
  // (not React state) so the canvas repaints synchronously within the same
  // mouseover frame — no async gap between the mouse event and the repaint.
  const hoveredRef = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(null)
  const buildOptRef = useRef<typeof buildOption>(buildOption)
  const linksRef = useRef(links)
  linksRef.current = links
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const layerColorsRef = useRef(layerColors)
  layerColorsRef.current = layerColors
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  const layoutIterRef = useRef(layoutIterations)
  layoutIterRef.current = layoutIterations
  const isDarkRef = useRef(theme === "dark")
  isDarkRef.current = theme === "dark"
  const onNodeClickRef = useRef(onNodeClick)
  onNodeClickRef.current = onNodeClick
  const nodeNameByIdRef = useRef<Map<string, string>>(new Map(nodes.map((n) => [n.id, n.name])) )
  nodeNameByIdRef.current = new Map(nodes.map((n) => [n.id, n.name]))

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
    hoveredRef.current = null

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
      return
    }

    prevNodes.current = nodes
    prevLinks.current = links
    prevLayerColors.current = layerColors
    prevPalette.current = resolvedPalette
    // Clear hover on data/theme change so stale highlights don't persist
    // across a layout rebuild. Re-derive any focused trace for the new data.
    hoveredRef.current = null
    const focusTrace =
      focusedId != null && focusedId.trim().length > 0 ? tracePath(focusedId, links) : null

    chart.setOption(
      buildOption(nodes, links, layerColors, resolved, layoutIterations, focusTrace, theme === "dark"),
      true,
    )
    chart.getZr().flush()
  }, [nodes, links, layerColors, theme, h, resolved, layoutIterations, focusedId])

  // Hover any node/edge → trace its path (upstream clients + downstream dests);
  // leaving the chart restores the focused trace (or full opacity). Driven
  // directly from ECharts event handlers (not React state) so the setOption +
  // flush happens synchronously in the same frame as the mouse event.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const baseTrace = () =>
      focusedId != null && focusedId.trim().length > 0
        ? tracePath(focusedId, linksRef.current)
        : null

    const pushHover = (trace: { nodes: Set<string>; edges: Set<string> } | null) => {
      hoveredRef.current = trace
      chart.setOption(
        buildOptRef.current(
          nodesRef.current,
          linksRef.current,
          layerColorsRef.current,
          resolvedRef.current,
          layoutIterRef.current,
          trace ?? baseTrace(),
          isDarkRef.current,
        ),
        true,
      )
      chart.getZr().flush()
    }

    const onMouseOver = (params: ECElementEvent) => {
      const d = params.data as { id?: string; source?: string; target?: string } | undefined
      if (params.dataType === "edge") {
        const s = d?.source ?? ""
        const t = d?.target ?? ""
        if (s && t) pushHover(traceEdge(s, t, linksRef.current))
        else pushHover(null)
      } else {
        const id = d?.id ?? ""
        if (id) pushHover(tracePath(id, linksRef.current))
        else pushHover(null)
      }
    }
    const onMouseOut = () => pushHover(null)
    chart.on("mouseover", onMouseOver)
    chart.on("mouseout", onMouseOut)
    return () => {
      chart.off("mouseover", onMouseOver)
      chart.off("mouseout", onMouseOut)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId])

  // Click wiring — focuses the clicked node (persistent trace) and forwards a
  // search term to the parent. Node clicks pass `{ id, name }`; edge clicks map
  // prefixed source/target ids → names so the term can match an ES doc.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const onClick = (params: ECElementEvent) => {
      const cb = onNodeClickRef.current
      if (params.dataType === "node") {
        const d = params.data as { id?: string; name?: string } | undefined
        const id = d?.id ?? ""
        const nm = d?.name ?? (params as unknown as { name?: string }).name ?? ""
        if (cb && nm) cb({ id, name: nm, kind: "node" })
        return
      }
      if (params.dataType === "edge") {
        const d = params.data as { source?: string; target?: string } | undefined
        const rawSrc = d?.source ?? ""
        const rawTgt = d?.target ?? ""
        const map = nodeNameByIdRef.current
        const src = displayNameForId(rawSrc, map)
        const tgt = displayNameForId(rawTgt, map)
        if (cb && (rawSrc || rawTgt)) {
          cb({ id: rawSrc || rawTgt, name: `${src} ${tgt}`.trim(), kind: "edge" })
        }
      }
    }
    chart.on("click", onClick)
    return () => {
      chart.off("click", onClick)
    }
  }, [])

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
