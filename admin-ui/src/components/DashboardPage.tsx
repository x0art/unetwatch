import { useCallback, useEffect, useRef, useState } from "react"
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
import { Button, Callout, EmptyState, PageShell, Panel, RefreshIntervalSelect, SimpleTable, Skeleton, SkeletonShape, StatCard, StatusBadge, useToast } from "./ui"
import { CountdownRing } from "./CountdownRing"
import { useAbortable, useAutoRefresh, useGeneration } from "../lib/utils"
import { LoadingIndicator } from "./loading"
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
  if (seconds < 10) return "Just now"
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
  lastUpdated,
  onRefresh,
  onNavigate,
}: DashboardPageProps) {
  const isOnline = status?.es_online ?? false
  const statusLabel = status ? (isOnline ? "Online" : "Idle") : "Unknown"
  const { toast } = useToast()

  const banner =
    counts !== null && counts.block === 0
      ? {
          kind: "setup" as const,
          title: "No block patterns yet",
          description: "Add block patterns to start flagging traffic.",
          actionLabel: "Add patterns",
          action: () => onNavigate("patterns"),
        }
      : status !== null && !status.es_online
        ? {
            kind: "offline" as const,
            title: "Elasticsearch unreachable",
            description: "Monitoring is paused. Check the cluster, then retry.",
            actionLabel: "Retry",
            action: onRefresh,
          }
        : null

  const [blacklistCount, setBlacklistCount] = useState<number | null>(null)
  const [blacklistError, setBlacklistError] = useState<string | null>(null)
  const [trackedCount, setTrackedCount] = useState<number | null>(null)
  const [trackedError, setTrackedError] = useState<string | null>(null)
  const [recentFindings, setRecentFindings] = useState<Finding[]>([])
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentError, setRecentError] = useState<string | null>(null)
  const [recentLoadingStartedAt, setRecentLoadingStartedAt] = useState<number | undefined>(undefined)
  const fetchBlacklistCount = useCallback(() => {
    let cancelled = false
    setBlacklistError(null)
    getBlacklistSet()
      .then((data) => {
        if (!cancelled) setBlacklistCount(data.urls.length + data.ips.length)
      })
      .catch((e) => {
        if (!cancelled) {
          setBlacklistCount(null)
          setBlacklistError((e as Error).message)
          toast({ title: "Failed to load blacklist count", variant: "error" })
        }
      })
    return () => { cancelled = true }
  }, [toast])

  const fetchTrackedCount = useCallback(() => {
    let cancelled = false
    setTrackedError(null)
    listTrackedUrls({ limit: 1 })
      .then((data) => {
        if (!cancelled) setTrackedCount(data.total)
      })
      .catch((e) => {
        if (!cancelled) {
          setTrackedCount(null)
          setTrackedError((e as Error).message)
          toast({ title: "Failed to load tracked URL count", variant: "error" })
        }
      })
    return () => { cancelled = true }
  }, [toast])

  useEffect(() => {
    const cancelBlacklist = fetchBlacklistCount()
    const cancelTracked = fetchTrackedCount()
    return () => { cancelBlacklist(); cancelTracked() }
  }, [fetchBlacklistCount, fetchTrackedCount])

  // `getFindings` is a plain READ, so it can be aborted; the generation keeps
  // the poll tick honest — useAutoRefresh discards a callback's cleanup, so an
  // abort alone cannot await a superseded read there.
  const runRecent = useAbortable()
  const recentGen = useGeneration()
  const recentLoadedRef = useRef(false)

  // Returns its promise so useAutoRefresh can skip a tick while this read is
  // pending (a poll tick must skip, never overlap).
  const fetchRecent = useCallback(() => {
    const g = recentGen.next()
    const isFirstLoad = !recentLoadedRef.current
    setRecentLoading(true)
    setRecentError(null)
    setRecentLoadingStartedAt(Date.now())
    return runRecent((signal) => getFindings({ limit: 5 }, { signal }))
      .then((data) => {
        if (data === undefined || !recentGen.isCurrent(g)) return
        setRecentFindings(data.items)
        recentLoadedRef.current = true
      })
      .catch((e) => {
        if (!recentGen.isCurrent(g)) return
        if ((e as Error).name === "AbortError") return
        // Never blank the recent list on a FAILED refetch; a failed first load
        // has nothing to keep, so it may still reset (§4.6 never-blank).
        if (isFirstLoad) setRecentFindings([])
        setRecentError((e as Error).message)
        toast({ title: "Failed to load recent findings", variant: "error" })
      })
      .finally(() => {
        if (recentGen.isCurrent(g)) setRecentLoading(false)
      })
  }, [runRecent, recentGen, toast])

  useEffect(() => {
    void fetchRecent()
  }, [fetchRecent])

  // Returns the findings promise so useAutoRefresh's in-flight skip actually
  // engages: a `{}` body (returning undefined) left the flag unset, so 60s
  // ticks could overlap a slow read.
  const refreshAll = useCallback(() => {
    onRefresh()
    return fetchRecent()
  }, [onRefresh, fetchRecent])
  const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refreshAll, "dashboard", 60)

  /* The canonical page shell: `space-y-5` root + the one `PageHeader` title.
     Actions live in the title row per §2.3; previously this was a bespoke hero
     card duplicating a title the shell also tried (and failed) to render. */
  return (
    <PageShell
      title="Dashboard"
      description="Live poll health, findings, and redirect watch."
      actions={
        <>
          <StatusBadge tone={isOnline ? "success" : "danger"} dot>{statusLabel}</StatusBadge>
          <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium tabular-nums">{formatLastUpdated(lastUpdated)}</span>
          <RefreshIntervalSelect value={refreshSeconds} onChange={setRefreshSeconds} />
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        </>
      }
    >

      {/* ── Banner ── */}
      {banner && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-secondary p-4 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
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

      {/* ── Primary stats — soft cards ── */}
      <div className="grid gap-3 lg:grid-cols-12">
        <div className="lg:col-span-3">
          <StatCard
            icon={Clock3}
            label="Next Poll"
            value={<CountdownRing remaining={remaining} total={intervalSec} />}
            tone="default"
            hint="Until next ES query"
          />
        </div>
        <div className="lg:col-span-5">
          <StatCard
            icon={SearchX}
            label="Findings"
            value={status ? status.findings_count.toLocaleString() : "—"}
            tone="info"
            hint="Persisted by ES poll"
            action={
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onNavigate("findings")}>
                View all <ArrowRight className="h-3 w-3" />
              </Button>
            }
          />
        </div>
        <div className="lg:col-span-2">
          <StatCard
            icon={ShieldAlert}
            label="Blacklist"
            value={
              // Honest loading: an unread count is unknown, never 0 — a
              // shape-mirroring skeleton keeps the card's box while the read
              // runs, and `—` stays reserved for a genuine failure (below).
              blacklistCount !== null
                ? blacklistCount.toLocaleString()
                : blacklistError === null
                  ? <Skeleton className="h-9 w-16" />
                  : "—"
            }
            tone="danger"
            hint="Hosts & IPs blocked"
            action={
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onNavigate("blacklist")}>
                Manage <ArrowRight className="h-3 w-3" />
              </Button>
            }
          />
        </div>
        <div className="lg:col-span-2">
          <StatCard
            icon={Globe}
            label="Tracked URLs"
            value={
              trackedCount !== null
                ? trackedCount.toLocaleString()
                : trackedError === null
                  ? <Skeleton className="h-9 w-16" />
                  : "—"
            }
            tone="warning"
            hint="Monitored for redirects"
            action={
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onNavigate("redirects")}>
                View all <ArrowRight className="h-3 w-3" />
              </Button>
            }
          />
        </div>
      </div>

      {/* Inline error panels — keep toasts too */}
      {(blacklistError || trackedError) && (
        <div className="space-y-2">
          {blacklistError && (
            <Callout action={<Button variant="outline" size="sm" onClick={() => { void fetchBlacklistCount() }}>Retry</Button>}>
              Blacklist count failed to load — {blacklistError}
            </Callout>
          )}
          {trackedError && (
            <Callout action={<Button variant="outline" size="sm" onClick={() => { void fetchTrackedCount() }}>Retry</Button>}>
              Tracked count failed to load — {trackedError}
            </Callout>
          )}
        </div>
      )}

      {/* ── Secondary stats ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Ban} label="Block Patterns" value={counts?.block ?? "—"} tone="danger" hint="URL patterns to flag" />
        <StatCard icon={CheckCircle2} label="Whitelist" value={counts?.whitelist ?? "—"} tone="default" hint="Patterns to allow" />
        <StatCard icon={Zap} label="ES Status" value={isOnline ? "Online" : "Offline"} tone={isOnline ? "default" : "danger"} hint="ES connectivity" />
        <StatCard icon={History} label="Poll Interval" value={status ? `${status.poll_interval_minutes}M` : "—"} tone="default" hint="Auto check frequency" />
      </div>

      {/* ── Recent findings ── */}
      <Panel title="Recent findings" icon={SearchX} action={<Button variant="outline" size="sm" onClick={() => onNavigate("findings")}>View all <ArrowRight className="h-3.5 w-3.5" /></Button>}>
          <div className="space-y-2">
          <LoadingIndicator
            label="Loading recent findings"
            active={recentLoading}
            startedAt={recentLoadingStartedAt}
            className="max-w-md"
          />
            {/* First load blanks to a skeleton; later reads keep the table mounted
                and show the quiet banner so the operator sees the read is still
                running. */}
            {recentLoading && recentFindings.length === 0 ? (
              // Plain `div` (not the styled feed-list container): the list
              // itself is borderless inside the Panel, so a bordered box here
              // would be a second frame. Rows mirror the table's line rhythm.
              <div className="space-y-2" aria-busy="true">
                <SkeletonShape variant="feed-list" count={5} className="border-0 bg-transparent shadow-none" />
              </div>
            ) : recentFindings.length > 0 ? (
              <div aria-busy={recentLoading}>
                <SimpleTable
                  ariaLabel="Recent findings"
                  data={recentFindings}
                  rowKey={(f) => f.id}
                  onRowClick={(f) => onNavigate("findings", f.base_url)}
                  columns={[
                    {
                      id: "client_ip",
                      header: "Client IP",
                      cell: (f) => <span className="font-mono font-medium">{f.client_ip}</span>,
                    },
                    {
                      id: "base_url",
                      header: "Base URL",
                      className: "max-w-[200px] truncate font-mono text-muted-foreground",
                      cell: (f) => (
                        <span className="block max-w-[200px] truncate" title={f.base_url}>
                          {f.base_url}
                        </span>
                      ),
                    },
                    {
                      id: "detected",
                      header: "Detected",
                      className: "whitespace-nowrap font-mono text-muted-foreground",
                      cell: (f) => formatDetected(f.log_timestamp),
                    },
                  ]}
                />
              </div>
            ) : recentError ? (
              <Callout action={<Button variant="outline" size="sm" onClick={fetchRecent}>Retry</Button>}>
                Couldn&apos;t load recent findings — {recentError}
              </Callout>
            ) : (
              <EmptyState
                icon={SearchX}
                title="No findings yet"
                description="They appear after the ES poll detects matches."
                action={<Button variant="outline" size="sm" onClick={() => onNavigate("query")}>Run query</Button>}
              />
            )}
          </div>
        </Panel>

      {/* ── Quick links ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <button
          type="button"
          onClick={() => onNavigate("query")}
          className="group relative flex items-center gap-4 rounded-md border border-border bg-card p-5 text-left shadow-sm active:scale-[0.98] lg:col-span-3 lg:p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/50"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
            <FileSearch className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight">Query console</p>
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">Live ES queries & access-flow</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
        </button>

        <div className="grid grid-cols-1 gap-3 lg:col-span-2">
          <button
            type="button"
            onClick={() => onNavigate("query")}
            className="group flex items-center gap-3 rounded-md border border-border bg-card p-4 text-left shadow-sm active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <Link2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-tight">Traffic flow</p>
              <p className="text-xs font-medium text-muted-foreground">Client → server → URL</p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate("patterns")}
            className="group flex items-center gap-3 rounded-md border border-border bg-card p-4 text-left shadow-sm active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Ban className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-tight">Patterns</p>
              <p className="text-xs font-medium text-muted-foreground">Block & whitelist rules</p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </button>
        </div>
      </div>
    </PageShell>
  )
}
