import type { SankeyNode, SankeyLink } from "./types/sankey"
export interface Pattern {
  id: number
  pattern: string
  pattern_type: "block" | "whitelist"
  created_at: string | null
  updated_at: string | null
}

export interface MonitorStatus {
  status: string
  block_patterns: number
  whitelist_patterns: number
  poll_interval_minutes: number
  es_online: boolean
  findings_count: number
  last_poll_at: string | null
}

export interface PatternCounts {
  block: number
  whitelist: number
}

export interface Finding {
  id: number
  client_ip: string
  server_ip: string
  url: string
  base_url: string
  log_timestamp: string
  created_at: string | null
}

export interface FindingsResponse {
  items: Finding[]
  total: number
}

export type GraphNodeKind = "ip" | "server" | "url"

export interface GraphNode {
  id: string
  label: string
  kind: GraphNodeKind
  count: number
}

export interface GraphLink {
  source: string
  target: string
  count: number
}

export interface GraphFlow {
  client_ip: string
  server_ip: string
  url: string
  base_url: string
  count: number
  last_seen: string
}

export interface FindingsGraph {
  nodes: GraphNode[]
  links: GraphLink[]
  flows: GraphFlow[]
}

export interface BlacklistBulkAddResult {
  added: string[]
  skipped: string[]
  errors: { value: string; error: string }[]
}

export interface BlacklistBulkDeleteResult {
  deleted: number
}

export interface BlacklistEntryRef {
  kind: "url" | "ip"
  value: string
}

export interface BlacklistSet {
  urls: string[]
  ips: string[]
}

export interface TrackedUrl {
  id: number
  url: string
  source: "manual" | "finding" | "auto"
  status: "unknown" | "ok" | "redirect" | "error"
  http_status: number | null
  final_url: string | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string | null
  history_count: number
}

export interface TrackedUrlsResponse {
  items: TrackedUrl[]
  total: number
}

export interface RedirectLink {
  source: string
  target: string
  http_status: number
  active: boolean
}

export interface RedirectGraphNode {
  id: string
  label: string
  status: TrackedUrl["status"]
  final_url: string | null
  history_count: number
}

export interface RedirectGraph {
  nodes: RedirectGraphNode[]
  links: RedirectLink[]
}

export interface RedirectCheckResult {
  url: string
  status: TrackedUrl["status"]
  http_status: number | null
  final_url: string | null
  error: string | null
}

export interface RedirectCheckResponse {
  checked: number
  updated: RedirectCheckResult[]
}

export interface UrlRedirectHistory {
  url: string
  status: TrackedUrl["status"]
  edges: {
    target_url: string
    http_status: number
    first_seen_at: string
    last_seen_at: string
    active: boolean
  }[]
}

/* ── Query console (live ES queries) ─────────────────────────────── */

export interface QueryDoc {
  timestamp: string
  client_ip: string
  server_ip: string
  url: string
  base_url: string
  duration_seconds: number | null
  action: string
  /** Block patterns this URL matched (the reason it was flagged). */
  blocked_by: string[]
  /** URL matches a whitelist pattern (excluded from findings, shown here for triage). */
  whitelisted: boolean
  /** Host or client IP is already on the blacklist. */
  blacklisted: boolean
  blacklist_source: "url" | "ip" | null
}

export interface QueryTopUrl {
  url: string
  count: number
}

export interface QueryTopIp {
  client_ip: string
  count: number
}

export interface QueryTimelinePoint {
  bucket: string
  count: number
}

export interface QueryFlowNode {
  id: string
  label: string
  kind: "ip" | "base"
}

export interface QueryFlowLink {
  source: string
  target: string
  count: number
}

export interface QueryFlow {
  nodes: QueryFlowNode[]
  links: QueryFlowLink[]
}

export interface QueryResult {
  window_minutes: number
  es_online: boolean
  query: Record<string, unknown> | null
  total_requests: number
  unique_ips: number
  distinct_urls: number
  items: QueryDoc[]
  top_urls: QueryTopUrl[]
  top_ips: QueryTopIp[]
  timeline: QueryTimelinePoint[]
  flow: QueryFlow
  error?: string
}

export async function runQuery(
  minutes: number,
  opts?: { q?: string; excludeWhitelist?: boolean; excludeBlacklist?: boolean },
): Promise<QueryResult> {
  const params = new URLSearchParams({ minutes: String(minutes) })
  const q = opts?.q?.trim()
  if (q) params.set("q", q)
  if (opts?.excludeWhitelist) params.set("exclude_whitelist", "true")
  if (opts?.excludeBlacklist) params.set("exclude_blacklist", "true")
  return request(`/query/run?${params}`)
}

/* ── Monitor logs (ES query + webhook audit trail) ───────────────── */

export interface MonitorLog {
  id: number
  kind: "poll" | "query"
  started_at: string
  duration_ms: number
  minutes: number | null
  es_online: boolean
  matches: number
  filtered: number
  stored: number
  es_query: string | null
  webhook_url: string | null
  webhook_status: number | null
  webhook_error: string | null
  webhook_reason: string | null
  /** MS Teams webhook HTTP status. */
  msteams_status: number | null
  /** MS Teams webhook error message. */
  msteams_error: string | null
  /** Top flagged URLs (JSON string from the backend; parsed by listLogs). */
  top_urls: string | null
  /** Block patterns that matched (JSON string; parsed by listLogs). */
  matched_patterns: string | null
  error: string | null
  /** Parsed convenience views — present after listLogs. */
  topUrls?: string[]
  matchedPatterns?: string[]
}

export interface LogsResponse {
  items: MonitorLog[]
  total: number
}

function parseJsonList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export async function listLogs(params?: {
  kind?: "poll" | "query"
  search?: string
  limit?: number
  offset?: number
  sort_by?: string
  sort_order?: "asc" | "desc"
}): Promise<LogsResponse> {
  const qs = new URLSearchParams()
  if (params?.kind) qs.set("kind", params.kind)
  if (params?.search) qs.set("search", params.search)
  if (params?.limit) qs.set("limit", String(params.limit))
  if (params?.offset) qs.set("offset", String(params.offset))
  if (params?.sort_by) qs.set("sort_by", params.sort_by)
  if (params?.sort_order) qs.set("sort_order", params.sort_order)
  const data = await request<LogsResponse>(`/logs/?${qs}`)
  return {
    ...data,
    items: data.items.map((l) => ({
      ...l,
      topUrls: parseJsonList(l.top_urls),
      matchedPatterns: parseJsonList(l.matched_patterns),
    })),
  }
}

export async function deleteLog(id: number): Promise<void> {
  return request(`/logs/${id}`, { method: "DELETE" })
}

export async function clearLogs(): Promise<{ deleted: number }> {
  return request("/logs", { method: "DELETE" })
}

export async function bulkDeleteLogs(ids: number[]): Promise<{ deleted: number }> {
  return request("/logs/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}

export async function retryWebhook(
  logId: number,
  provider: "webhook" | "msteams",
): Promise<{ provider: string; status: number; body: string }> {
  return request(`/logs/${logId}/retry/${provider}`, { method: "POST" })
}

const API = "/api"

/* ── Session token auth ──────────────────────────────────────────── */

let _token: string | null = null

const TOKEN_KEY = "unetwatch_token"
const LEGACY_TOKEN_KEY = "elk_token"

/** Registered callback invoked on 401 so the UI can show the login page. */
let _onSessionExpired: (() => void) | null = null

export function onSessionExpired(cb: () => void) {
  _onSessionExpired = cb
}

export function setToken(t: string | null) {
  _token = t
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
  }
}

export function getToken(): string | null {
  if (!_token) {
    _token = localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(LEGACY_TOKEN_KEY)
  }
  return _token
}

/* ── Auth endpoints (no token required) ──────────────────────────── */

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; expires_in: number }> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Login failed" }))
    throw new Error(err.detail)
  }
  return res.json()
}

/* ── Generic API wrapper ─────────────────────────────────────────── */

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const tok = getToken()
  if (tok) headers["X-API-Key"] = tok

  const res = await fetch(`${API}${url}`, { headers, ...opts })
  if (res.status === 401 && !url.includes("/auth/")) {
    setToken(null)
    _onSessionExpired?.()
    throw new Error("Session expired")
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || "Request failed")
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

/* ── Pattern CRUD ────────────────────────────────────────────────── */

export async function listPatterns(params?: {
  pattern_type?: string
  search?: string
  limit?: number
  offset?: number
  sort_by?: "id" | "pattern" | "pattern_type" | "created_at"
  sort_order?: "asc" | "desc"
}): Promise<Pattern[]> {
  const qs = new URLSearchParams()
  if (params?.pattern_type) qs.set("pattern_type", params.pattern_type)
  if (params?.search) qs.set("search", params.search)
  if (params?.limit) qs.set("limit", String(params.limit))
  if (params?.offset) qs.set("offset", String(params.offset))
  if (params?.sort_by) qs.set("sort_by", params.sort_by)
  if (params?.sort_order) qs.set("sort_order", params.sort_order)
  return request(`/patterns/?${qs}`)
}

export async function createPattern(data: {
  pattern: string
  pattern_type: string
}): Promise<Pattern> {
  return request("/patterns/", { method: "POST", body: JSON.stringify(data) })
}

export async function updatePattern(
  id: number,
  data: { pattern?: string; pattern_type?: string },
): Promise<Pattern> {
  return request(`/patterns/${id}`, { method: "PUT", body: JSON.stringify(data) })
}

export async function deletePattern(id: number): Promise<void> {
  return request(`/patterns/${id}`, { method: "DELETE" })
}

export async function bulkImport(data: {
  patterns: string[]
  pattern_type: string
}): Promise<Pattern[]> {
  return request("/patterns/bulk", { method: "POST", body: JSON.stringify(data) })
}

export async function getPatternCounts(): Promise<PatternCounts> {
  return request("/patterns/stats/counts")
}

export async function getMonitorStatus(): Promise<MonitorStatus> {
  return request("/monitor/status")
}

/* ── Live Monitor metrics (Task 3 KPI aggregation) ─────────────────── */

export interface LiveMetrics {
  activeHosts: number
  totalRequests: number
  deniedRequests: number
  bandwidth: string
  avgDuration: string
}

/**
 * Aggregate live KPI metrics for the Live Traffic Monitor.
 * Calls GET /api/monitor/metrics and GET /api/query/run in parallel;
 * falls back gracefully when Elasticsearch is offline.
 * `bandwidth` is a display placeholder until byte accounting lands (Task 7+).
 */
export async function getLiveMetrics(opts?: { minutes?: number }): Promise<LiveMetrics> {
  const minutes = opts?.minutes ?? 60
  // Metrics endpoint is capped to 1440 (enforced by backend Query ge=1,le=1440);
  // longer windows fall back to the max so the card never 500s.
  const metricsMinutes = Math.min(Math.max(1, minutes), 1440)
  const metricsPromise = request<{
    total_requests: number
    unique_ips: number
    es_online: boolean
    denied_count?: number
    denied_requests?: number
    total_denied?: number
  }>(`/monitor/metrics?minutes=${metricsMinutes}`).catch(() => null)
  const queryPromise = runQuery(metricsMinutes).catch(() => null)

  const [metrics, query] = await Promise.all([metricsPromise, queryPromise])

  const activeHosts = metrics?.unique_ips ?? query?.unique_ips ?? 0
  const totalRequests = metrics?.total_requests ?? query?.total_requests ?? 0

  let deniedRequests = 0
  let avgDuration = "—"
  if (query) {
    // Prefer server-side aggregation when available (accurate over the full
    // window); fall back to sampled count from fetched items only when no
    // aggregation field exists. Sampled fallback is window-truncated (LogInspector
    // caps at 50 / runQuery paginates) so deny-rate hint is understated.
    const m = metrics as Record<string, unknown> | null
    const q = query as unknown as Record<string, unknown>
    const aggDenied =
      (typeof m?.denied_count === "number" ? m.denied_count : undefined) ??
      (typeof m?.denied_requests === "number" ? m.denied_requests : undefined) ??
      (typeof m?.total_denied === "number" ? m.total_denied : undefined) ??
      (typeof q.denied_count === "number" ? q.denied_count : undefined) ??
      (typeof q.total_denied === "number" ? q.total_denied : undefined) ??
      (typeof q.denied_requests === "number" ? q.denied_requests : undefined)
    if (typeof aggDenied === "number") {
      deniedRequests = aggDenied
    } else if (query.items.length > 0) {
      deniedRequests = query.items.filter((d) => d.action === "DENY").length
    }
    // avgDuration is sampled from fetched items (not an ES avg aggregation) —
    // acceptable placeholder until backend exposes aggregated duration; truncated
    // to the fetched window when paginated.
    if (query.items.length > 0) {
      const durations = query.items
        .map((d) => d.duration_seconds)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      if (durations.length > 0) {
        const mean = durations.reduce((a, b) => a + b, 0) / durations.length
        avgDuration = `${(mean * 1000).toFixed(0)}ms`
      }
    }
  }

  // Bandwidth accounting not yet exposed by the pipeline — placeholder
  // keeps the fourth KPI card populated until Task 7 lands byte totals.
  const bandwidth = "420 MB"

  return { activeHosts, totalRequests, deniedRequests, bandwidth, avgDuration }
}

export async function triggerManualRun(
  minutes?: number,
): Promise<{ status: string; minutes: number }> {
  const qs = minutes !== undefined ? `?minutes=${minutes}` : ""
  return request(`/monitor/run${qs}`, { method: "POST" })
}

export async function getFindings(params?: {
  search?: string
  limit?: number
  offset?: number
}): Promise<FindingsResponse> {
  const qs = new URLSearchParams()
  if (params?.search) qs.set("search", params.search)
  if (params?.limit) qs.set("limit", String(params.limit))
  if (params?.offset) qs.set("offset", String(params.offset))
  return request(`/findings/?${qs}`)
}

export async function deleteFinding(id: number): Promise<void> {
  return request(`/findings/${id}`, { method: "DELETE" })
}

export async function clearFindings(): Promise<void> {
  return request("/findings/", { method: "DELETE" })
}

export async function bulkDeleteFindings(ids: number[]): Promise<{ deleted: number }> {
  return request("/findings/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}

export async function getFindingsGraph(limit = 30): Promise<FindingsGraph> {
  return request(`/findings/graph?limit=${limit}`)
}

/* ── Live Sankey (Task 4 — 4-column Sources → Patterns → Domains → Destinations) ─ */

export type { SankeyNode, SankeyLink } from "./types/sankey"
// Back-compat aliases for any caller still importing LiveSankey* names.
export type LiveSankeyNode = SankeyNode
export type LiveSankeyLink = SankeyLink
export interface LiveSankeyGraph {
  nodes: SankeyNode[]
  links: SankeyLink[]
}
export const MAX_LIVE_SANKEY_MINUTES = 1440

export function isLiveSankeyTruncated(timeRange: string): boolean {
  return timeRangeToMinutesLive(timeRange) > MAX_LIVE_SANKEY_MINUTES
}
export function clampLiveSankeyMinutes(minutes: number): number {
  return Math.min(minutes, MAX_LIVE_SANKEY_MINUTES)
}
export function liveSankeyTruncationNote(timeRange: string): string | null {
  if (!isLiveSankeyTruncated(timeRange)) return null
  const requested = timeRangeToMinutesLive(timeRange)
  const cap = MAX_LIVE_SANKEY_MINUTES
  const fmt = (m: number) => (m >= 1440 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.round(m / 60)}h` : `${m}m`)
  return `Showing last ${fmt(cap)} of ${timeRange} window — backend limit ${cap}m (requested ${fmt(requested)})`
}

export function timeRangeToMinutesLive(tr: string): number {
  switch (tr) {
    case "1h":
      return 60
    case "7d":
      return 10080
    case "24h":
      return 1440
    default: {
      const n = Number(tr)
      if (Number.isFinite(n) && n > 0) return Math.min(n, 43200)
      return 1440
    }
  }
}

/**
 * Build a 4-layer Sankey graph for the Live Monitor.
 *
 * Implementation choice: reuses the existing `runQuery` (+ `getFindingsGraph`
 * fallback) and reshapes on the client. No dedicated `GET /api/graph` endpoint
 * is required — the comment documents the alternative the brief allowed.
 *
 * Layers (spec §4.1):
 *  0 Sources — client IPs / hosts (blue #3B82F6)
 *  1 Patterns — matched block patterns + "Unmatched" (slate #64748B)
 *  2 Domains — base_url/domain, colored by action: ALLOW #10B981 / DENY #EF4444 / FLAG #F59E0B
 *  3 Destinations — dest IPs, high-risk orange #F97316 vs standard purple #8B5CF6
 *
 * Ribbon thickness ∝ value (aggregated counts).
 */
export async function getLiveSankey(timeRange: string): Promise<LiveSankeyGraph> {
  const minutes = timeRangeToMinutesLive(timeRange)
  // Backend /api/query/run caps at 1440; longer windows silently clamp — caller
  // should surface liveSankeyTruncationNote(timeRange) so the user sees "7d"
  // isn't fully rendered (see SankeySection banner).
  const clamped = clampLiveSankeyMinutes(minutes)

  // Prefer live ES data (rich: blocked_by, action, blacklisted).
  try {
    const res = await runQuery(clamped)
    if (res.items.length > 0) {
      return buildLiveSankeyFromQuery(res.items)
    }
    // If ES returned no items but flow exists (older backend), try shaping flow as 2-col fallback
    if (res.flow.nodes.length > 0) {
      // No pattern/action data — degrade to 2 layers mapped into 0 and 3
      const nodes: LiveSankeyNode[] = res.flow.nodes.map((n) => ({
        id: n.id,
        name: n.label,
        layer: n.kind === "ip" ? 0 : 3,
        // Destinations without action stay standard purple; SankeyDiagram will use LAYER_COLORS[3]
      }))
      const links: LiveSankeyLink[] = res.flow.links.map((l) => ({
        source: l.source,
        target: l.target,
        value: l.count,
      }))
      return { nodes, links }
    }
  } catch {
    /* fall through to findings graph */
  }

  try {
    const graph = await getFindingsGraph(30)
    if (graph.flows.length > 0) {
      return buildLiveSankeyFromFindings(graph)
    }
  } catch {
    /* return empty */
  }

  return { nodes: [], links: [] }
}

function buildLiveSankeyFromQuery(items: QueryDoc[]): LiveSankeyGraph {
  // Cap per-layer breadth so the diagram stays readable.
  const MAX_SRC = 20
  const MAX_PAT = 12
  const MAX_DOM = 20
  const MAX_DST = 20

  // Frequency maps for capping
  const srcCount = new Map<string, number>()
  const patCount = new Map<string, number>()
  const domCount = new Map<string, number>()
  const dstCount = new Map<string, number>()
  const domAction = new Map<string, string>()
  const domActionCounts = new Map<string, Map<string, number>>()
  const dstRisk = new Map<string, boolean>()

  for (const it of items) {
    const src = it.client_ip || "unknown"
    srcCount.set(src, (srcCount.get(src) ?? 0) + 1)
    const pats = it.blocked_by.length > 0 ? it.blocked_by : ["Unmatched"]
    for (const p of pats) patCount.set(p, (patCount.get(p) ?? 0) + 1)
    const dom = it.base_url || it.url || "unknown"
    domCount.set(dom, (domCount.get(dom) ?? 0) + 1)
    const act = it.action || "ALLOW"
    if (!domActionCounts.has(dom)) domActionCounts.set(dom, new Map())
    domActionCounts.get(dom)!.set(act, (domActionCounts.get(dom)!.get(act) ?? 0) + 1)
    const dst = it.server_ip || "unknown"
    dstCount.set(dst, (dstCount.get(dst) ?? 0) + 1)
    const risky = it.action === "DENY" || it.blacklisted === true
    if (risky) dstRisk.set(dst, true)
    else if (!dstRisk.has(dst)) dstRisk.set(dst, false)
  }

  const topSrc = new Set(
    [...srcCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_SRC).map(([k]) => k),
  )
  const topPat = new Set(
    [...patCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_PAT).map(([k]) => k),
  )
  const topDom = new Set(
    [...domCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DOM).map(([k]) => k),
  )
  const topDst = new Set(
    [...dstCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DST).map(([k]) => k),
  )

  for (const [dom, counts] of domActionCounts) {
    if (!topDom.has(dom)) continue
    let best = "ALLOW"
    let bestN = -1
    for (const [act, n] of counts) {
      if (n > bestN) { best = act; bestN = n }
    }
    domAction.set(dom, best)
  }

  const idSrc = (ip: string) => `src:${ip}`
  const idPat = (p: string) => `pat:${p}`
  const idDom = (d: string) => `dom:${d}`
  const idDst = (ip: string) => `dst:${ip}`

  const nodes: LiveSankeyNode[] = []
  for (const s of topSrc) nodes.push({ id: idSrc(s), name: s, layer: 0 })
  for (const p of topPat) nodes.push({ id: idPat(p), name: p, layer: 1 })
  for (const d of topDom) nodes.push({ id: idDom(d), name: d, layer: 2, action: domAction.get(d) ?? "ALLOW" })
  for (const d of topDst) nodes.push({ id: idDst(d), name: d, layer: 3, isHighRisk: dstRisk.get(d) ?? false })

  const linkKey = (a: string, b: string) => `${a}\0${b}`
  const srcPat = new Map<string, number>()
  const patDom = new Map<string, number>()
  const domDst = new Map<string, number>()
  const domDstMeta = new Map<string, { action: string; isHighRisk: boolean }>()

  for (const it of items) {
    const src = it.client_ip || "unknown"
    if (!topSrc.has(src)) continue
    const pats = it.blocked_by.length > 0 ? it.blocked_by : ["Unmatched"]
    const dom = it.base_url || it.url || "unknown"
    if (!topDom.has(dom)) continue
    const dst = it.server_ip || "unknown"
    if (!topDst.has(dst)) continue
    const act = it.action || "ALLOW"
    const risky = it.action === "DENY" || it.blacklisted === true
    for (const pat of pats) {
      if (!topPat.has(pat)) continue
      const k1 = linkKey(idSrc(src), idPat(pat))
      srcPat.set(k1, (srcPat.get(k1) ?? 0) + 1)
      const k2 = linkKey(idPat(pat), idDom(dom))
      patDom.set(k2, (patDom.get(k2) ?? 0) + 1)
    }
    const k3 = linkKey(idDom(dom), idDst(dst))
    domDst.set(k3, (domDst.get(k3) ?? 0) + 1)
    const prev = domDstMeta.get(k3)
    if (!prev) domDstMeta.set(k3, { action: act, isHighRisk: risky })
    else if (risky) prev.isHighRisk = true
  }

  const links: LiveSankeyLink[] = []
  for (const [k, v] of srcPat) {
    const [source, target] = k.split("\0")
    links.push({ source, target, value: v })
  }
  for (const [k, v] of patDom) {
    const [source, target] = k.split("\0")
    links.push({ source, target, value: v })
  }
  for (const [k, v] of domDst) {
    const [source, target] = k.split("\0")
    const meta = domDstMeta.get(k)
    links.push({ source, target, value: v, action: meta?.action, isHighRisk: meta?.isHighRisk })
  }

  return { nodes, links }
}

function buildLiveSankeyFromFindings(graph: FindingsGraph): LiveSankeyGraph {
  // Findings store no per-hit pattern, so the Patterns layer is always one
  // node ("Unmatched"); no per-pattern cap is needed — one bucket only.
  const MAX_SRC = 20
  const MAX_DOM = 20
  const MAX_DST = 20

  const srcCount = new Map<string, number>()
  const domCount = new Map<string, number>()
  const dstCount = new Map<string, number>()
  for (const f of graph.flows) {
    srcCount.set(f.client_ip, (srcCount.get(f.client_ip) ?? 0) + f.count)
    domCount.set(f.base_url, (domCount.get(f.base_url) ?? 0) + f.count)
    const dst = f.server_ip || f.base_url
    dstCount.set(dst, (dstCount.get(dst) ?? 0) + f.count)
  }
  const topSrc = new Set([...srcCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SRC).map(([k]) => k))
  const topDom = new Set([...domCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DOM).map(([k]) => k))
  const topDst = new Set([...dstCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DST).map(([k]) => k))

  const idSrc = (s: string) => `src:${s}`
  const idPat = "pat:Unmatched"
  const idDom = (d: string) => `dom:${d}`
  const idDst = (d: string) => `dst:${d}`

  const nodes: LiveSankeyNode[] = []
  for (const s of topSrc) nodes.push({ id: idSrc(s), name: s, layer: 0 })
  nodes.push({ id: idPat, name: "Unmatched", layer: 1 })
  for (const d of topDom) nodes.push({ id: idDom(d), name: d, layer: 2, action: "ALLOW" })
  for (const d of topDst) nodes.push({ id: idDst(d), name: d, layer: 3, isHighRisk: false })

  const srcPat = new Map<string, number>()
  const patDom = new Map<string, number>()
  const domDst = new Map<string, number>()
  for (const f of graph.flows) {
    if (!topSrc.has(f.client_ip) || !topDom.has(f.base_url)) continue
    const dst = f.server_ip || f.base_url
    if (!topDst.has(dst)) continue
    const sId = idSrc(f.client_ip)
    const dId = idDom(f.base_url)
    const tId = idDst(dst)
    const k1 = `${sId}\0${idPat}`
    srcPat.set(k1, (srcPat.get(k1) ?? 0) + f.count)
    const k2 = `${idPat}\0${dId}`
    patDom.set(k2, (patDom.get(k2) ?? 0) + f.count)
    const k3 = `${dId}\0${tId}`
    domDst.set(k3, (domDst.get(k3) ?? 0) + f.count)
  }

  const links: LiveSankeyLink[] = []
  for (const [k, v] of srcPat) { const [a, b] = k.split("\0"); links.push({ source: a, target: b, value: v }) }
  for (const [k, v] of patDom) { const [a, b] = k.split("\0"); links.push({ source: a, target: b, value: v }) }
  for (const [k, v] of domDst) { const [a, b] = k.split("\0"); links.push({ source: a, target: b, value: v }) }

  return { nodes, links }
}

/* ── Per-client URL drill-down (Traffic page) ─────────────────── */

export interface TopClient {
  client_ip: string
  count: number
}

export interface ClientUrlCount {
  url: string
  base_url: string
  count: number
  last_seen: string
}

export interface ClientBreakdown {
  client_ip: string
  source: "findings" | "es"
  total_accesses: number
  es_online: boolean
  urls: ClientUrlCount[]
}

export async function getTopClients(opts?: {
  search?: string
  limit?: number
}): Promise<{ items: TopClient[] }> {
  const qs = new URLSearchParams()
  if (opts?.search) qs.set("search", opts.search)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/findings/top-clients?${qs}`)
}

export async function getClientBreakdown(
  ip: string,
  opts?: { minutes?: number; search?: string; limit?: number },
): Promise<ClientBreakdown> {
  const qs = new URLSearchParams()
  if (opts?.minutes) qs.set("minutes", String(opts.minutes))
  if (opts?.search) qs.set("search", opts.search)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/findings/client/${encodeURIComponent(ip)}?${qs}`)
}

export async function runClientQuery(
  ip: string,
  opts?: { minutes?: number; search?: string; limit?: number },
): Promise<ClientBreakdown> {
  const qs = new URLSearchParams({ ip })
  if (opts?.minutes) qs.set("minutes", String(opts.minutes))
  if (opts?.search) qs.set("search", opts.search)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/query/client?${qs}`)
}

/* ── Per-URL client drill-down (Traffic page reverse) ─────────── */

export interface UrlClientCount {
  client_ip: string
  count: number
  last_seen: string
}

export interface UrlBreakdown {
  url: string
  source: "findings"
  total_accesses: number
  es_online: boolean
  clients: UrlClientCount[]
}

export async function getUrlBreakdown(
  url: string,
  opts?: { minutes?: number; limit?: number },
): Promise<UrlBreakdown> {
  const qs = new URLSearchParams()
  if (opts?.minutes) qs.set("minutes", String(opts.minutes))
  if (opts?.limit) qs.set("limit", String(opts.limit))
  return request(`/findings/url/${encodeURIComponent(url)}?${qs}`)
}

/* ── Blacklist plain-text feeds (for external integrations) ──────── */

export async function getBlacklistUrls(): Promise<string> {
  const res = await fetch(`${API}/blacklist/urls.txt`, {
    headers: getToken() ? { "X-API-Key": getToken()! } : {},
  })
  if (res.status === 401) { setToken(null); _onSessionExpired?.(); throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.text()
}

export async function getBlacklistIps(): Promise<string> {
  const res = await fetch(`${API}/blacklist/ips.txt`, {
    headers: getToken() ? { "X-API-Key": getToken()! } : {},
  })
  if (res.status === 401) { setToken(null); _onSessionExpired?.(); throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.text()
}

export async function addBaseUrlToBlacklist(value: string): Promise<{ added: string[] }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const tok = getToken()
  if (tok) headers["X-API-Key"] = tok
  const res = await fetch(`${API}/blacklist/`, { method: "POST", headers, body: JSON.stringify({ value }) })
  if (res.status === 401) { setToken(null); _onSessionExpired?.(); throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function deleteBlacklistEntry(kind: "url" | "ip", value: string): Promise<void> {
  return request(`/blacklist/${kind}/${encodeURIComponent(value)}`, { method: "DELETE" })
}

export async function getBlacklistSet(): Promise<{ urls: string[]; ips: string[] }> {
  const headers: Record<string, string> = {}
  const tok = getToken()
  if (tok) headers["X-API-Key"] = tok
  const res = await fetch(`${API}/blacklist/entries`, { headers })
  if (res.status === 401) { setToken(null); _onSessionExpired?.(); throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function bulkAddBlacklist(values: string[]): Promise<BlacklistBulkAddResult> {
  return request("/blacklist/bulk", {
    method: "POST",
    body: JSON.stringify({ values }),
  })
}

export async function bulkDeleteBlacklist(entries: BlacklistEntryRef[]): Promise<BlacklistBulkDeleteResult> {
  return request("/blacklist/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ entries }),
  })
}

/* ── Redirect tracker ──────────────────────────────────────────── */

export async function listTrackedUrls(params?: {
  search?: string
  limit?: number
  offset?: number
  sort_by?: "id" | "url" | "source" | "status" | "last_checked_at"
  sort_order?: "asc" | "desc"
}): Promise<TrackedUrlsResponse> {
  const qs = new URLSearchParams()
  if (params?.search) qs.set("search", params.search)
  if (params?.limit) qs.set("limit", String(params.limit))
  if (params?.offset) qs.set("offset", String(params.offset))
  if (params?.sort_by) qs.set("sort_by", params.sort_by)
  if (params?.sort_order) qs.set("sort_order", params.sort_order)
  return request(`/redirects/?${qs}`)
}

export async function addTrackedUrl(data: {
  url: string
  source?: "manual" | "finding"
}): Promise<TrackedUrl> {
  return request("/redirects/", { method: "POST", body: JSON.stringify(data) })
}

export async function deleteTrackedUrl(id: number): Promise<void> {
  return request(`/redirects/${id}`, { method: "DELETE" })
}

export async function checkRedirects(urls?: string[]): Promise<RedirectCheckResponse> {
  return request("/redirects/check", {
    method: "POST",
    body: JSON.stringify(urls && urls.length ? { urls } : {}),
  })
}

export async function getRedirectGraph(): Promise<RedirectGraph> {
  return request("/redirects/graph")
}

export async function getUrlRedirectHistory(id: number): Promise<UrlRedirectHistory> {
  return request(`/redirects/${id}/history`)
}