import { Copy, ExternalLink, X } from "lucide-react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Badge, Button, useToast } from "./ui"
import { useFilter } from "../contexts/FilterContext"
import { formatBytes } from "../api"
import { copyText } from "../lib/utils"
import { cn } from "../lib/utils"
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

/* ── CopyField — label + copy button + value ─────────────────────── */

function CopyField({
  label,
  copyValue,
  children,
}: {
  label: string
  copyValue: string
  children: React.ReactNode
}) {
  const { toast } = useToast()
  const handleCopy = async () => {
    const ok = await copyText(copyValue)
    if (ok) toast({ title: "COPIED", description: copyValue, variant: "success" })
    else toast({ title: "COPY FAILED", variant: "error" })
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="mono-label">{label}</p>
        {copyValue ? (
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b-[2px] border-border pb-1.5">
        <span className="h-1.5 w-1.5 shrink-0 bg-[#0A0A0A] dark:bg-[#F6F2E8]" aria-hidden="true" />
        <p className="font-mono text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </p>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

/* ── Props ────────────────────────────────────────────────────────── */

export interface EventInspectorSidebarProps {
  row: LogRow | null
  onClose: () => void
  onNavigate?: (view: "host" | "patterns" | "analytics" | "dashboard" | "query" | "findings" | "blacklist" | "redirects" | "logs" | "url") => void
}

/* ── Component ────────────────────────────────────────────────────── */

export function EventInspectorSidebar({ row, onClose, onNavigate }: EventInspectorSidebarProps) {
  const { setGlobalFilter } = useFilter()
  const { toast } = useToast()

  if (!row) return null

  const srcIp = getSrcIp(row)
  const srcHost = getSrcHost(row)
  const destIp = getDestIp(row)
  const durationMs = getDurationMs(row)
  const matchedRule = getMatchedRule(row)
  const rowId = getRowId(row)
  const domainVal = row.domain ?? row.base_url ?? hostOfUrl(row.url ?? "")
  const isRisky = row.action === "ALLOW" && (row as unknown as { blacklisted?: boolean }).blacklisted === true

  const handleAddToAllowList = () => {
    const host = hostOfUrl(row.url ?? "")
    const pattern = host ? `*.${host}/*` : row.url
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("pattern", pattern)
      window.history.replaceState(null, "", url.toString())
      window.localStorage.setItem("unetwatch_pattern_draft", pattern)
    } catch { /* ignore */ }
    if (onNavigate) {
      try { window.localStorage.setItem("unetwatch_view", "patterns") } catch { /* ignore */ }
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
    if (srcIp) setGlobalFilter(srcIp)
    try {
      window.localStorage.setItem("unetwatch_view", "host")
      if (!onNavigate) {
        const url = new URL(window.location.href)
        url.searchParams.set("q", srcIp)
        window.history.replaceState(null, "", url.toString())
      }
    } catch { /* ignore */ }
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

  const handleCopyJson = async () => {
    const json = JSON.stringify(row, null, 2)
    const ok = await copyText(json)
    if (ok) toast({ title: "COPIED", description: "Event JSON copied", variant: "success" })
    else toast({ title: "COPY FAILED", variant: "error" })
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-40 bg-[#0A0A0A]/30 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out"
          onClick={onClose}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed right-0 top-0 z-50 flex h-dvh w-[min(100vw,440px)] flex-col overflow-hidden",
            "border-l-[3px] border-[#0A0A0A] bg-card text-card-foreground brutal-shadow-lg dark:border-[#F6F2E8]",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
          )}
          aria-describedby={undefined}
        >
          {/* Hazard bar */}
          <div className={cn("h-1.5 w-full shrink-0", isRisky ? "bg-danger" : "bg-[#0A0A0A] dark:bg-[#F6F2E8]")} aria-hidden="true" />

          {/* Header */}
          <div className="flex shrink-0 items-start justify-between gap-3 border-b-[2.5px] border-border bg-muted/20 px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="font-display text-sm leading-tight">
                Event #{String(rowId).slice(0, 20)}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 font-mono text-[11px] text-muted-foreground">
                {row.timestamp ? new Date(row.timestamp).toLocaleString() : "—"}
              </DialogPrimitive.Description>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant={actionVariant(row.action ?? "")}>{row.action || "—"}</Badge>
                {isRisky && (
                  <span className="inline-flex items-center border-[2px] border-danger bg-danger px-1.5 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-widest text-white">
                    blacklist risk
                  </span>
                )}
                {(row as unknown as { whitelisted?: boolean }).whitelisted && (
                  <span className="inline-flex items-center border-[2px] border-[#0A0A0A] bg-[#0A0A0A] px-1.5 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-widest text-[#FFD60A] dark:border-[#F6F2E8] dark:bg-[#F6F2E8] dark:text-[#0A0A0A]">
                    whitelist
                  </span>
                )}
              </div>
            </div>
            <DialogPrimitive.Close
              aria-label="Close inspector"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center border-[2px] border-transparent hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="space-y-6 font-mono text-xs">
              {/* ── Identity ── */}
              <Section title="Source Identity">
                <CopyField label="Source IP" copyValue={srcIp}>
                  <p className="font-bold text-foreground">
                    {srcIp || "—"}
                    {srcHost ? (
                      <span className="ml-1.5 font-normal text-muted-foreground">(Host: {srcHost})</span>
                    ) : (
                      <span className="ml-1.5 font-normal text-muted-foreground">(Host: —)</span>
                    )}
                  </p>
                </CopyField>
                {row.country_code && (
                  <CopyField label="Country" copyValue={row.country_code}>
                    <p className="text-foreground">{row.country_code}</p>
                  </CopyField>
                )}
                {row.user_id && (
                  <CopyField label="User ID" copyValue={row.user_id}>
                    <p className="text-foreground">{row.user_id}</p>
                  </CopyField>
                )}
              </Section>

              {/* ── Destination ── */}
              <Section title="Destination">
                <CopyField label="Dest IP" copyValue={destIp}>
                  <p className="text-foreground">{destIp || "—"}</p>
                </CopyField>
                <CopyField label="Domain" copyValue={domainVal}>
                  <p className="text-foreground">{domainVal || "—"}</p>
                </CopyField>
                {row.category && (
                  <CopyField label="Category" copyValue={row.category}>
                    <p className="text-foreground">{row.category}</p>
                  </CopyField>
                )}
              </Section>

              {/* ── Request ── */}
              <Section title="Request">
                <CopyField label="Full URL" copyValue={row.url ?? ""}>
                  {row.url ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all text-primary hover:underline"
                    >
                      {row.url}
                      <ExternalLink className="ml-1 inline h-3 w-3 align-middle" aria-hidden="true" />
                    </a>
                  ) : (
                    <p className="text-muted-foreground">—</p>
                  )}
                </CopyField>
                <div className="grid grid-cols-2 gap-3">
                  <CopyField label="Method" copyValue={row.http_method ?? ""}>
                    <p className="text-foreground">{row.http_method || "—"}</p>
                  </CopyField>
                  <CopyField label="Status" copyValue={row.http_status_code != null ? String(row.http_status_code) : ""}>
                    <p className="tabular-nums">{row.http_status_code ?? "—"}</p>
                  </CopyField>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <CopyField label="Duration" copyValue={durationMs != null ? `${durationMs}ms` : ""}>
                    <p className="tabular-nums">{durationMs != null ? `${durationMs}ms` : "—"}</p>
                  </CopyField>
                  <CopyField
                    label="Bytes ↓ / ↑"
                    copyValue={
                      Number(row.bytes_downloaded) || Number(row.bytes_uploaded)
                        ? `↓ ${formatBytes(Number(row.bytes_downloaded) || 0)} / ↑ ${formatBytes(Number(row.bytes_uploaded) || 0)}`
                        : ""
                    }
                  >
                    {Number(row.bytes_downloaded) || Number(row.bytes_uploaded) ? (
                      <p className="tabular-nums text-foreground">
                        ↓ {formatBytes(Number(row.bytes_downloaded) || 0)} / ↑ {formatBytes(Number(row.bytes_uploaded) || 0)}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">—</p>
                    )}
                  </CopyField>
                </div>
              </Section>

              {/* ── Policy ── */}
              <Section title="Policy">
                <CopyField label="Matched Rule" copyValue={matchedRule}>
                  <p className="break-all text-muted-foreground">{matchedRule}</p>
                </CopyField>
                {(row.rule_name || row.rule_info) && (
                  <CopyField
                    label="Rule"
                    copyValue={row.rule_name && row.rule_name !== "-" ? row.rule_name : row.rule_info || ""}
                  >
                    <p className="text-muted-foreground">
                      {row.rule_name && row.rule_name !== "-" ? row.rule_name : row.rule_info || "—"}
                    </p>
                  </CopyField>
                )}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Badge variant={actionVariant(row.action ?? "")}>{row.action || "—"}</Badge>
                  {durationMs != null && (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{durationMs}ms</span>
                  )}
                </div>
              </Section>

              {/* ── Raw JSON preview ── */}
              <Section title="Raw">
                <details className="group">
                  <summary className="cursor-pointer font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground">
                    Show raw JSON
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto border-[2px] border-border bg-muted p-3 font-mono text-[10px] leading-relaxed">
                    {JSON.stringify(row, null, 2)}
                  </pre>
                </details>
              </Section>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex shrink-0 flex-wrap gap-2 border-t-[2.5px] border-border bg-muted/30 px-5 py-4">
            <Button onClick={handleAddToAllowList}>Add to Allow List</Button>
            <Button variant="outline" onClick={handleViewHostHistory}>
              View Host History
            </Button>
            <Button variant="outline" onClick={handleCopyJson}>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy JSON
            </Button>
            <Button variant="ghost" onClick={onClose} className="ml-auto">
              Close
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
