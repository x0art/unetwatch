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

export interface FindingsGraph {
  nodes: GraphNode[]
  links: GraphLink[]
}

export interface MetricsPoint {
  count: number
}

export interface MonitorMetrics {
  window_minutes: number
  es_online: boolean
  total_requests: number
  unique_ips: number
  top_urls: (MetricsPoint & { url: string })[]
  top_ips: (MetricsPoint & { client_ip: string })[]
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

const API = "/api"

/* ── Session token auth ──────────────────────────────────────────── */

let _token: string | null = null

export function setToken(t: string | null) {
  _token = t
  if (t) localStorage.setItem("elk_token", t)
  else localStorage.removeItem("elk_token")
}

export function getToken(): string | null {
  if (!_token) _token = localStorage.getItem("elk_token")
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
    window.location.href = "/"
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

export async function triggerManualRun(
  minutes?: number,
): Promise<{ status: string; minutes: number }> {
  const qs = minutes !== undefined ? `?minutes=${minutes}` : ""
  return request(`/monitor/run${qs}`, { method: "POST" })
}

export async function getMonitorMetrics(minutes: number): Promise<MonitorMetrics> {
  return request(`/monitor/metrics?minutes=${minutes}`)
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

/* ── Blacklist plain-text feeds (for external integrations) ──────── */

export async function getBlacklistUrls(): Promise<string> {
  const res = await fetch(`${API}/blacklist/urls`, {
    headers: getToken() ? { "X-API-Key": getToken()! } : {},
  })
  if (res.status === 401) { setToken(null); window.location.href = "/"; throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.text()
}

export async function getBlacklistIps(): Promise<string> {
  const res = await fetch(`${API}/blacklist/ips`, {
    headers: getToken() ? { "X-API-Key": getToken()! } : {},
  })
  if (res.status === 401) { setToken(null); window.location.href = "/"; throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.text()
}

export async function addBaseUrlToBlacklist(value: string): Promise<{ added: string[] }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const tok = getToken()
  if (tok) headers["X-API-Key"] = tok
  const res = await fetch(`${API}/blacklist/`, { method: "POST", headers, body: JSON.stringify({ value }) })
  if (res.status === 401) { setToken(null); window.location.href = "/"; throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
}

export async function getBlacklistSet(): Promise<{ urls: string[]; ips: string[] }> {
  const headers: Record<string, string> = {}
  const tok = getToken()
  if (tok) headers["X-API-Key"] = tok
  const res = await fetch(`${API}/blacklist/entries`, { headers })
  if (res.status === 401) { setToken(null); window.location.href = "/"; throw new Error("Session expired") }
  if (!res.ok) throw new Error(`Failed: ${res.status}`)
  return res.json()
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

export async function checkRedirects(url?: string): Promise<RedirectCheckResponse> {
  return request("/redirects/check", {
    method: "POST",
    body: JSON.stringify(url ? { url } : {}),
  })
}

export async function getRedirectGraph(): Promise<RedirectGraph> {
  return request("/redirects/graph")
}

export async function getUrlRedirectHistory(id: number): Promise<UrlRedirectHistory> {
  return request(`/redirects/${id}/history`)
}