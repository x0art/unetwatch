import * as DialogPrimitive from "@radix-ui/react-dialog"
import { motion } from "framer-motion"
import { ExternalLink, X } from "lucide-react"
import { Badge, Button, useToast } from "./ui"
import { useFilter } from "../contexts/FilterContext"
import {
  getSrcIp,
  getSrcHost,
  getDestIp,
  getDurationMs,
  getMatchedRule,
  getRowId,
  actionVariant,
  hostOfUrl,
  type LogRow,
} from "../lib/logRow"

export interface InspectionDrawerProps {
  row: LogRow
  onClose: () => void
  /** Optional navigation callback — when provided, drawer actions navigate directly to the target view. */
  onNavigate?: (view: "live" | "host" | "patterns" | "analytics" | "settings" | "dashboard" | "query" | "findings" | "graph" | "blacklist" | "redirects" | "logs") => void
}

export function InspectionDrawer({ row, onClose, onNavigate }: InspectionDrawerProps) {
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
    // Persist the wildcard draft so Pattern Manager can auto-open the simulation
    // drawer pre-filled (brief §7 workflow: Inspect → Rule Generation prefill).
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("pattern", pattern)
      window.history.replaceState(null, "", url.toString())
      window.localStorage.setItem("unetwatch_pattern_draft", pattern)
    } catch {
      /* ignore */
    }
    if (onNavigate) {
      try {
        window.localStorage.setItem("unetwatch_view", "patterns")
      } catch {
        /* ignore */
      }
      onNavigate("patterns")
      onClose()
    }
    toast({
      title: "Pattern draft",
      description: `Allow-list candidate: ${pattern} — simulating in Pattern Manager.`,
      variant: "info",
    })
  }

  const handleViewHostHistory = () => {
    // setGlobalFilter drives the global workspace filter and debounces ?q=
    // into the URL — no need for a second synchronous replaceState that
    // would race with the 250ms debounce in the context. The view persists
    // separately so the next navigation lands on Host Inspector.
    if (srcIp) setGlobalFilter(srcIp)
    try {
      window.localStorage.setItem("unetwatch_view", "host")
      // Only synchronously stamp ?q= when there's no onNavigate (standalone
      // page) so the URL is immediately shareable; the delegated path relies
      // on the context debounce instead to avoid competing history writes.
      if (!onNavigate) {
        const url = new URL(window.location.href)
        url.searchParams.set("q", srcIp)
        window.history.replaceState(null, "", url.toString())
      }
    } catch {
      /* ignore */
    }
    if (onNavigate) {
      onNavigate("host")
      onClose()
    }
    toast({
      title: `Host filter: ${srcIp}`,
      description: "Global filter updated — open Host Inspector to see history.",
      variant: "info",
    })
    if (!onNavigate) onClose()
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
