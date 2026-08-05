import { useCallback, useEffect, useState } from "react"
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock3,
  Globe,
  Play,
  RefreshCcw,
  SearchX,
  Users,
} from "lucide-react"
import {
  type MonitorMetrics,
  getMonitorMetrics,
} from "../api"
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

const WINDOW_OPTIONS = [
  { value: "15", label: "Last 15 minutes" },
  { value: "60", label: "Last hour" },
  { value: "360", label: "Last 6 hours" },
  { value: "1440", label: "Last 24 hours" },
]

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

function MetricBars({ rows }: { rows: { label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="space-y-3.5">
      {rows.map((r) => (
        <div
          key={r.label}
          title={`${r.label} — ${r.count} request${r.count === 1 ? "" : "s"}`}
        >
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-mono text-muted-foreground">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {r.count.toLocaleString()}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="metric-bar h-full rounded-full bg-primary/70"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
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

  // ── URL metrics ────────────────────────────────────────────────
  const [runMinutes, setRunMinutes] = useState("1")
  const [windowMinutes, setWindowMinutes] = useState("60")
  const [metrics, setMetrics] = useState<MonitorMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [metricsError, setMetricsError] = useState<string | null>(null)

  const fetchMetrics = useCallback(async () => {
    setMetricsLoading(true)
    setMetricsError(null)
    try {
      const m = await getMonitorMetrics(Number(windowMinutes))
      setMetrics(m)
    } catch (e) {
      setMetricsError((e as Error).message)
      setMetrics(null)
    } finally {
      setMetricsLoading(false)
    }
  }, [windowMinutes])

  useEffect(() => {
    fetchMetrics()
  }, [fetchMetrics, lastUpdated])

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

      {/* ── URL metrics ── */}
      <div className="rounded-lg border border-border/60 bg-card/60 p-4 shadow-sm backdrop-blur-[1px] sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold tracking-tight">URL Metrics</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Flagged traffic matching block patterns
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Window</span>
            <Select
              value={windowMinutes}
              onChange={setWindowMinutes}
              options={WINDOW_OPTIONS}
              className="w-44"
              aria-label="Metrics time window"
            />
          </div>
        </div>

        {metricsLoading ? (
          <div className="mt-6 space-y-3" aria-busy="true">
            <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
            <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
            <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
          </div>
        ) : metricsError ? (
          <p className="mt-6 text-sm text-destructive">{metricsError}</p>
        ) : !metrics ? null : !metrics.es_online ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
            <Globe className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium text-muted-foreground">
              Elasticsearch unreachable
            </p>
            <p className="text-xs text-muted-foreground/60">
              Metrics will appear once the ES connection is restored.
            </p>
          </div>
        ) : metrics.total_requests === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
            <SearchX className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium text-muted-foreground">
              No flagged traffic in this window
            </p>
            <p className="text-xs text-muted-foreground/60">
              Try a longer window or trigger a manual run.
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <div className="grid max-w-md grid-cols-2 gap-3">
              <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3">
                <p className="text-xs text-muted-foreground">Total requests</p>
                <p className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight">
                  {metrics.total_requests.toLocaleString()}
                </p>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3">
                <p className="text-xs text-muted-foreground">Unique IPs</p>
                <p className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight">
                  {metrics.unique_ips.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <h4 className="text-sm font-medium">Top URLs accessed</h4>
                </div>
                <MetricBars
                  rows={metrics.top_urls.map((u) => ({
                    label: u.url,
                    count: u.count,
                  }))}
                />
              </div>
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <h4 className="text-sm font-medium">Top client IPs</h4>
                </div>
                <MetricBars
                  rows={metrics.top_ips.map((u) => ({
                    label: u.client_ip,
                    count: u.count,
                  }))}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
