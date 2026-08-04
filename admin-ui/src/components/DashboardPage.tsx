import {
  Ban,
  CheckCircle2,
  Clock3,
  Play,
  RefreshCcw,
  SearchX,
} from "lucide-react"
import { Button, StatCard } from "./ui"
import { CountdownRing } from "./CountdownRing"

interface DashboardPageProps {
  remaining: number
  intervalSec: number
  status: {
    status: string
    poll_interval_minutes: number
  } | null
  counts: {
    block: number
    whitelist: number
  } | null
  loadingRun: boolean
  lastUpdated: number
  onRefresh: () => void
  onManualRun: () => void
}

function formatLastUpdated(timestamp: number) {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

export function DashboardPage({
  remaining,
  intervalSec,
  status,
  counts,
  loadingRun,
  lastUpdated,
  onRefresh,
  onManualRun,
}: DashboardPageProps) {
  const isRunning = status?.status === "running"
  const statusLabel = isRunning ? "Live" : "Idle"

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            ELK monitoring system overview
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full animate-ping rounded-full ${
                  isRunning ? "bg-success" : "bg-warning"
                }`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  isRunning ? "bg-success" : "bg-warning"
                }`}
              />
            </span>
            {statusLabel}
          </span>
          <span>Updated {formatLastUpdated(lastUpdated)}</span>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Clock3}
          label="Next Poll"
          value={<CountdownRing remaining={remaining} total={intervalSec} />}
          tone="default"
          hint="Approx. until next ES query"
        />

        <StatCard
          icon={Ban}
          label="Block Patterns"
          value={counts?.block ?? "—"}
          tone="danger"
          hint="URL patterns to flag"
        />

        <StatCard
          icon={CheckCircle2}
          label="Whitelist Patterns"
          value={counts?.whitelist ?? "—"}
          tone="success"
          hint="URL patterns to allow"
        />

        <StatCard
          icon={Play}
          label="Manual Run"
          value={loadingRun ? "Running" : "Trigger Now"}
          tone="info"
          hint="Kick off a one-shot poll"
          action={
            <Button
              onClick={onManualRun}
              disabled={loadingRun}
              className="w-full"
            >
              {loadingRun ? "Running…" : "Run now"}
            </Button>
          }
        />
      </div>

      <div className="rounded-lg border border-border/60 bg-card/60 p-4 shadow-sm backdrop-blur-[1px] sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <SearchX className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground/80">Findings</p>
              <p className="mt-1 max-w-lg text-sm text-muted-foreground/60">
                Detected log matches will appear here. Navigate to Findings for full details once
                findings are available.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center rounded-full border border-border/40 bg-muted/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Coming soon
          </span>
        </div>
      </div>
    </div>
  )
}
