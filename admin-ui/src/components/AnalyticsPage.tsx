import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  ArrowDownToLine,
  Clock,
  Database,
  Download,
  Globe,
  Printer,
  SearchX,
  Server,
  ShieldAlert,
  ShieldCheck,
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
  getAnalyticsTopEnforced,
  getFindings,
  formatBytes,
  type AnalyticsSummary,
  type AnalyticsBandwidth,
  type AnalyticsEnforcements,
  type AnalyticsTopDomains,
  type AnalyticsTopEnforced,
  type TopDomainRow,
  type TopEnforcedRow,
  type Finding,
} from "../api"

/* ── Selector options ─────────────────────────────────────────────── */

// Ranges match the app-wide FilterContext presets (1h/24h/7d/30d).
const RANGE_OPTIONS: SelectOption[] = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
]

const COMPARE_OPTIONS: SelectOption[] = [
  { value: "none", label: "No Comparison" },
  { value: "previous", label: "Previous Period" },
]

const RANGE_MINUTES: Record<string, number> = { "1h": 60, "24h": 1440, "7d": 10080, "30d": 43200 }

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

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function AnalyticsPage() {
  const { toast } = useToast()

  const [range, setRange] = useState("7d")
  const [compare, setCompare] = useState("none")

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [bandwidth, setBandwidth] = useState<AnalyticsBandwidth | null>(null)
  const [enforcements, setEnforcements] = useState<AnalyticsEnforcements | null>(null)
  const [topDomains, setTopDomains] = useState<AnalyticsTopDomains | null>(null)
  const [topEnforced, setTopEnforced] = useState<AnalyticsTopEnforced | null>(null)
  const [raw, setRaw] = useState<Finding[]>([])
  const [rawTotal, setRawTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawSearch, setRawSearch] = useState("")
  const [rawPage, setRawPage] = useState(0)
  const rawPageSize = 50

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [s, b, e, td, ten] = await Promise.all([
        getAnalyticsSummary({ range, compare }),
        getAnalyticsBandwidth({ range, compare }),
        getAnalyticsEnforcements({ range, compare }),
        getAnalyticsTopDomains({ range, compare, limit: 10 }),
        getAnalyticsTopEnforced({ range, compare, limit: 10 }),
      ])
      setSummary(s)
      setBandwidth(b)
      setEnforcements(e)
      setTopDomains(td)
      setTopEnforced(ten)
      setError(null)
    } catch (err) {
      const msg = (err as Error).message || "Failed to load analytics"
      setError(msg)
      toast({ title: "Analytics load failed", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [range, compare, toast])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  useAutoRefresh(fetchAll, "analytics", 0)

  // Raw-data table — the persisted findings in the selected window.
  const fetchRaw = useCallback(async () => {
    setRawLoading(true)
    try {
      const res = await getFindings({
        search: rawSearch.trim() || undefined,
        minutes: RANGE_MINUTES[range] ?? 1440,
        limit: rawPageSize,
        offset: rawPage * rawPageSize,
      })
      setRaw(res.items)
      setRawTotal(res.total)
    } catch (e) {
      toast({ title: "Raw data load failed", description: (e as Error).message, variant: "error" })
    } finally {
      setRawLoading(false)
    }
  }, [range, rawSearch, rawPage, toast])

  useEffect(() => {
    void fetchRaw()
  }, [fetchRaw])

  // Refetch when search/range/page changes (search is server-side per page fetch).
  /* ── Stat card values ──────────────────────────────────────────────── */

  const hasRealData = !!summary?.has_data
  const volumeValue = hasRealData ? formatBytes(summary!.totalVolume) : "—"
  const riskValue = hasRealData ? summary!.totalRisk.toLocaleString() : "—"
  const enforcedValue = hasRealData ? summary!.totalEnforcements.toLocaleString() : "—"
  const hostValue = hasRealData && summary!.topBandwidthHost ? summary!.topBandwidthHost : "—"
  const peakValue = hasRealData && summary!.peakTrafficTime ? summary!.peakTrafficTime : "—"

  const volumeHint = hasRealData
    ? pctArrow(summary!.volumeDeltaPct) ?? (compare === "previous" ? "no prev data" : rangeLabel(range))
    : rangeLabel(range)
  const riskHint = hasRealData ? rangeLabel(range) : rangeLabel(range)
  const enforcedHint = hasRealData
    ? pctArrow(summary!.enforcementsDeltaPct) ?? (compare === "previous" ? "no prev data" : "handled")
    : "handled"
  const hostHint = hasRealData ? rangeLabel(range) : rangeLabel(range)
  const peakHint = hasRealData ? "UTC hour with most requests" : "busiest hour"

  /* ── Trend chart data ──────────────────────────────────────────────── */

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

  const enforcedColumns = useMemo<DataTableColumn<TopEnforcedRow>[]>(
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
        id: "enforcements",
        header: "Enforcements",
        accessor: (r) => r.enforcements,
        align: "right",
        cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.enforcements.toLocaleString()}</span>,
        width: "w-28",
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

  const rawColumns = useMemo<DataTableColumn<Finding>[]>(
    () => [
      {
        id: "log_timestamp",
        header: "Timestamp",
        accessor: (r) => r.log_timestamp,
        cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(r.log_timestamp)}</span>,
        width: "w-44",
        defaultSortDir: "desc",
      },
      {
        id: "client_ip",
        header: "Client IP",
        accessor: (r) => r.client_ip,
        cell: (r) => <span className="font-mono text-xs font-semibold">{r.client_ip}</span>,
      },
      {
        id: "url",
        header: "URL",
        accessor: (r) => r.url,
        cell: (r) => (
          <span className="block max-w-[320px] truncate font-mono text-xs" title={r.url}>
            {r.url}
          </span>
        ),
      },
      {
        id: "base_url",
        header: "Domain",
        accessor: (r) => r.base_url,
        cell: (r) => <span className="block max-w-[200px] truncate font-mono text-xs text-muted-foreground" title={r.base_url}>{r.base_url}</span>,
      },
      {
        id: "action",
        header: "Action",
        accessor: (r) => r.action,
        cell: (r) => <span className="font-mono text-xs">{r.action || "ALLOW"}</span>,
        width: "w-24",
      },
      {
        id: "bytes",
        header: "Bytes ↓/↑",
        accessor: (r) => (Number(r.bytes_downloaded) || 0) + (Number(r.bytes_uploaded) || 0),
        align: "right",
        cell: (r) => {
          const dn = Number(r.bytes_downloaded) || 0
          const up = Number(r.bytes_uploaded) || 0
          if (!dn && !up) return <span className="text-xs text-muted-foreground">—</span>
          return (
            <span className="font-mono text-xs tabular-nums" title={`↓ ${dn.toLocaleString()} / ↑ ${up.toLocaleString()}`}>
              {formatBytes(dn + up)}
            </span>
          )
        },
        width: "w-24",
      },
      {
        id: "rule",
        header: "Rule",
        accessor: (r) => r.rule_name ?? r.rule_info ?? "—",
        cell: (r) => {
          const rule = r.rule_name && r.rule_name !== "-" ? r.rule_name : r.rule_info
          return <span className="block max-w-[140px] truncate font-mono text-xs text-muted-foreground" title={rule}>{rule || "—"}</span>
        },
        width: "w-28",
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
          ["Generated (UTC)", new Date().toISOString()],
          ["Total Volume Transferred (bytes)", summary?.totalVolume ?? ""],
          ["Risks (ALLOW pattern matches)", summary?.totalRisk ?? ""],
          ["Enforcements (DENY — handled)", summary?.totalEnforcements ?? ""],
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
      sections.push("Top Enforced Target Domains")
      sections.push(
        csvRows(
          ["domain", "enforcements", "primaryRule"],
          (topEnforced?.items ?? []).map((r) => [r.domain, r.enforcements, r.primaryRule]),
        ),
      )
      sections.push("Raw Findings")
      sections.push(
        csvRows(
          ["log_timestamp", "client_ip", "server_ip", "url", "base_url", "action", "category", "bytes_down", "bytes_up", "rule"],
          raw.map((r) => [
            r.log_timestamp,
            r.client_ip,
            r.server_ip,
            r.url,
            r.base_url,
            r.action ?? "",
            r.category ?? "",
            Number(r.bytes_downloaded) || 0,
            Number(r.bytes_uploaded) || 0,
            r.rule_name ?? r.rule_info ?? "",
          ]),
        ),
      )
      downloadCsv(`unetwatch-analytics-${range}-${Date.now()}.csv`, sections.join("\n\n"))
      toast({ title: "CSV exported", variant: "success" })
    } catch {
      toast({ title: "CSV export failed", variant: "error" })
    }
  }

  const handleExportPdf = () => {
    toast({ title: "Opening print dialog — Save as PDF", variant: "info" })
    window.print()
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Analytics & Reports" description="KPIs, trends, enforcements, and raw data">
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

      {/* ── Date range & comparison controls ───────────────────────── */}
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
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {/* ── High-level usage metrics ───────────────────────────────── */}
      {loading && !summary ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <StatCard
            icon={Database}
            label="Total Volume Transferred"
            value={volumeValue}
            tone="info"
            hint={volumeHint}
          />
          <StatCard
            icon={ShieldAlert}
            label="Risks (ALLOW matches)"
            value={riskValue}
            tone="danger"
            hint={riskHint}
          />
          <StatCard
            icon={ShieldCheck}
            label="Enforcements (DENY)"
            value={enforcedValue}
            tone="success"
            hint={enforcedHint}
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
        <Panel title="Daily Policy Enforcements (Allow vs Deny)" icon={Activity} description={`${rangeLabel(range)} · stacked — DENY are handled, not risk`}>
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
        <Panel title="Top Enforced Target Domains" icon={ShieldCheck} description="Domain · Enforcements · Primary rule">
          <DataTable
            columns={enforcedColumns}
            data={topEnforced?.items ?? []}
            rowId={(r) => r.domain}
            loading={loading && !topEnforced}
            empty={{
              icon: ShieldCheck,
              title: "No enforced domains in window",
              description: "DENY rows appear here — the proxy handled them.",
            }}
            ariaLabel="Top enforced target domains"
          />
        </Panel>
      </div>

      {/* ── Raw data table ──────────────────────────────────────────── */}
      <Panel
        title="Raw Findings"
        icon={Database}
        description={`${rawTotal.toLocaleString()} docs · ${rangeLabel(range)} window`}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Filter raw data (IP / URL)..."
            value={rawSearch}
            onChange={(e) => { setRawSearch(e.target.value); setRawPage(0) }}
            className="w-64 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Filter raw findings"
          />
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
            Findings are ALLOW risk rows only (ADR 0001)
          </span>
        </div>
        <DataTable
          columns={rawColumns}
          data={raw}
          rowId={(r) => String(r.id)}
          loading={rawLoading}
          internalPagination
          total={rawTotal}
          page={rawPage}
          pageSize={rawPageSize}
          onPageChange={setRawPage}
          empty={{
            icon: SearchX,
            title: "No findings in window",
            description: "Try a broader date range or clear the filter.",
          }}
          ariaLabel="Raw findings"
        />
      </Panel>

      {/* ── Source note ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3">
        <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Aggregated from {summary?.source === "es" ? "live Elasticsearch" : "the persisted findings table"} —
          risk = ALLOW pattern matches, enforcements = DENY (handled). Bandwidth approximated (8 KiB/request) until byte accounting lands.
        </p>
      </div>
    </div>
  )
}
