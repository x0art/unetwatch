import { Badge } from "./ui"
import type { HostIdentity, HostRisk } from "../api"

export interface HostEntityCardProps {
  host: HostIdentity
  risk: HostRisk
}

function riskBadgeVariant(level: HostRisk["riskLevel"]): "destructive" | "warning" | "success" {
  if (level === "HIGH") return "destructive"
  if (level === "MEDIUM") return "warning"
  return "success"
}

export function HostEntityCard({ host, risk }: HostEntityCardProps) {
  const variant = riskBadgeVariant(risk.riskLevel)
  const label = risk.riskLevel === "HIGH" ? "HIGH" : risk.riskLevel === "MEDIUM" ? "MEDIUM" : "LOW"

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <h3 className="font-mono text-xs font-bold uppercase tracking-widest">Host Entity &amp; Risk Summary</h3>
        <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground tabular-nums sm:inline">
          {risk.totalRequests.toLocaleString()} req · {risk.deniedFlagged.toLocaleString()} flagged
        </span>
      </div>

      <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        {/* Left: Host Identity & Specs */}
        <div className="p-4 sm:p-5">
          <p className="mono-label mb-3">HOST IDENTITY &amp; SPECS</p>
          <dl className="space-y-2.5 font-mono text-[13px] leading-relaxed">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Hostname</dt>
              <dd className="max-w-[60%] truncate text-right font-semibold text-foreground">{host.hostname}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">MAC Addr</dt>
              <dd className="text-right font-medium tabular-nums text-foreground">{host.mac}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Primary IP</dt>
              <dd className="text-right font-semibold tabular-nums text-foreground">{host.primaryIp}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Assigned</dt>
              <dd className="max-w-[60%] truncate text-right font-medium text-foreground">
                {host.assignedDept} <span className="font-normal text-muted-foreground">/</span> <span className="font-semibold">{host.user}</span>
              </dd>
            </div>
            <div className="pt-1">
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest">
                {host.primaryIp}
              </span>
            </div>
          </dl>
        </div>

        {/* Right: Risk Profile & Metrics */}
        <div className="p-4 sm:p-5">
          <p className="mono-label mb-3">RISK PROFILE &amp; METRICS</p>
          <div className="space-y-3 font-mono text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Risk Score</span>
              <Badge variant={variant} className="tabular-nums">
                {label} {risk.riskScore}/100
              </Badge>
            </div>
            <div className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">Total Requests</span>
              <span className="font-bold text-foreground">{risk.totalRequests.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">Denied/Flagged</span>
              <span className="font-bold text-foreground">
                {risk.deniedFlagged.toLocaleString()}{" "}
                <span className="font-normal text-muted-foreground">({risk.deniedPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Total Bandwidth</span>
              <span className="font-bold tabular-nums text-foreground">{risk.bandwidth}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
