import { Activity, ShieldAlert, Users, Zap } from "lucide-react"
import { StatCard } from "./ui"
import { useFilter } from "../contexts/FilterContext"

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
  const { setGlobalFilter, setActionFilter } = useFilter()
  const deniedPct =
    totalRequests > 0 ? ((deniedRequests / totalRequests) * 100).toFixed(2) : "0.00"
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon={Users}
        label="Active Hosts"
        value={activeHosts}
        tone="default"
        onClick={() => setGlobalFilter("")}
      />
      <StatCard
        icon={Activity}
        label="Total Requests"
        value={totalRequests.toLocaleString()}
        tone="default"
        onClick={() => setGlobalFilter("")}
      />
      <StatCard
        icon={ShieldAlert}
        label="Denied Requests"
        value={deniedRequests.toLocaleString()}
        hint={`${deniedPct}%`}
        tone="danger"
        onClick={() => setActionFilter("DENY")}
      />
      <StatCard
        icon={Zap}
        label="Bandwidth / Avg Duration"
        value={`${bandwidth} / ${avgDuration}`}
        tone="default"
        onClick={() => setGlobalFilter("")}
      />
    </div>
  )
}
