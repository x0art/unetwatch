import * as DialogPrimitive from "@radix-ui/react-dialog"
import { motion } from "framer-motion"
import { ExternalLink, X } from "lucide-react"
import { Badge, Button, useToast } from "./ui"
import { useFilter } from "../contexts/FilterContext"
import type { LogRow } from "./LogInspector"

function getSrcIp(row: LogRow): string {
  return (row.src_ip ?? (row as unknown as { client_ip?: string }).client_ip ?? "") as string
}
function getSrcHost(row: LogRow): string | null {
  return (row.src_host ?? (row as unknown as { src_host?: string | null }).src_host ?? null) as string | null
}
function getDestIp(row: LogRow): string {
  return (row.dest_ip ?? (row as unknown as { server_ip?: string }).server_ip ?? "") as string
}
function getDurationMs(row: LogRow): number | null {
  if (typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms)) return row.duration_ms
  const s = (row as unknown as { duration_seconds?: number | null }).duration_seconds
  if (typeof s === "number" && Number.isFinite(s)) return Math.round(s * 1000)
  return null
}
function getMatchedRule(row: LogRow): string {
  if (row.matched_pattern_name) return row.matched_pattern_name
  if (row.matched_pattern_id) return row.matched_pattern_id
  const blocked = (row as unknown as { blocked_by?: string[] }).blocked_by
  if (Array.isArray(blocked) && blocked.length > 0) return blocked.join(", ")
  return "—"
}
function getRowId(row: LogRow): string {
  const id = (row as { id?: unknown }).id
  if (typeof id === "string" || typeof id === "number") return String(id)
  const q = row as unknown as { timestamp?: string; client_ip?: string; url?: string }
  return q.timestamp ?? row.url ?? String(id ?? "")
}
function actionVariant(action: string): "success" | "destructive" | "warning" | "secondary" {
  if (action === "ALLOW") return "success"
  if (action === "DENY") return "destructive"
  if (action === "FLAG") return "warning"
  return "secondary"
}
function hostOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.split("/")[0] ?? url
  }
}

export function InspectionDrawer({ row, onClose }: { row: LogRow; onClose: () => void }) {
  const { setGlobalFilter } = useFilter()
  const { toast } = useToast()

  const srcIp = getSrcIp(row)
  const srcHost = getSrcHost(row)
  const destIp = getDestIp(row)
  const durationMs = getDurationMs(row)
  const matchedRule = getMatchedRule(row)
  const rowId = getRowId(row)

  const handleAddToAllowList = () => {
    const host = hostOfUrl(row.url ?? "")
    const pattern = host ? `*.${host}/*` : row.url
    // Placeholder for Pattern Simulation Drawer (Task 9). Until then, stash
    // the candidate in the global filter + URL so Pattern Manager can pre-fill.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("pattern", pattern)
      window.history.replaceState(null, "", url.toString())
    } catch {
      /* ignore */
    }
    toast({
      title: "Pattern draft",
      description: `Allow-list candidate: ${pattern} — open Pattern Manager to simulate & deploy.`,
      variant: "info",
    })
  }

  const handleViewHostHistory = () => {
    if (srcIp) setGlobalFilter(srcIp)
    // Cross-page consistency: Host Inspector reads globalFilter (?q=) on mount.
    // Persist desired view so a subsequent navigation lands on "host".
    try {
      window.localStorage.setItem("unetwatch_view", "host")
      const url = new URL(window.location.href)
      url.searchParams.set("q", srcIp)
      window.history.replaceState(null, "", url.toString())
    } catch {
      /* ignore */
    }
    toast({
      title: `Host filter: ${srcIp}`,
      description: "Global filter updated — open Host Inspector to see history.",
      variant: "info",
    })
    onClose()
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#0F172A]/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <DialogPrimitive.Content asChild>
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="fixed right-0 top-0 z-50 flex h-dvh w-full max-w-[480px] flex-col overflow-hidden border-l border-border bg-card shadow-xl"
            aria-label={`Event Details: #${rowId}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <DialogPrimitive.Title className="font-sans text-sm font-semibold">Event Details: #{String(rowId).slice(0, 24)}</DialogPrimitive.Title>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{row.timestamp ? new Date(row.timestamp).toLocaleString() : "—"}</p>
              </div>
              <DialogPrimitive.Close
                aria-label="Close drawer"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-4 font-mono text-xs">
                <div>
                  <p className="mono-label">Timestamp</p>
                  <p className="mt-1 text-foreground">{row.timestamp ? new Date(row.timestamp).toLocaleString() : "—"}</p>
                </div>
                <div>
                  <p className="mono-label">Source IP (Host)</p>
                  <p className="mt-1 font-bold text-foreground">
                    {srcIp || "—"} {srcHost ? <span className="font-normal text-muted-foreground">(Host: {srcHost})</span> : <span className="font-normal text-muted-foreground">(Host: —)</span>}
                  </p>
                </div>
                <div>
                  <p className="mono-label">Dest IP</p>
                  <p className="mt-1 text-foreground">{destIp || "—"}</p>
                </div>
                <div>
                  <p className="mono-label">Action</p>
                  <p className="mt-1">
                    <Badge variant={actionVariant(row.action ?? "")}>{row.action || "—"}</Badge>
                  </p>
                </div>
                <div>
                  <p className="mono-label">Duration</p>
                  <p className="mt-1 tabular-nums">{durationMs != null ? `${durationMs}ms` : "—"}</p>
                </div>
                <div>
                  <p className="mono-label">Full URL</p>
                  {row.url ? (
                    <a href={row.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-primary hover:underline">
                      {row.url}
                      <ExternalLink className="ml-1 inline h-3 w-3 align-middle" aria-hidden="true" />
                    </a>
                  ) : (
                    <p className="mt-1 text-muted-foreground">—</p>
                  )}
                </div>
                <div>
                  <p className="mono-label">Matched Rule</p>
                  <p className="mt-1 text-muted-foreground">{matchedRule}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-border bg-muted/30 px-5 py-4">
              <Button onClick={handleAddToAllowList}>Add URL to Allow List</Button>
              <Button variant="outline" onClick={handleViewHostHistory}>
                View Host History
              </Button>
              <Button variant="ghost" onClick={onClose} className="ml-auto">
                Close
              </Button>
            </div>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
