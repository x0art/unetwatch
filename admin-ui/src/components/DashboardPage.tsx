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
import { Button, Panel, RefreshIntervalSelect, Skeleton, StatCard, useToast } from "./ui"
import { CountdownRing } from "./CountdownRing"
import { useAutoRefresh, usePageVisible } from "../lib/utils"
import { type View } from "./Sidebar"

interface DashboardPageProps {
  remaining: number
  intervalSec: number
  status: MonitorStatus | null
  counts: PatternCounts | null
  lastUpdated: number
  onRefresh: () => void
  onNavigate: (view: View, search?: string) => void
}

function formatLastUpdated(timestamp: number) {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 10) return "JUST NOW"
  if (seconds < 60) return `${seconds}S AGO`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}M AGO`
  const hours = Math.floor(minutes / 60)
  return `${hours}H AGO`
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
  lastUpdated,
  onRefresh,
  onNavigate,
}: DashboardPageProps) {
  const isOnline = status?.es_online ?? false
  const statusLabel = status ? (isOnline ? "ONLINE" : "IDLE") : "UNKNOWN"
  const pageVisible = usePageVisible()
  const { toast } = useToast()

  const banner =
    counts !== null && counts.block === 0
      ? {
          kind: "setup" as const,
          title: "NO BLOCK PATTERNS YET",
          description: "ADD BLOCK PATTERNS TO START FLAGGING TRAFFIC.",
          actionLabel: "ADD PATTERNS",
          action: () => onNavigate("patterns"),
        }
      : status !== null && !status.es_online
        ? {
            kind: "offline" as const,
            title: "ELASTICSEARCH UNREACHABLE",
            description: "MONITORING IS PAUSED. CHECK THE CLUSTER, THEN RETRY.",
            actionLabel: "RETRY",
            action: onRefresh,
          }
        : null

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
        if (!cancelled) { setBlacklistCount(null); toast({ title: "Failed to load blacklist count", variant: "error" }) }
      })
    listTrackedUrls({ limit: 1 })
      .then((data) => {
        if (!cancelled) setTrackedCount(data.total)
      })
      .catch(() => {
        if (!cancelled) { setTrackedCount(null); toast({ title: "Failed to load tracked URL count", variant: "error" }) }
      })
    return () => { cancelled = true }
  }, [toast])

  const fetchRecent = useCallback(() => {
    let cancelled = false
    setRecentLoading(true)
    getFindings({ limit: 5 })
      .then((data) => {
        if (!cancelled) setRecentFindings(data.items)
      })
      .catch(() => {
        if (!cancelled) { setRecentFindings([]); toast({ title: "Failed to load recent findings", variant: "error" }) }
      })
      .finally(() => {
        if (!cancelled) setRecentLoading(false)
      })
    return () => { cancelled = true }
  }, [toast])

  useEffect(() => fetchRecent(), [fetchRecent])

  const refreshAll = useCallback(() => {
    onRefresh()
    fetchRecent()
  }, [onRefresh, fetchRecent])
  const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refreshAll, "dashboard", 60)

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="rounded-md border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 bg-danger border border-border shrink-0" aria-hidden="true" />
              <span className="mono-label">[ DASHBOARD // UNETWATCH ]</span>
            </div>
            <h2 className="mt-1 text-[30px] font-semibold tracking-tight sm:text-[36px]">DASHBOARD</h2>
            <p className="mt-1 max-w-[52ch] text-xs font-medium text-muted-foreground">
              LIVE POLL HEALTH — FINDINGS — REDIRECT WATCH
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-sm">
              <span className="relative flex h-2.5 w-2.5 border border-border">
                {pageVisible && isOnline && (
                  <span className="absolute inset-0 animate-ping bg-foreground" />
                )}
                <span className={`absolute inset-0 ${isOnline ? "bg-foreground" : "bg-danger"}`} />
              </span>
              {statusLabel}
            </span>
            <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium tabular-nums">{formatLastUpdated(lastUpdated)}</span>
            <RefreshIntervalSelect value={refreshSeconds} onChange={setRefreshSeconds} />
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCcw className="h-4 w-4" />
              REFRESH
            </Button>
          </div>
        </div>
      </div>

      {/* ── Banner ── */}
      {banner && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-secondary p-4 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
            {banner.kind === "setup" ? <ShieldAlert className="h-5 w-5" aria-hidden="true" /> : <RefreshCcw className="h-5 w-5" aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{banner.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{banner.description}</p>
          </div>
          <Button size="sm" variant="outline" onClick={banner.action} className="bg-card">
            {banner.actionLabel}
          </Button>
        </div>
      )}

      {/* ── Primary stats — bento with hard slabs ── */}
      <div className="grid gap-3 lg:grid-cols-12">
        <div className="lg:col-span-3">
          <StatCard
            icon={Clock3}
            label="Next Poll"
            value={<CountdownRing remaining={remaining} total={intervalSec} />}
            tone="default"
            hint="UNTIL NEXT ES QUERY"
          />
        </div>
        <div className="lg:col-span-5">
          <StatCard
            icon={SearchX}
            label="Findings"
            value={status ? status.findings_count.toLocaleString() : "—"}
            tone="info"
            hint="PERSISTED BY ES POLL"
            action={
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onNavigate("findings")}>
                VIEW ALL <ArrowRight className="h-3 w-3" />
              </Button>
            }
          />
        </div>
        <div className="lg:col-span-2">
          <StatCard
            icon={ShieldAlert}
            label="Blacklist"
            value={blacklistCount !== null ? blacklistCount.toLocaleString() : "—"}
            tone="danger"
            hint="HOSTS & IPS BLOCKED"
            action={
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onNavigate("blacklist")}>
                MANAGE <ArrowRight className="h-3 w-3" />
              </Button>
            }
          />
        </div>
        <div className="lg:col-span-2">
          <StatCard
            icon={Globe}
            label="Tracked URLs"
            value={trackedCount !== null ? trackedCount.toLocaleString() : "—"}
            tone="warning"
            hint="MONITORED FOR REDIRECTS"
            action={
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onNavigate("redirects")}>
                VIEW ALL <ArrowRight className="h-3 w-3" />
              </Button>
            }
          />
        </div>
      </div>

      {/* ── Secondary stats ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Ban} label="Block Patterns" value={counts?.block ?? "—"} tone="danger" hint="URL PATTERNS TO FLAG" />
        <StatCard icon={CheckCircle2} label="Whitelist" value={counts?.whitelist ?? "—"} tone="default" hint="PATTERNS TO ALLOW" />
        <StatCard icon={Zap} label="ES Status" value={isOnline ? "ONLINE" : "OFFLINE"} tone={isOnline ? "default" : "danger"} hint="ES CONNECTIVITY" />
        <StatCard icon={History} label="Poll Interval" value={status ? `${status.poll_interval_minutes}M` : "—"} tone="default" hint="AUTO CHECK FREQUENCY" />
      </div>

      {/* ── Recent findings ── */}
      <Panel title="RECENT FINDINGS" icon={SearchX} action={<Button variant="outline" size="sm" onClick={() => onNavigate("findings")}>VIEW ALL <ArrowRight className="h-3.5 w-3.5" /></Button>}>
          <div className="space-y-2">
            {recentLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : recentFindings.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-border bg-card">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted text-muted-foreground">
                      <th className="px-3 py-2 text-left text-xs font-medium">CLIENT IP</th>
                      <th className="px-3 py-2 text-left text-xs font-medium">BASE URL</th>
                      <th className="px-3 py-2 text-left text-xs font-medium">DETECTED</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {recentFindings.map((f) => (
                      <tr key={f.id} className="cursor-pointer hover:bg-muted/50" onClick={() => onNavigate("findings", f.base_url)}>
                        <td className="px-3 py-2 font-mono font-medium">{f.client_ip}</td>
                        <td className="max-w-[200px] truncate px-3 py-2 font-mono text-muted-foreground">{f.base_url}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">{formatDetected(f.log_timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-6 text-center text-xs font-medium text-muted-foreground">
                NO FINDINGS YET — THEY APPEAR AFTER THE ES POLL DETECTS MATCHES.
              </p>
            )}
          </div>
        </Panel>

      {/* ── Quick links ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <button
          type="button"
          onClick={() => onNavigate("query")}
          className="group relative flex items-center gap-4 rounded-md border border-border bg-card p-5 text-left shadow-sm active:scale-[0.98] lg:col-span-3 lg:p-6"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-info text-white">
            <FileSearch className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight">QUERY CONSOLE</p>
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">LIVE ES QUERIES & ACCESS-FLOW</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
        </button>

        <div className="grid grid-cols-1 gap-3 lg:col-span-2">
          <button
            type="button"
            onClick={() => onNavigate("query")}
            className="group flex items-center gap-3 rounded-md border border-border bg-card p-4 text-left shadow-sm active:scale-[0.98]"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <Link2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-tight">TRAFFIC FLOW</p>
              <p className="text-xs font-medium text-muted-foreground">CLIENT → SERVER → URL</p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate("patterns")}
            className="group flex items-center gap-3 rounded-md border border-border bg-card p-4 text-left shadow-sm active:scale-[0.98]"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
              <Ban className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-tight">PATTERNS</p>
              <p className="text-xs font-medium text-muted-foreground">BLOCK & WHITELIST RULES</p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </button>
        </div>
      </div>
    </div>
  )
}
