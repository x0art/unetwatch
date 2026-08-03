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
}

export interface PatternCounts {
  block: number
  whitelist: number
}

const API = "/api"

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || "Request failed")
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function listPatterns(params?: {
  pattern_type?: string
  search?: string
  limit?: number
  offset?: number
}): Promise<Pattern[]> {
  const qs = new URLSearchParams()
  if (params?.pattern_type) qs.set("pattern_type", params.pattern_type)
  if (params?.search) qs.set("search", params.search)
  if (params?.limit) qs.set("limit", String(params.limit))
  if (params?.offset) qs.set("offset", String(params.offset))
  return request(`/patterns/?${qs}`)
}

export async function createPattern(data: {
  pattern: string
  pattern_type: string
}): Promise<Pattern> {
  return request("/patterns/", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export async function updatePattern(
  id: number,
  data: { pattern?: string; pattern_type?: string }
): Promise<Pattern> {
  return request(`/patterns/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  })
}

export async function deletePattern(id: number): Promise<void> {
  return request(`/patterns/${id}`, { method: "DELETE" })
}

export async function bulkImport(data: {
  patterns: string[]
  pattern_type: string
}): Promise<Pattern[]> {
  return request("/patterns/bulk", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export async function getPatternCounts(): Promise<PatternCounts> {
  return request("/patterns/stats/counts")
}

export async function getMonitorStatus(): Promise<MonitorStatus> {
  return request("/monitor/status")
}

export async function triggerManualRun(): Promise<{ status: string }> {
  return request("/monitor/run", { method: "POST" })
}