import { useCallback, useEffect, useState } from "react"
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock3,
  FileSearch,
  Globe,
  History,
  Link2,
  Play,
  RefreshCcw,
  SearchX,
  ShieldAlert,
  Zap,
} from "lucide-react"
import {
  type Finding,
  type MonitorStatus,
  type PatternCounts,
  getBlacklistSet,
  getFindings,
  listTrackedUrls,
} from "../api"
import { Button, Panel, Select, Skeleton, StatCard } from "./ui"
import { CountdownRing } from "./CountdownRing"
import { type View } from "./Sidebar"

interface DashboardPageProps {
  remaining: number
  intervalSec: number
  status: MonitorStatus | null
  counts: PatternCounts | null
  loadingRun: boolean
  lastUpdated: number
  onRefresh: () => void
  onManualRun: (minutes: number) => void
  onNavigate: (view: View, search?: string) => void
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

function formatDetected(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString()
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

  const [runMinutes, setRunMinutes] = useState("1")

  // ── Extra stats ────────────────────────────────────────────────
  const [blacklistCount, setBlacklistCount] = useState<number | null>(null)
  const [trackedCount, setTrackedCount] = useState<number | null>(null)
  const [recentFindings, setRecentFindings] = useState<Finding[]>([])
  const [recentLoading, setRecentLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getBlacklistSet()
      .then((data) => {
        if (!cancelled) setBlacklistCount(data.urls.length + data.ips.length)
      })
      .catch(() => {
        if (!cancelled) setBlacklistCount(null)
      })
    listTrackedUrls({ limit: 1 })
      .then((data) => {
        if (!cancelled) setTrackedCount(data.total)
      })
      .catch(() => {
        if (!cancelled) setTrackedCount(null)
      })
    return () => { cancelled = true }
  }, [])

  const fetchRecent = useCallback(() => {
    let cancelled = false
    setRecentLoading(true)
    getFindings({ limit: 5 })
      .then((data) => {
        if (!cancelled) setRecentFindings(data.items)
      })
      .catch(() => {
        if (!cancelled) setRecentFindings([])
      })
      .finally(() => {
        if (!cancelled) setRecentLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => fetchRecent(), [fetchRecent])

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
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

      {/* ── Primary stats row ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Clock3}
          label="Next Poll"
          value={<CountdownRing remaining={remaining} total={intervalSec} />}
          tone="default"
          hint="Until next ES query"
        />
        <StatCard
          icon={SearchX}
          label="Findings"
          value={status ? status.findings_count.toLocaleString() : "—"}
          tone="info"
          hint="Persisted by ES poll"
          action={
            <Button variant="ghost" size="sm" className="mt-1 h-7 text-xs" onClick={() => onNavigate("findings")}>
              View all <ArrowRight className="h-3 w-3" />
            </Button>
          }
        />
        <StatCard
          icon={ShieldAlert}
          label="Blacklist"
          value={blacklistCount !== null ? blacklistCount.toLocaleString() : "—"}
          tone="danger"
          hint="Hosts & IPs blocked"
          action={
            <Button variant="ghost" size="sm" className="mt-1 h-7 text-xs" onClick={() => onNavigate("blacklist")}>
              Manage <ArrowRight className="h-3 w-3" />
            </Button>
          }
        />
        <StatCard
          icon={Globe}
          label="Tracked URLs"
          value={trackedCount !== null ? trackedCount.toLocaleString() : "—"}
          tone="warning"
          hint="Monitored for redirects"
          action={
            <Button variant="ghost" size="sm" className="mt-1 h-7 text-xs" onClick={() => onNavigate("redirects")}>
              View all <ArrowRight className="h-3 w-3" />
            </Button>
          }
        />
      </div>

      {/* ── Secondary stats row ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          icon={Zap}
          label="ES Status"
          value={isOnline ? "Online" : "Offline"}
          tone={isOnline ? "success" : "danger"}
          hint="Elasticsearch connectivity"
        />
        <StatCard
          icon={History}
          label="Poll Interval"
          value={status ? `${status.poll_interval_minutes}m` : "—"}
          tone="default"
          hint="Automatic check frequency"
        />
      </div>

      {/* ── Manual run + Recent findings side by side ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Manual run */}
        <Panel>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
                <Play className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">Manual Run</p>
                <p className="text-xs text-muted-foreground">Trigger a one-shot ES poll</p>
              </div>
            </div>
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
        </Panel>

        {/* Recent findings */}
        <Panel
          className="lg:col-span-2"
          title="Recent Findings"
          icon={SearchX}
          action={
            <Button variant="outline" size="sm" onClick={() => onNavigate("findings")}>
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="space-y-2">
            {recentLoading ? (
              <Skeleton className="h-32 w-full rounded-md" />
            ) : recentFindings.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Client IP</th>
                      <th className="px-3 py-2 font-medium">Base URL</th>
                      <th className="px-3 py-2 font-medium">Detected</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {recentFindings.map((f) => (
                      <tr
                        key={f.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => onNavigate("findings", f.base_url)}
                      >
                        <td className="px-3 py-2 font-mono">{f.client_ip}</td>
                        <td className="max-w-[200px] truncate px-3 py-2 font-mono text-muted-foreground">
                          {f.base_url}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {formatDetected(f.log_timestamp)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No findings yet — they appear after the ES poll detects matches.
              </p>
            )}
          </div>
        </Panel>
      </div>

      {/* ── Quick links ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => onNavigate("query")}
          className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-info/40 hover:bg-info/5"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info transition-colors group-hover:bg-info/25">
            <FileSearch className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Query Console</p>
            <p className="text-xs text-muted-foreground">Live ES queries & sankey</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-info" />
        </button>

        <button
          type="button"
          onClick={() => onNavigate("graph")}
          className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-warning/40 hover:bg-warning/5"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning transition-colors group-hover:bg-warning/25">
            <Link2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Traffic Flow</p>
            <p className="text-xs text-muted-foreground">Client → server → URL graph</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-warning" />
        </button>

        <button
          type="button"
          onClick={() => onNavigate("patterns")}
          className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-success/40 hover:bg-success/5"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success transition-colors group-hover:bg-success/25">
            <Ban className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Patterns</p>
            <p className="text-xs text-muted-foreground">Manage block & whitelist rules</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-success" />
        </button>
      </div>
    </div>
  )
}
