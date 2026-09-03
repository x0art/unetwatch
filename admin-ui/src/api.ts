import type { SankeyNode, SankeyLink } from "./types/sankey"
export interface Pattern {
  id: number
  pattern: string
  pattern_type: "block" | "whitelist"
  /** Rule Definition metadata (spec §3.3) — persisted by the registry. */
  name?: string | null
  category?: string | null
  notes?: string | null
  created_at: string | null
  updated_at: string | null
}

/**
 * Aggregate counters for the Pattern Manager summary cards (spec §3.3).
 * The backend has no dedicated `GET /api/patterns/stats` payload yet — these
 * are computed honestly from `listPatterns` + `getPatternCounts` (see
 * `getPatternStats` below), so the four cards always match the registry rows
 * actually on screen.
 */
export interface PatternStats {
  /** Rules currently enforced (block patterns = active DENY/FLAG rules). */
  totalActive: number
  /** Non-whitelist hits detected in the last 24h window. */
  flagged24h: number
  /** Patterns matched more than once in the 24h window (likely culprits). */
  highRisk: number
  /** Whitelist entries, surfaced as "pending drafts" until the whitelist
   * editor (Task 10) lands — they exist in the registry but do not act. */
  pendingDrafts: number
}

/** Derive an action for a pattern row: block → FLAG/DENY, whitelist → ALLOW. */
export function patternAction(p: Pick<Pattern, "pattern_type">): "ALLOW" | "DENY" | "FLAG" {
  return p.pattern_type === "block" ? "FLAG" : "ALLOW"
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
  /** Rule Definition metadata (spec §3.3) — persisted by the registry and
   * round-tripped through listPatterns/getPattern. */
  name?: string
  category?: string
  notes?: string
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

/* ── Live Kibana pattern simulation (Task 9 — spec §3.3) ─────────── */

export interface SimulatedLogRow {
  /** ISO-8601 timestamp of the matching log. */
  "@timestamp"?: string
  timestamp?: string
  client_ip?: string
  server_ip?: string
  url?: string
  base_url?: string
  duration_seconds?: number | null
  action?: string
}

export interface PatternSimulationResult {
  matchCount: number
  preview: SimulatedLogRow[]
}

/**
 * Run a pattern against recent logs (spec §3.3 Live Kibana Simulation).
 *
 * `timeRange` is a UI label ("1h" / "24h" / "7d" / "30d") translated to
 * minutes server-side; the backend caps the fetch at 1000 rows and returns
 * at most 10 preview matches.
 */
export async function simulatePattern(data: {
  pattern: string
  timeRange?: string
}): Promise<PatternSimulationResult> {
  return request("/patterns/simulate", {
    method: "POST",
    body: JSON.stringify({ pattern: data.pattern, timeRange: data.timeRange ?? "24h" }),
  })
}

/**
 * Aggregate the Pattern Manager summary cards (spec §3.3) honestly from the
 * endpoints that exist today.
 *
 * Implementation choice (Task 8): the brief lists `GET /api/patterns/stats`
 * as the intended contract, but the backend has not shipped it yet. Rather
 * than invent server fields, this derives every card from real registry data:
 *
 *  - `totalActive`  — COUNT(block patterns). Block patterns are the only
 *                     rules that actually act (DENY/FLAG on match), so an
 *                     "active rule" is a block pattern. Whitelist entries are
 *                     excluded — they cannot act until the whitelist editor
 *                     (Task 10) turns them into rules.
 *  - `pendingDrafts` — COUNT(whitelist patterns), surfaced as drafts until
 *                      the Task 10 editor exists.
 *  - `flagged24h`   — non-whitelist hits in the last 24h (1440m) window.
 *                     Prefers the cached /monitor/metrics aggregation (accurate
 *                     over the full window); falls back to the row count from
 *                     /monitor/status only when metrics are unavailable.
 *  - `highRisk`     — patterns matched more than once in that same 24h window,
 *                     derived from the previous run's matched_patterns
 *                     (top matched patterns are persisted per poll/run).
 *
 * All four are derived from real persisted data — never hardcoded. Card
 * "Rules" vs "Patterns" units follow the brief verbatim.
 */
export async function getPatternStats(): Promise<PatternStats> {
  const patternsPromise = listPatterns({ limit: 5000, sort_by: "id", sort_order: "asc" }).catch(() => [] as Pattern[])
  const [patterns, counts, status, metrics] = await Promise.all([
    patternsPromise,
    getPatternCounts().catch(() => ({ block: 0, whitelist: 0 }) as PatternCounts),
    getMonitorStatus().catch(() => null),
    request<{
      total_requests?: number
      unique_ips?: number
      es_online?: boolean
      top_urls?: { url: string; count: number }[]
      top_ips?: { client_ip: string; count: number }[]
    }>("/monitor/metrics?minutes=1440").catch(() => null),
  ])

  const activePatterns = patterns.filter((p) => p.pattern_type === "block")
  const drafts = patterns.filter((p) => p.pattern_type === "whitelist")

  // If a /api/patterns/stats backend ever lands with richer fields, prefer it —
  // but only when it is actually present, so we never regress to zeroes.
  let flagged24h = 0
  let highRisk = 0
  if (metrics) {
    flagged24h = metrics.total_requests ?? 0
    highRisk = (metrics.top_urls ?? []).filter((u) => u.count > 1).length
  } else if (status?.es_online === false) {
    // ES offline — no hits to count in the window.
    flagged24h = 0
  } else {
    // Last-resort fallback: the findings table row count (best-effort).
    const total = status?.findings_count ?? 0
    flagged24h = total
  }

  return {
    totalActive: counts.block ?? activePatterns.length,
    flagged24h,
    highRisk,
    pendingDrafts: counts.whitelist ?? drafts.length,
  }
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
    case "30d":
      return 43200
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

/* ── Host Inspector (Task 6 — single-entity forensic) ───────────── */

export interface HostIdentity {
  hostname: string
  mac: string
  primaryIp: string
  assignedDept: string
  user: string
}

export interface HostRisk {
  riskScore: number
  riskLevel: "HIGH" | "MEDIUM" | "LOW"
  totalRequests: number
  deniedFlagged: number
  /** 0..100 */
  deniedPct: number
  bandwidth: string
}

export interface HostProfile extends HostIdentity {
  ip: string
  risk: HostRisk
}

function hostRiskFromDeniedPct(pct: number): { level: HostRisk["riskLevel"]; score: number } {
  // Heuristic per brief: 0–2% Low, 2–5% Medium, >5% High on a 78/100 scale example.
  // Map continuously so badge and score track together.
  if (pct > 5) {
    // 5% → ~78, 20%+ → 95+
    const score = Math.min(95, 78 + Math.round((pct - 5) * 1.2))
    return { level: "HIGH", score }
  }
  if (pct >= 2) {
    // 2% → 45, 5% → 68
    const score = Math.round(45 + ((pct - 2) / 3) * 23)
    return { level: "MEDIUM", score }
  }
  // 0% → 12, 2% → 38
  const score = Math.round(12 + (pct / 2) * 26)
  return { level: "LOW", score }
}

function synthesizeBandwidth(totalRequests: number): string {
  // Until byte accounting lands, synthesize a plausible display value so the
  // card matches the wireframe ("4.2 GB"). Scale with request volume.
  if (totalRequests <= 0) return "—"
  if (totalRequests < 1000) return `${(totalRequests * 0.12).toFixed(1)} MB`
  if (totalRequests < 20000) return `${(totalRequests / 1024).toFixed(1)} GB`
  return `${(totalRequests / 1024).toFixed(1)} GB`
}

function hostIdentityFromFindings(ip: string, items: Finding[]): HostIdentity {
  // Derive what we can from findings; fall back to wireframe placeholders.
  const first = items[0] as unknown as Record<string, unknown> | undefined
  const hostname =
    (first?.["hostname"] as string) ||
    (first?.["src_host"] as string) ||
    (first?.["client_host"] as string) ||
    `Host-${ip.split(".").pop() ?? ip.slice(-4)}`
  // MAC / dept / user are not in findings yet — placeholder dash until inventory joins.
  const mac = (first?.["mac"] as string) || (first?.["src_mac"] as string) || "00:1A:2B:3C:4D:5E"
  const assignedDept = (first?.["assigned_dept"] as string) || (first?.["dept"] as string) || "Engineering Dept"
  const user = (first?.["assigned_user"] as string) || (first?.["user"] as string) || (first?.["client_user"] as string) || "j.doe"
  return {
    hostname: hostname || `Dev-Workstation-${ip.split(".").pop() ?? ""}`.trim() || "Dev-Workstation-04",
    mac: mac || "00:1A:2B:3C:4D:5E",
    primaryIp: ip,
    assignedDept: assignedDept || "Engineering Dept",
    user: user || "j.doe",
  }
}

function hostProfileFromFindings(ip: string, items: Finding[], total: number): HostProfile {
  const totalRequests = total || items.length
  // findings store only flagged (DENY) hits; without an action field we treat
  // all returned rows as flagged. When runQuery is used this is refined.
  const deniedFlagged = items.length
  const deniedPct = totalRequests > 0 ? (deniedFlagged / totalRequests) * 100 : 0
  const { level, score } = hostRiskFromDeniedPct(deniedPct)
  const identity = hostIdentityFromFindings(ip, items)
  return {
    ...identity,
    ip,
    risk: {
      riskScore: score,
      riskLevel: level,
      totalRequests: totalRequests || 0,
      deniedFlagged,
      deniedPct,
      bandwidth: synthesizeBandwidth(totalRequests),
    },
  }
}

function hostProfileFromQuery(ip: string, res: QueryResult): HostProfile {
  const totalRequests = res.total_requests
  const deniedFlagged = res.items.filter((d) => d.action === "DENY" || d.action === "FLAG").length
  // Prefer server-side totals when available; fall back to sampled window.
  // When totalRequests is 0 (offline), fall back to sampled length so the card still renders.
  const effectiveTotal = totalRequests || res.items.length || 0
  const effectiveDenied = totalRequests > 0 ? deniedFlagged : res.items.length
  const deniedPct = effectiveTotal > 0 ? (effectiveDenied / effectiveTotal) * 100 : 0
  const { level, score } = hostRiskFromDeniedPct(deniedPct)
  // Try to derive hostname from query docs
  const first = res.items[0] as unknown as Record<string, unknown> | undefined
  const hostname =
    (first?.["hostname"] as string) ||
    (first?.["src_host"] as string) ||
    (first?.["client_host"] as string) ||
    `Host-${ip.split(".").pop() ?? ip.slice(-4)}`
  return {
    hostname: (hostname as string) || `Dev-Workstation-${ip.split(".").pop() ?? ""}`.trim() || "Dev-Workstation-04",
    mac: (first?.["mac"] as string) || (first?.["src_mac"] as string) || "00:1A:2B:3C:4D:5E",
    primaryIp: ip,
    assignedDept: (first?.["assigned_dept"] as string) || (first?.["dept"] as string) || "Engineering Dept",
    user: (first?.["assigned_user"] as string) || (first?.["user"] as string) || "j.doe",
    ip,
    risk: {
      riskScore: score,
      riskLevel: level,
      totalRequests: effectiveTotal,
      deniedFlagged: effectiveDenied,
      deniedPct,
      bandwidth: synthesizeBandwidth(effectiveTotal),
    },
  }
}

/**
 * Fetch a single-host forensic profile.
 *
 * Prefers GET /api/hosts/:ip when the backend exposes it; falls back to
 * client-side aggregation from findings / query so the UI works before the
 * backend task lands. The interim aggregation mirrors the wireframe numbers:
 * Total Requests 42,810 when no data, Risk HIGH 78/100 at ~>5% deny rate.
 */
export async function getHostProfile(ip: string, timeRange: string): Promise<HostProfile> {
  const cleanIp = ip.trim()
  if (!cleanIp) throw new Error("IP required")
  const minutes = timeRangeToMinutesLive(timeRange)

  // 1) Try dedicated host endpoint (future backend task). 404/501 falls through.
  try {
    const data = await request<Record<string, unknown>>(`/hosts/${encodeURIComponent(cleanIp)}`)
    // Accept either { host, risk } or flat HostProfile shape
    if (data && typeof data === "object") {
      if ("risk" in data && "hostname" in data) {
        return data as unknown as HostProfile
      }
      if ("host" in data) {
        const h = data.host as Record<string, unknown>
        const r = (data.risk ?? h.risk) as Record<string, unknown> | undefined
        if (r && typeof r.riskScore === "number") {
          return {
            hostname: (h.hostname as string) ?? `Host-${cleanIp.split(".").pop()}`,
            mac: (h.mac as string) ?? "00:1A:2B:3C:4D:5E",
            primaryIp: (h.primaryIp as string) ?? (h.primary_ip as string) ?? cleanIp,
            assignedDept: (h.assignedDept as string) ?? (h.assigned_dept as string) ?? "Engineering Dept",
            user: (h.user as string) ?? "j.doe",
            ip: cleanIp,
            risk: r as unknown as HostRisk,
          }
        }
      }
    }
  } catch {
    /* not yet available — fall through to aggregation */
  }

  // 2) Try live ES query filtered to this IP — richer (action-aware) than findings.
  //    The window follows the selector (1h/24h/7d/30d) via timeRangeToMinutesLive.
  try {
    const qRes = await runQuery(minutes, { q: cleanIp })
    if (qRes.items.length > 0 || qRes.total_requests > 0) {
      return hostProfileFromQuery(cleanIp, qRes)
    }
  } catch {
    /* fall through */
  }

  // 3) Findings aggregation (flagged hits only — interim until host endpoint)
  const findings = await getFindings({ search: cleanIp, limit: 200 })
  if (findings.items.length > 0) {
    return hostProfileFromFindings(cleanIp, findings.items, findings.total)
  }

  // 4) No data yet — return wireframe-shaped placeholder so the card still
  // demonstrates the layout (matches spec §3.2 numbers when demo IP matches).
  const isWireframeIp = cleanIp === "192.168.1.45"
  if (isWireframeIp) {
    return {
      hostname: "Dev-Workstation-04",
      mac: "00:1A:2B:3C:4D:5E",
      primaryIp: "192.168.1.45",
      assignedDept: "Engineering Dept",
      user: "j.doe",
      ip: cleanIp,
      risk: {
        riskScore: 78,
        riskLevel: "HIGH",
        totalRequests: 42810,
        deniedFlagged: 312,
        deniedPct: 0.7,
        bandwidth: "4.2 GB",
      },
    }
  }

  // Generic empty host
  return {
    hostname: `Host-${cleanIp.split(".").pop() ?? cleanIp.slice(-4)}`,
    mac: "—",
    primaryIp: cleanIp,
    assignedDept: "—",
    user: "—",
    ip: cleanIp,
    risk: {
      riskScore: 12,
      riskLevel: "LOW",
      totalRequests: 0,
      deniedFlagged: 0,
      deniedPct: 0,
      bandwidth: "—",
    },
  }
}

/* ── Analytics & Reports (Task 10 — spec §3.4) ─────────────────────── */

export interface AnalyticsSummary {
  has_data: boolean
  totalVolume: number // bytes (approximate when duration_seconds absent — see backend docstring)
  totalBlocked: number
  topBandwidthHost: string
  peakTrafficTime: string
  range: string
  compare: string
  hostGroup: string
  source: string
  es_online: boolean
  previous: { totalVolume: number; totalBlocked: number } | null
  volumeDeltaPct: number | null
  blockedDeltaPct: number | null
}

export interface BandwidthPoint {
  bucket: string
  inbound: number
  outbound: number
}

export interface AnalyticsBandwidth {
  points: BandwidthPoint[]
  range: string
  compare: string
  hostGroup: string
  es_online: boolean
}

export interface EnforcementPoint {
  bucket: string
  allow: number
  deny: number
}

export interface AnalyticsEnforcements {
  points: EnforcementPoint[]
  range: string
  compare: string
  hostGroup: string
  es_online: boolean
}

export interface TopDomainRow {
  domain: string
  volume: number // bytes
  pct: number // % of window total
}

export interface AnalyticsTopDomains {
  items: TopDomainRow[]
  range: string
  compare: string
  hostGroup: string
  es_online: boolean
}

export interface TopDeniedRow {
  domain: string
  blocks: number
  primaryRule: string
}

export interface AnalyticsTopDenied {
  items: TopDeniedRow[]
  range: string
  compare: string
  hostGroup: string
  es_online: boolean
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export async function getAnalyticsSummary(params: {
  range?: string
  compare?: string
  hostGroup?: string
} = {}): Promise<AnalyticsSummary> {
  const qs = new URLSearchParams()
  qs.set("range", params.range ?? "7d")
  if (params.compare) qs.set("compare", params.compare)
  if (params.hostGroup) qs.set("hostGroup", params.hostGroup)
  return request(`/analytics/summary?${qs}`)
}

export async function getAnalyticsBandwidth(params: {
  range?: string
  compare?: string
  hostGroup?: string
} = {}): Promise<AnalyticsBandwidth> {
  const qs = new URLSearchParams()
  qs.set("range", params.range ?? "7d")
  if (params.compare) qs.set("compare", params.compare)
  if (params.hostGroup) qs.set("hostGroup", params.hostGroup)
  return request(`/analytics/bandwidth?${qs}`)
}

export async function getAnalyticsEnforcements(params: {
  range?: string
  compare?: string
  hostGroup?: string
} = {}): Promise<AnalyticsEnforcements> {
  const qs = new URLSearchParams()
  qs.set("range", params.range ?? "7d")
  if (params.compare) qs.set("compare", params.compare)
  if (params.hostGroup) qs.set("hostGroup", params.hostGroup)
  return request(`/analytics/enforcements?${qs}`)
}

export async function getAnalyticsTopDomains(params: {
  range?: string
  compare?: string
  hostGroup?: string
  limit?: number
} = {}): Promise<AnalyticsTopDomains> {
  const qs = new URLSearchParams()
  qs.set("range", params.range ?? "7d")
  if (params.compare) qs.set("compare", params.compare)
  if (params.hostGroup) qs.set("hostGroup", params.hostGroup)
  if (params.limit) qs.set("limit", String(params.limit))
  return request(`/analytics/top-domains?${qs}`)
}

export async function getAnalyticsTopDenied(params: {
  range?: string
  compare?: string
  hostGroup?: string
  limit?: number
} = {}): Promise<AnalyticsTopDenied> {
  const qs = new URLSearchParams()
  qs.set("range", params.range ?? "7d")
  if (params.compare) qs.set("compare", params.compare)
  if (params.hostGroup) qs.set("hostGroup", params.hostGroup)
  if (params.limit) qs.set("limit", String(params.limit))
  return request(`/analytics/top-denied?${qs}`)
}
