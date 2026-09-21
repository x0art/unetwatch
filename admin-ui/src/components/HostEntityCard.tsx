import { AlertTriangle } from "lucide-react"
import { Badge } from "./ui"
import { formatBytes, type HostRisk, type HostRiskUnavailable } from "../api"

export interface HostEntityCardProps {
  /** Host is an IP + optional hostname (ADR 0001) — shown in the header only. */
  host: { hostname: string; primaryIp: string }
  risk: HostRisk
  /** Best-effort jailed flag — fail-closed to no badge when false/undefined. */
  jailed?: boolean
}

function riskBadgeVariant(level: HostRisk["riskLevel"]): "destructive" | "warning" | "success" {
  if (level === "HIGH") return "destructive"
  if (level === "MEDIUM") return "warning"
  return "success"
}

/** Render the host's real byte total, or an explicit unavailable marker when
 * nothing was persisted. Never a synthesized figure (product rule: a shown
 * number is a persisted field or explicitly unavailable). A present `0` is a
 * measured sum of persisted values, not an invented one. */
function bandwidthText(risk: HostRisk): string {
  const neverMeasured = risk.bandwidthNeverMeasured ?? risk.bandwidthDownload == null
  const total = (risk.bandwidthDownload ?? 0) + (risk.bandwidthUpload ?? 0)
  if (neverMeasured) return "Not recorded"
  return formatBytes(total)
}

/** Risk-only host summary card (ADR 0001: no MAC/dept/user identity; risk =
 * ALLOW pattern-matches, enforcements = DENY handled by the proxy).
 *
 * Two risk states are rendered distinctly, mirroring ReportPage's
 * `RiskSummaryBody`:
 *  - unavailable: the reason carries `state: "unavailable"` (ES unreachable /
 *    field mode UNKNOWN). NO score is shown; every risk-derived figure reads
 *    "Unavailable" rather than a `0` that would read as a clean host.
 *  - explained (or no reason): the measured score and figures are shown as-is.
 *    A payload with no reason at all is NOT treated as unmeasured — see the
 *    narrowing comment below.
 */
export function HostEntityCard({ host, risk, jailed }: HostEntityCardProps) {
  const label = risk.riskLevel === "HIGH" ? "HIGH" : risk.riskLevel === "MEDIUM" ? "MEDIUM" : "LOW"
  // Narrow by the discriminant, not a probe: `state` exists ONLY on the
  // unavailable variant, so this is safe under the isolated-modules build too
  // (mirrors RiskSummaryBody in ReportPage.tsx). A payload with NO reason and
  // NO riskScoreAvailable flag — an older backend or a client-side fallback
  // shape — does not satisfy this and stays on the explained path.
  const reason = risk.riskReason
  const unavailable: HostRiskUnavailable | null =
    reason && "state" in reason && reason.state === "unavailable" ? reason : null

  // Every risk-derived figure is either the measured payload value or the
  // explicit "Unavailable" marker — never a `0` standing in for an unmeasured
  // host, which would read as "clean" (CONTEXT.md: no synthesized measurements).
  const figure = (value: number): string => (unavailable ? "Unavailable" : value.toLocaleString())

  const blacklistedAllow = risk.blacklistedRequests ?? 0

  return (
    <div className="rounded-md border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <h3 className="text-xs font-medium">Risk Summary</h3>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="hidden truncate text-xs font-medium text-muted-foreground sm:inline" title={`${host.hostname || host.primaryIp} — ${figure(risk.totalRequests)} requests`}>
            {host.hostname || host.primaryIp} · {figure(risk.totalRequests)} req
          </span>
          {jailed ? <Badge variant="destructive">Jailed</Badge> : null}
        </span>
      </div>

      <div className="p-4 sm:p-5">
        {unavailable ? (
          <div className="mb-3 rounded-md border border-border bg-muted/40 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Risk not computed</p>
                <p className="text-xs text-muted-foreground">{unavailable.text}</p>
                <p className="font-mono text-xs text-muted-foreground/70">
                  reason: {unavailable.reason}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="space-y-3 font-mono text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Risk Score</span>
            {unavailable ? (
              <Badge variant="secondary">{risk.riskLevel} Unavailable</Badge>
            ) : (
              <Badge variant={riskBadgeVariant(risk.riskLevel)} className="tabular-nums">
                {label} {risk.riskScore}/100
              </Badge>
            )}
          </div>
          <div className="flex justify-between gap-3 tabular-nums">
            <span className="text-muted-foreground">Total Requests</span>
            <span className="font-bold text-foreground">{figure(risk.totalRequests)}</span>
          </div>
          <div className="flex justify-between gap-3 tabular-nums">
            <span className="text-muted-foreground">Risks (ALLOW matches)</span>
            <span className="font-bold text-destructive">{figure(risk.riskRequests)}</span>
          </div>
          {unavailable ? (
            <div className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">Blacklisted still ALLOWed</span>
              <span className="font-bold text-muted-foreground">Unavailable</span>
            </div>
          ) : blacklistedAllow > 0 ? (
            <div className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">Blacklisted still ALLOWed</span>
              <span className="font-bold text-destructive">{blacklistedAllow.toLocaleString()}</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-3 tabular-nums">
            <span className="text-muted-foreground">Enforcements (DENY)</span>
            <span className="font-bold text-foreground">
              {figure(risk.enforcements)}{" "}
              <span className="font-normal text-muted-foreground">
                ({unavailable ? "Unavailable" : `${risk.enforcementsPct.toFixed(1)}%`})
              </span>
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Bandwidth</span>
            <span className="font-bold tabular-nums text-foreground">{bandwidthText(risk)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
