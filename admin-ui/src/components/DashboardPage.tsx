import { useState } from "react"
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock3,
  FileSearch,
  Play,
  RefreshCcw,
  SearchX,
} from "lucide-react"
import { Button, Select, StatCard } from "./ui"
import { CountdownRing } from "./CountdownRing"
import { type View } from "./Sidebar"

interface DashboardPageProps {
  remaining: number
  intervalSec: number
  status: {
    status: string
    poll_interval_minutes: number
    es_online: boolean
    findings_count: number
  } | null
  counts: {
    block: number
    whitelist: number
  } | null
  loadingRun: boolean
  lastUpdated: number
  onRefresh: () => void
  onManualRun: (minutes: number) => void
  onNavigate: (view: View) => void
}

const RUN_RANGE_OPTIONS = Array.from({ length: 10 }, (_, i) => ({
  value: String(i + 1),
  label: `${i + 1} minute${i + 1 > 1 ? "s" : ""}`,
}))

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
  onNavigate,
}: DashboardPageProps) {
  const isOnline = status?.es_online ?? false
  const statusLabel = status ? (isOnline ? "Online" : "Idle") : "Unknown"

  // ── Manual run window ──────────────────────────────────────────
  const [runMinutes, setRunMinutes] = useState("1")

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            uNetWatch monitoring system overview
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full rounded-full ${
                  isOnline ? "animate-ping bg-success" : "bg-warning"
                }`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  isOnline ? "bg-success" : "bg-warning"
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
          hint="Log range for this one-shot poll"
          action={
            <div className="space-y-2">
              <Select
                value={runMinutes}
                onChange={setRunMinutes}
                options={RUN_RANGE_OPTIONS}
                aria-label="Log range for manual run"
              />
              <Button
                onClick={() => onManualRun(Number(runMinutes))}
                disabled={loadingRun}
                className="w-full"
              >
                {loadingRun ? "Running…" : "Run now"}
              </Button>
            </div>
          }
        />
      </div>

      {/* ── Findings summary ── */}
      <div className="rounded-lg border border-border/60 bg-card/60 p-4 shadow-sm backdrop-blur-[1px] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-info/15 text-info">
              <SearchX className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Detected matches</p>
              <p className="text-2xl font-bold tabular-nums tracking-tight">
                {status ? status.findings_count.toLocaleString() : "—"}
              </p>
              <p className="text-xs text-muted-foreground/60">
                Findings persisted by the ES poll
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={() => onNavigate("findings")}>
            View findings
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Query console link ── */}
      <div className="rounded-lg border border-border/60 bg-card/60 p-4 shadow-sm backdrop-blur-[1px] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-info/15 text-info">
              <FileSearch className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Query console</p>
              <p className="text-2xl font-bold tabular-nums tracking-tight">Live ES queries</p>
              <p className="text-xs text-muted-foreground/60">
                Run, chart and inspect flagged traffic directly from Elasticsearch
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={() => onNavigate("query")}>
            Open Query
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
