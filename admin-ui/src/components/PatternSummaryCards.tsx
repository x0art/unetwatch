import { FileText, Flag, ListFilter, ShieldAlert } from "lucide-react"
import type { PatternStats } from "../api"
import { StatCard } from "./ui"

export function PatternSummaryCards({ stats }: { stats: PatternStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard icon={ListFilter} label="Total Active Rules" value={`${stats.totalActive} Rules`} />
      <StatCard icon={Flag} label="Flagged Matches 24h" value={`${stats.flagged24h.toLocaleString()} Hits`} tone="warning" />
      <StatCard icon={ShieldAlert} label="High-Risk Patterns" value={`${stats.highRisk} Rules`} tone="danger" />
      <StatCard icon={FileText} label="Pending Drafts" value={`${stats.pendingDrafts} Patterns`} />
    </div>
  )
}
