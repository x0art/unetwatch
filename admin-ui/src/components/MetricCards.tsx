import { Activity, ShieldAlert, Users, Zap } from "lucide-react"
import { StatCard } from "./ui"

export function MetricCards({
  activeHosts,
  totalRequests,
  deniedRequests,
  bandwidth,
  avgDuration,
}: {
  activeHosts: number
  totalRequests: number
  deniedRequests: number
  bandwidth: string
  avgDuration: string
}) {
  const deniedPct =
    totalRequests > 0 ? ((deniedRequests / totalRequests) * 100).toFixed(2) : "0.00"
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard icon={Users} label="Active Hosts" value={activeHosts} tone="default" />
      <StatCard
        icon={Activity}
        label="Total Requests"
        value={totalRequests.toLocaleString()}
        tone="default"
      />
      <StatCard
        icon={ShieldAlert}
        label="Denied Requests"
        value={deniedRequests.toLocaleString()}
        hint={`${deniedPct}%`}
        tone="danger"
      />
      <StatCard
        icon={Zap}
        label="Bandwidth / Avg Duration"
        value={`${bandwidth} / ${avgDuration}`}
        tone="default"
      />
    </div>
  )
}
