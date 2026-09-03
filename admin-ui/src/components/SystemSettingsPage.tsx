import { useFilter } from "../contexts/FilterContext"
import { PageHeader } from "./ui"

export function SystemSettingsPage() {
  const { globalFilter, timeRange } = useFilter()
  return (
    <div className="space-y-5">
      <PageHeader
        title="System Settings"
        description="Configuration, health checks, and audit logs"
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {globalFilter ? `filter: ${globalFilter}` : "no filter"} · {timeRange}
        </span>
      </PageHeader>
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        System Settings content — config editors, health dashboard, and audit log compose here (Task 7+).
      </div>
    </div>
  )
}
