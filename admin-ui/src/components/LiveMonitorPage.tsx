import { useFilter } from "../contexts/FilterContext"
import { PageHeader } from "./ui"

export function LiveMonitorPage() {
  const { globalFilter, timeRange } = useFilter()
  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Traffic Monitor"
        description="Real-time log stream — Sankey + Log Inspector"
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {globalFilter ? `filter: ${globalFilter}` : "no filter"} · {timeRange}
        </span>
      </PageHeader>
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Live Monitor content — Metric KPIs, Sankey, and Log Inspector compose here (Task 3+).
      </div>
    </div>
  )
}
