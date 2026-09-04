import { Badge } from "./ui"
import type { HostRisk } from "../api"

export interface HostEntityCardProps {
  /** Host is an IP + optional hostname (ADR 0001) — shown in the header only. */
  host: { hostname: string; primaryIp: string }
  risk: HostRisk
}

function riskBadgeVariant(level: HostRisk["riskLevel"]): "destructive" | "warning" | "success" {
  if (level === "HIGH") return "destructive"
  if (level === "MEDIUM") return "warning"
  return "success"
}

/** Risk-only host summary card (ADR 0001: no MAC/dept/user identity; risk =
 * ALLOW pattern-matches, enforcements = DENY handled by the proxy). */
export function HostEntityCard({ host, risk }: HostEntityCardProps) {
  const variant = riskBadgeVariant(risk.riskLevel)
  const label = risk.riskLevel === "HIGH" ? "HIGH" : risk.riskLevel === "MEDIUM" ? "MEDIUM" : "LOW"

  const blacklistedAllow = risk.blacklistedRequests ?? 0

  return (
    <div className="brutal-card overflow-hidden">
      <div className="flex items-center gap-2 border-b-[2.5px] border-border bg-muted/40 px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <h3 className="font-mono text-xs font-extrabold uppercase tracking-widest">Risk Summary</h3>
        <span className="ml-auto hidden truncate font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground sm:inline">
          {host.hostname || host.primaryIp} · {risk.totalRequests.toLocaleString()} req
        </span>
      </div>

      <div className="p-4 sm:p-5">
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
            <span className="text-muted-foreground">Risks (ALLOW matches)</span>
            <span className="font-bold text-destructive">{risk.riskRequests.toLocaleString()}</span>
          </div>
          {blacklistedAllow > 0 && (
            <div className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">Blacklisted still ALLOWed</span>
              <span className="font-bold text-destructive">{blacklistedAllow.toLocaleString()}</span>
            </div>
          )}
          <div className="flex justify-between gap-3 tabular-nums">
            <span className="text-muted-foreground">Enforcements (DENY)</span>
            <span className="font-bold text-foreground">
              {risk.enforcements.toLocaleString()}{" "}
              <span className="font-normal text-muted-foreground">({risk.enforcementsPct.toFixed(1)}%)</span>
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Bandwidth</span>
            <span className="font-bold tabular-nums text-foreground">{risk.bandwidth}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
