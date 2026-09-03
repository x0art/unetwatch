/**
 * Shared Sankey types — single source for SankeyDiagram, api LiveSankey, and
 * LiveMonitorPage. Extracted to avoid SankeyDiagram ↔ api circular import and
 * to eliminate the LiveSankeyNode/Link duplication + unsafe double-cast.
 */
export interface SankeyNode {
  id: string
  name: string
  /** Layer index 0=Sources, 1=Patterns, 2=Domains, 3=Destinations. */
  layer?: number
  /** Optional full detail shown in the tooltip (e.g. the full URL behind a host-only label). */
  detail?: string
  /** Domain verdict — drives layer-2 color: ALLOW/DENY/FLAG. */
  action?: string
  /** Destinations layer — true paints high-risk orange. */
  isHighRisk?: boolean
}

export interface SankeyLink {
  source: string
  target: string
  value: number
  /** Optional edge label shown in the tooltip (e.g. "302 →"). */
  name?: string
  /** Link-level action for domain coloring fallback. */
  action?: string
  /** Link-level high-risk flag for dest coloring fallback. */
  isHighRisk?: boolean
}
