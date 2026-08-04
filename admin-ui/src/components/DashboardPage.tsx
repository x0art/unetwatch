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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            ELK monitoring system overview
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full animate-ping rounded-full ${
                  isRunning ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  isRunning ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
            </span>
            {statusLabel}
          </span>

          {/* Last updated */}
          <span className="text-sm text-muted-foreground">
            Updated {formatLastUpdated(lastUpdated)}
          </span>

          {/* Refresh button */}
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Refresh dashboard"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="lucide lucide-rotate-ccw"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Stat cards grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Countdown card */}
        <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div className="flex flex-col items-center gap-2 p-4 sm:p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Next Poll
            </div>
            <CountdownRing remaining={remaining} total={intervalSec} />
            <p className="text-xs text-muted-foreground">
              until the next ES query
            </p>
          </div>
        </div>

        {/* Block card */}
        <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm transition-all duration-300 hover:shadow-md hover:border-border/80">
          <div className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Block Patterns</p>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-destructive/70"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="m15 9-6 6" />
                <path d="m9 9 6 6" />
              </svg>
            </div>
            <p className="mt-3 text-3xl font-bold tabular-nums tracking-tight">
              {counts?.block ?? "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              URL patterns to flag
            </p>
          </div>
        </div>

        {/* Whitelist card */}
        <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm transition-all duration-300 hover:shadow-md hover:border-border/80">
          <div className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Whitelist Patterns</p>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-emerald-500/70"
                aria-hidden="true"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <p className="mt-3 text-3xl font-bold tabular-nums tracking-tight">
              {counts?.whitelist ?? "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              URL patterns to allow
            </p>
          </div>
        </div>

        {/* Manual run card */}
        <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Manual Run</p>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground"
                aria-hidden="true"
              >
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
            </div>
            <button
              type="button"
              disabled={loadingRun}
              onClick={onManualRun}
              className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              {loadingRun ? (
                <>
                  <svg
                    className="mr-2 h-4 w-4 animate-spin"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Running...
                </>
              ) : (
                "Trigger Now"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Dimmed findings-ready card */}
      <div className="rounded-lg border border-border/60 bg-card/60 text-card-foreground shadow-sm backdrop-blur-[1px]">
        <div className="p-4 sm:p-6">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-muted">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-muted-foreground"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground/80">Findings</p>
                <p className="mt-1 text-xs text-muted-foreground/60 max-w-lg">
                  Detected log matches will appear here. Navigate to the Findings view for
                  full details once findings are available.
                </p>
              </div>
            </div>
            <span className="inline-flex items-center rounded-full border border-border/40 bg-muted/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Coming soon
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}