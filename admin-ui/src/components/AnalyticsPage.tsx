import { useFilter } from "../contexts/FilterContext"
import { PageHeader } from "./ui"

export function AnalyticsPage() {
  const { globalFilter, timeRange } = useFilter()
  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics & Reports"
        description="KPIs, trends, and exportable reports"
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {globalFilter ? `filter: ${globalFilter}` : "no filter"} · {timeRange}
        </span>
      </PageHeader>
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Analytics content — charts and report builder compose here (Task 6+).
      </div>
    </div>
  )
}
