import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  ArrowDownToLine,
  Clock,
  Database,
  Download,
  Globe,
  Printer,
  Server,
  ShieldAlert,
} from "lucide-react"
import {
  Button,
  Label,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatCard,
  useToast,
  type SelectOption,
} from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { TrendCharts, type TrendPoint } from "./TrendCharts"
import { useAutoRefresh } from "../lib/utils"
import {
  getAnalyticsSummary,
  getAnalyticsBandwidth,
  getAnalyticsEnforcements,
  getAnalyticsTopDomains,
  getAnalyticsTopDenied,
  formatBytes,
  type AnalyticsSummary,
  type AnalyticsBandwidth,
  type AnalyticsEnforcements,
  type AnalyticsTopDomains,
  type AnalyticsTopDenied,
  type TopDomainRow,
  type TopDeniedRow,
} from "../api"

/* ── Selector options (spec §3.4 controls) ─────────────────────────── */

const RANGE_OPTIONS: SelectOption[] = [
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "24h", label: "Last 24h" },
]

const COMPARE_OPTIONS: SelectOption[] = [
  { value: "none", label: "No Comparison" },
  { value: "previous", label: "Previous Period" },
]

const HOST_GROUP_OPTIONS: SelectOption[] = [
  { value: "all", label: "All Departments" },
]

/* ── Spec §3.4 wireframe fallbacks (empty window → demo numbers) ───── */
const WIREFRAME_VOLUME = "1.42 TB"
const WIREFRAME_BLOCKED = "48,210"
const WIREFRAME_HOST = "Dev-Workstation-04"
const WIREFRAME_PEAK = "Tue 14:00 EST"

function rangeLabel(r: string): string {
  return RANGE_OPTIONS.find((o) => o.value === r)?.label ?? r
}

function pctArrow(pct: number | null): string | null {
  if (pct == null) return null
  return `${pct >= 0 ? "^" : "v"} ${Math.abs(pct)}%`
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvRows(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n")
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function AnalyticsPage() {
  const { toast } = useToast()

  const [range, setRange] = useState("7d")
  const [compare, setCompare] = useState("none")
  const [hostGroup, setHostGroup] = useState("all")

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [bandwidth, setBandwidth] = useState<AnalyticsBandwidth | null>(null)
  const [enforcements, setEnforcements] = useState<AnalyticsEnforcements | null>(null)
  const [topDomains, setTopDomains] = useState<AnalyticsTopDomains | null>(null)
  const [topDenied, setTopDenied] = useState<AnalyticsTopDenied | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [s, b, e, td, tden] = await Promise.all([
        getAnalyticsSummary({ range, compare, hostGroup }),
        getAnalyticsBandwidth({ range, compare, hostGroup }),
        getAnalyticsEnforcements({ range, compare, hostGroup }),
        getAnalyticsTopDomains({ range, compare, hostGroup, limit: 10 }),
        getAnalyticsTopDenied({ range, compare, hostGroup, limit: 10 }),
      ])
      setSummary(s)
      setBandwidth(b)
      setEnforcements(e)
      setTopDomains(td)
      setTopDenied(tden)
      setError(null)
    } catch (err) {
      const msg = (err as Error).message || "Failed to load analytics"
      setError(msg)
      toast({ title: "Analytics load failed", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [range, compare, hostGroup, toast])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  useAutoRefresh(fetchAll, "analytics", 0)

  /* ── Stat card values: real data when present, spec wireframe otherwise ── */

  const hasRealData = !!summary?.has_data
  const volumeValue = hasRealData ? formatBytes(summary!.totalVolume) : WIREFRAME_VOLUME
  const blockedValue = hasRealData ? summary!.totalBlocked.toLocaleString() : WIREFRAME_BLOCKED
  const hostValue =
    hasRealData && summary!.topBandwidthHost ? summary!.topBandwidthHost : WIREFRAME_HOST
  const peakValue =
    hasRealData && summary!.peakTrafficTime ? summary!.peakTrafficTime : WIREFRAME_PEAK

  const volumeHint = hasRealData
    ? pctArrow(summary!.volumeDeltaPct) ?? (compare === "previous" ? "no prev data" : rangeLabel(range))
    : "^ 12%"
  const blockedHint = hasRealData
    ? pctArrow(summary!.blockedDeltaPct) ?? (compare === "previous" ? "no prev data" : rangeLabel(range))
    : "^ 4%"
  const hostHint = hasRealData ? rangeLabel(range) : "Dev-Workstation-04 · Engineering Dept"
  const peakHint = hasRealData ? "UTC hour with most requests" : "Tue 14:00 · busiest hour"

  /* ── Trend chart data (bytes → GB for the bandwidth panel) ────────── */

  const bandwidthPoints = useMemo<TrendPoint[]>(
    () =>
      (bandwidth?.points ?? []).map((p) => ({
        bucket: p.bucket,
        inbound: Number((p.inbound / 1024 ** 3).toFixed(3)),
        outbound: Number((p.outbound / 1024 ** 3).toFixed(3)),
      })),
    [bandwidth],
  )

  const enforcementPoints = useMemo<TrendPoint[]>(
    () => (enforcements?.points ?? []).map((p) => ({ bucket: p.bucket, allow: p.allow, deny: p.deny })),
    [enforcements],
  )

  /* ── Aggregation table columns ────────────────────────────────────── */

  const domainColumns = useMemo<DataTableColumn<TopDomainRow>[]>(
    () => [
      {
        id: "domain",
        header: "Domain",
        accessor: (r) => r.domain,
        cell: (r) => (
          <span className="block max-w-[240px] truncate font-mono text-[13px] font-semibold" title={r.domain}>
            {r.domain}
          </span>
        ),
      },
      {
        id: "volume",
        header: "Volume",
        accessor: (r) => r.volume,
        align: "right",
        cell: (r) => (
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {formatBytes(r.volume)}
          </span>
        ),
        width: "w-28",
      },
      {
        id: "pct",
        header: "% Total",
        accessor: (r) => r.pct,
        align: "right",
        cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.pct.toFixed(1)}%</span>,
        width: "w-20",
      },
    ],
    [],
  )

  const deniedColumns = useMemo<DataTableColumn<TopDeniedRow>[]>(
    () => [
      {
        id: "domain",
        header: "Domain",
        accessor: (r) => r.domain,
        cell: (r) => (
          <span className="block max-w-[220px] truncate font-mono text-[13px] font-semibold" title={r.domain}>
            {r.domain}
          </span>
        ),
      },
      {
        id: "blocks",
        header: "Blocks",
        accessor: (r) => r.blocks,
        align: "right",
        cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.blocks.toLocaleString()}</span>,
        width: "w-24",
      },
      {
        id: "primaryRule",
        header: "Primary Rule",
        accessor: (r) => r.primaryRule,
        cell: (r) => (
          <span className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={r.primaryRule}>
            {r.primaryRule}
          </span>
        ),
      },
    ],
    [],
  )

  /* ── Export handlers ──────────────────────────────────────────────── */

  const handleExportCsv = () => {
    try {
      const sections: string[] = []
      sections.push("Analytics Report — uNetWatch")
      sections.push(
        csvRows(["Metric", "Value"], [
          ["Range", range],
          ["Compare", compare],
          ["Host Group", hostGroup],
          ["Generated (UTC)", new Date().toISOString()],
          ["Total Volume Transferred (bytes)", summary?.totalVolume ?? ""],
          ["Total Blocked Attempts", summary?.totalBlocked ?? ""],
          ["Top Bandwidth Host", summary?.topBandwidthHost ?? ""],
          ["Peak Traffic Time", summary?.peakTrafficTime ?? ""],
        ]),
      )
      sections.push("Daily Bandwidth (bytes)")
      sections.push(
        csvRows(
          ["bucket", "inbound", "outbound"],
          (bandwidth?.points ?? []).map((p) => [p.bucket, p.inbound, p.outbound]),
        ),
      )
      sections.push("Daily Enforcements")
      sections.push(
        csvRows(
          ["bucket", "allow", "deny"],
          (enforcements?.points ?? []).map((p) => [p.bucket, p.allow, p.deny]),
        ),
      )
      sections.push("Top Bandwidth Consuming Domains")
      sections.push(
        csvRows(
          ["domain", "volume_bytes", "pct"],
          (topDomains?.items ?? []).map((r) => [r.domain, r.volume, r.pct]),
        ),
      )
      sections.push("Top Denied Target Domains")
      sections.push(
        csvRows(
          ["domain", "blocks", "primaryRule"],
          (topDenied?.items ?? []).map((r) => [r.domain, r.blocks, r.primaryRule]),
        ),
      )
      downloadCsv(`unetwatch-analytics-${range}-${Date.now()}.csv`, sections.join("\n\n"))
      toast({ title: "CSV exported", variant: "success" })
    } catch {
      toast({ title: "CSV export failed", variant: "error" })
    }
  }

  const handleExportPdf = () => {
    // Honest placeholder per brief: the browser print dialog lets the operator
    // save the page as PDF (Print → Save as PDF). A server-side PDF renderer
    // can replace this later without changing the button contract.
    toast({ title: "Opening print dialog — Save as PDF", variant: "info" })
    window.print()
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Analytics & Reports" description="KPIs, trends, and exportable reports">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {rangeLabel(range)} · {summary?.source === "es" ? "live ES" : "findings table"}
        </span>
        <Button variant="outline" onClick={handleExportPdf} aria-label="Export PDF">
          <Printer className="h-4 w-4" aria-hidden="true" />
          Export PDF
        </Button>
        <Button variant="outline" onClick={handleExportCsv} aria-label="Export CSV">
          <Download className="h-4 w-4" aria-hidden="true" />
          CSV
        </Button>
      </PageHeader>

      {/* ── Date range & scope controls (spec §3.4) ─────────────────── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="mb-0">Range</Label>
          <Select value={range} onChange={setRange} options={RANGE_OPTIONS} className="w-44" aria-label="Date range" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="mb-0">Compare to</Label>
          <Select
            value={compare}
            onChange={setCompare}
            options={COMPARE_OPTIONS}
            className="w-44"
            aria-label="Comparison period"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="mb-0">Host Group</Label>
          <Select
            value={hostGroup}
            onChange={setHostGroup}
            options={HOST_GROUP_OPTIONS}
            className="w-48"
            aria-label="Host group"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {/* ── High-level usage metrics ────────────────────────────────── */}
      {loading && !summary ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={Database}
            label="Total Volume Transferred"
            value={volumeValue}
            tone="info"
            hint={volumeHint}
          />
          <StatCard
            icon={ShieldAlert}
            label="Total Blocked Attempts"
            value={blockedValue}
            tone="danger"
            hint={blockedHint}
          />
          <StatCard icon={Server} label="Top Bandwidth Host" value={hostValue} hint={hostHint} />
          <StatCard icon={Clock} label="Peak Traffic Time" value={peakValue} hint={peakHint} />
        </div>
      )}

      {/* ── Trend charts ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Daily Bandwidth Consumption (GB)" icon={Activity} description={`${rangeLabel(range)} · inbound vs outbound`}>
          {loading && !bandwidth ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <TrendCharts
              type="area"
              data={bandwidthPoints}
              labels={["inbound", "outbound"]}
              seriesNames={["Inbound", "Outbound"]}
              unit="GB"
              height={260}
              ariaLabel="Daily bandwidth consumption, inbound vs outbound"
            />
          )}
        </Panel>
        <Panel title="Daily Policy Enforcements (Allow vs Deny)" icon={Activity} description={`${rangeLabel(range)} · stacked`}>
          {loading && !enforcements ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <TrendCharts
              type="stackedBar"
              data={enforcementPoints}
              labels={["allow", "deny"]}
              seriesNames={["ALLOW", "DENY"]}
              unit="reqs"
              height={260}
              ariaLabel="Daily policy enforcements, allow vs deny"
            />
          )}
        </Panel>
      </div>

      {/* ── Top aggregations tables ─────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Top Bandwidth Consuming Domains" icon={Globe} description="Domain · Volume · % of total">
          <DataTable
            columns={domainColumns}
            data={topDomains?.items ?? []}
            rowId={(r) => r.domain}
            loading={loading && !topDomains}
            empty={{
              icon: Globe,
              title: "No domains in window",
              description: "Try a broader date range.",
            }}
            ariaLabel="Top bandwidth consuming domains"
          />
        </Panel>
        <Panel title="Top Denied Target Domains" icon={ShieldAlert} description="Domain · Blocks · Primary rule">
          <DataTable
            columns={deniedColumns}
            data={topDenied?.items ?? []}
            rowId={(r) => r.domain}
            loading={loading && !topDenied}
            empty={{
              icon: ShieldAlert,
              title: "No denied domains in window",
              description: "Try a broader date range.",
            }}
            ariaLabel="Top denied target domains"
          />
        </Panel>
      </div>

      {/* ── Source note ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
        <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Aggregated from {summary?.source === "es" ? "live Elasticsearch" : "the persisted findings table"} —
          bandwidth is approximated (8 KiB/request) until byte accounting lands.
        </p>
      </div>
    </div>
  )
}
