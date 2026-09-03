// Shared ECharts theme resolver — single source of truth for CSS token →
// concrete color mapping (oklch→sRGB, fallback palettes, caching).
// Imported by TrafficTimeline, SankeyDiagram and any future ECharts chart so a
// parsing fix cannot drift between diagrams.

export const FALLBACK_DARK: Record<string, string> = {
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

export const FALLBACK_LIGHT: Record<string, string> = {
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
export function parseOklch(input: string): [number, number, number] | null {
  const m = input.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?/)
  if (!m) return null
  const num = (s: string) => (s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s))
  return [num(m[1]), num(m[2]), Number(m[3])]
}

export function oklchToSrgb(L: number, C: number, Hdeg: number): string {
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

export function resolveColor(raw: string, fallback: Record<string, string>): string {
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

export interface ResolvedColors {
  palette: { label: string; muted: string; card: string; border: string }
  paletteColors: string[]
  /** Layer index → resolved color (from the layerColors CSS vars). */
  nodeColors: Record<string, string>
}

const _resolvedColorsCache = new Map<string, ResolvedColors>()
const _fallbackResolvedCache = new Map<string, Record<string, string>>()

function resolveAllColorsForTheme(
  theme: string,
  layerColors: Record<string, string> | undefined,
): ResolvedColors {
  const key = `${theme}|${JSON.stringify(layerColors ?? {})}`
  const cached = _resolvedColorsCache.get(key)
  if (cached) return cached
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

function resolveAllColorsForFallback(fallback: Record<string, string>): Record<string, string> {
  const key = JSON.stringify(fallback)
  const cached = _fallbackResolvedCache.get(key)
  if (cached) return cached
  const tokens = [
    "--color-info",
    "--color-warning",
    "--color-danger",
    "--color-success",
    "--color-primary",
    "--color-foreground",
    "--color-muted-foreground",
    "--color-card",
    "--color-border",
  ]
  const resolved: Record<string, string> = {}
  for (const token of tokens) {
    resolved[token] = resolveColor(`var(${token})`, fallback)
  }
  _fallbackResolvedCache.set(key, resolved)
  return resolved
}

// Overloaded entry point so both Sankey-style (theme, layerColors) and
// Timeline-style (fallback Record) call sites can import the same symbol
// without duplicating the parsing tables.
export function resolveAllColors(theme: string, layerColors?: Record<string, string>): ResolvedColors
export function resolveAllColors(fallback: Record<string, string>): Record<string, string>
export function resolveAllColors(
  a: string | Record<string, string>,
  b?: Record<string, string>,
): ResolvedColors | Record<string, string> {
  if (typeof a === "string") return resolveAllColorsForTheme(a, b)
  return resolveAllColorsForFallback(a)
}
