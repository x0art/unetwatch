import { useFilter } from "../contexts/FilterContext"
import { PageHeader } from "./ui"

export function HostInspectorPage() {
  const { globalFilter, timeRange } = useFilter()
  return (
    <div className="space-y-5">
      <PageHeader
        title="Host Inspector"
        description="Per-host drill-down — sessions, timelines, and IOC details"
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {globalFilter ? `filter: ${globalFilter}` : "no filter"} · {timeRange}
        </span>
      </PageHeader>
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Host Inspector content — host table, session timeline, and IOC panels compose here (Task 4+).
      </div>
    </div>
  )
}
