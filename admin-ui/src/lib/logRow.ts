import type { QueryDoc } from "../api"

export type LogRow = QueryDoc & {
  /** Spec aliases — present when NormalizedAppState shape is used */
  id?: string | number
  src_ip?: string
  src_host?: string | null
  dest_ip?: string
  domain?: string
  duration_ms?: number | null
  matched_pattern_id?: string | null
  matched_pattern_name?: string | null
}

export function getSrcIp(r: LogRow): string {
  return (r.src_ip ?? (r as unknown as QueryDoc).client_ip ?? "") as string
}

export function getDestIp(r: LogRow): string {
  return (r.dest_ip ?? (r as unknown as QueryDoc).server_ip ?? "") as string
}

export function getDurationMs(r: LogRow): number | null {
  if (typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms)) return r.duration_ms
  const s = (r as unknown as QueryDoc).duration_seconds
  if (typeof s === "number" && Number.isFinite(s)) return Math.round(s * 1000)
  return null
}

export function getRowId(r: LogRow): string {
  const q = r as unknown as QueryDoc
  const id = (r as { id?: unknown }).id
  if (typeof id === "string" || typeof id === "number") return String(id)
  return `${q.timestamp}|${q.client_ip ?? getSrcIp(r)}|${q.url}`
}

export function getMatchedRule(r: LogRow): string {
  if (r.matched_pattern_name) return r.matched_pattern_name
  if (r.matched_pattern_id) return r.matched_pattern_id
  const blocked = (r as unknown as { blocked_by?: string[] }).blocked_by
  if (Array.isArray(blocked) && blocked.length > 0) return blocked.join(", ")
  return "—"
}

export function getSrcHost(r: LogRow): string | null {
  return (
    (r.src_host ??
      (r as unknown as { client_host?: string | null }).client_host ??
      (r as unknown as { hostname?: string | null }).hostname ??
      null) as string | null
  )
}

export function actionVariant(action: string): "success" | "destructive" | "warning" | "secondary" {
  if (action === "ALLOW") return "success"
  if (action === "DENY") return "destructive"
  if (action === "FLAG") return "warning"
  return "secondary"
}

export function hostOfUrl(url: string): string {
  if (!url) return ""
  try {
    let normalized = url
    if (normalized.startsWith("//")) normalized = `https:${normalized}`
    else if (!normalized.includes("://")) normalized = `https://${normalized}`
    return new URL(normalized).hostname
  } catch {
    return url.split("/")[0]?.split(":")[0] ?? url
  }
}
