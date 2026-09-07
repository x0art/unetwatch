import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, Copy, Database, Globe, Link2, Printer, Search, SearchX, Server, ShieldAlert, ShieldCheck } from "lucide-react"
import { Button, Input, Label, PageHeader, Panel, Select, Skeleton, StatCard, useToast, type SelectOption } from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { TrendCharts, type TrendPoint } from "./TrendCharts"
import { useFilter } from "../contexts/FilterContext"
import { copyText } from "../lib/utils"
import {
  getClientReport,
  getClientReportFindings,
  getClientReportCsvUrl,
  formatBytes,
  getToken,
  type ClientReport,
  type Finding,
} from "../api"

const RANGE_OPTIONS: SelectOption[] = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
]

function rangeLabel(r: string): string { return RANGE_OPTIONS.find((o) => o.value === r)?.label ?? r }

function looksLikeUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.includes("/") || s.includes("?") || s.startsWith("www.")
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export function ClientReportPage({ onNavigate }: { onNavigate?: (view: "host" | "url" | "patterns" | "analytics" | "dashboard" | "query" | "findings" | "blacklist" | "redirects" | "logs" | "client-report") => void } = {}) {
  const { globalFilter, setGlobalFilter, timeRange: range, setTimeRange: setRange } = useFilter()
  const { toast } = useToast()

  const [target, setTarget] = useState(() => (globalFilter && !looksLikeUrl(globalFilter) ? globalFilter : ""))
  const [report, setReport] = useState<ClientReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  // Raw findings table for this client
  const [raw, setRaw] = useState<Finding[]>([])
  const [rawTotal, setRawTotal] = useState(0)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawSearch, setRawSearch] = useState("")
  const [rawPage, setRawPage] = useState(0)
  const rawPageSize = 50

  // Prefill from global filter (IP-like only, not URL)
  useEffect(() => {
    if (globalFilter && !looksLikeUrl(globalFilter) && globalFilter !== target) {
      setTarget(globalFilter)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter])

  const lookup = useCallback(async (ip: string) => {
    const clean = ip.trim()
    if (!clean) { toast({ title: "Enter a client IP", variant: "info" }); return }
    setLoading(true); setError(null); setHasSearched(true)
    try {
      const data = await getClientReport(clean, { range })
      setReport(data)
      // keep raw table in sync
      setRawPage(0)
    } catch (e) {
      const msg = (e as Error).message || "Report failed"
      setError(msg); setReport(null)
      toast({ title: "Report failed", description: msg, variant: "error" })
    } finally { setLoading(false) }
  }, [range, toast])

  // Fetch raw findings paginated for this IP+range
  const fetchRaw = useCallback(async () => {
    if (!report?.client_ip || !report.has_data) return
    setRawLoading(true)
    try {
      const res = await getClientReportFindings(report.client_ip, {
        range,
        search: rawSearch.trim() || undefined,
        limit: rawPageSize,
        offset: rawPage * rawPageSize,
      })
      setRaw(res.items); setRawTotal(res.total)
    } catch (e) {
      toast({ title: "Raw findings failed", description: (e as Error).message, variant: "error" })
    } finally { setRawLoading(false) }
  }, [report, range, rawSearch, rawPage, toast])

  useEffect(() => { void fetchRaw() }, [fetchRaw])

  const openUrl = useCallback((url: string) => {
    if (!url) return
    setGlobalFilter(url)
    try { window.localStorage.setItem("unetwatch_view", "url") } catch { /* ignore */ }
    onNavigate?.("url")
  }, [setGlobalFilter, onNavigate])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") void lookup(target) }

  const handleExportCsv = () => {
    if (!report) return
    // Download via authenticated fetch (X-API-Key) — direct <a href> would miss auth
    const apiUrl = getClientReportCsvUrl(report.client_ip, { range })
    const tok = getToken()
    fetch(`/api${apiUrl.replace(/^\/api/, "") || apiUrl}`, { headers: tok ? { "X-API-Key": tok } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `client-${report.client_ip}-${range}-${Date.now()}.csv`
        a.click()
        URL.revokeObjectURL(url)
        toast({ title: "CSV exported", variant: "success" })
      })
      .catch((e) => toast({ title: "CSV export failed", description: (e as Error).message, variant: "error" }))
  }

  const handleExportPdf = () => {
    toast({ title: "Opening print dialog — Save as PDF", variant: "info" })
    window.print()
  }

  const hasRealData = !!report?.has_data
  const volumeValue = hasRealData ? formatBytes(report!.total_volume) : "—"
  const showSections = !!report && !error

  const bandwidthPoints = useMemo<TrendPoint[]>(
    () => (report?.bandwidth.points ?? []).map((p) => ({
      bucket: p.bucket,
      inbound: Number((p.inbound / 1024 ** 3).toFixed(3)),
      outbound: Number((p.outbound / 1024 ** 3).toFixed(3)),
    })),
    [report],
  )
  const enforcementPoints = useMemo<TrendPoint[]>(
    () => (report?.enforcements.points ?? []).map((p) => ({ bucket: p.bucket, allow: p.allow, deny: p.deny })),
    [report],
  )

  const domainColumns = useMemo<DataTableColumn<{ domain: string; count: number; volume: number; pct: number }>[]>(() => [
    { id: "domain", header: "Domain", accessor: (r) => r.domain, cell: (r) => <span className="block max-w-[240px] truncate font-mono text-[13px] font-semibold" title={r.domain}>{r.domain}</span> },
    { id: "count", header: "Requests", accessor: (r) => r.count, align: "right", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>, width: "w-20" },
    { id: "volume", header: "Volume", accessor: (r) => r.volume, align: "right", cell: (r) => <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{formatBytes(r.volume)}</span>, width: "w-28" },
    { id: "pct", header: "% Total", accessor: (r) => r.pct, align: "right", cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.pct.toFixed(1)}%</span>, width: "w-20" },
  ], [])

  const patternColumns = useMemo<DataTableColumn<{ pattern: string; hits: number }>[]>(() => [
    { id: "pattern", header: "Pattern", accessor: (r) => r.pattern, cell: (r) => <span className="block max-w-[280px] truncate font-mono text-xs" title={r.pattern}>{r.pattern}</span> },
    { id: "hits", header: "Hits", accessor: (r) => r.hits, align: "right", cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{r.hits.toLocaleString()}</span>, width: "w-24" },
  ], [])

  const urlColumns = useMemo<DataTableColumn<{ url: string; base_url: string; count: number; last_seen: string }>[]>(() => [
    { id: "url", header: "URL", accessor: (r) => r.url, cell: (r) => (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[360px] truncate font-mono text-xs" title={r.url}>{r.url}</span>
        <button type="button" onClick={() => openUrl(r.url)} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground" aria-label="Open in URL Investigation"><Search className="h-3 w-3" /></button>
      </span>
    )},
    { id: "count", header: "Hits", accessor: (r) => r.count, align: "right", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>, width: "w-20" },
  ], [openUrl])

  const rawColumns = useMemo<DataTableColumn<Finding>[]>(() => [
    { id: "log_timestamp", header: "Timestamp", accessor: (r) => r.log_timestamp, cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(r.log_timestamp)}</span>, width: "w-44", defaultSortDir: "desc" },
    { id: "url", header: "URL", accessor: (r) => r.url, cell: (r) => <span className="block max-w-[320px] truncate font-mono text-xs" title={r.url}>{r.url}</span> },
    { id: "base_url", header: "Domain", accessor: (r) => r.base_url, cell: (r) => <span className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground" title={r.base_url}>{r.base_url}</span> },
    { id: "action", header: "Action", accessor: (r) => r.action, cell: (r) => <span className="font-mono text-xs">{r.action || "ALLOW"}</span>, width: "w-24" },
    { id: "pattern", header: "Pattern", enableSorting: false, accessor: (r) => r.matched_patterns, cell: (r) => {
      let pats: string[] = []
      try { const p = r.matched_patterns ? JSON.parse(r.matched_patterns) : []; pats = Array.isArray(p) ? p : [] } catch { pats = [] }
      const label = pats.join(", ") || "—"
      return <span className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground" title={label}>{label}</span>
    }, width: "w-40" },
    { id: "volume", header: "Volume", accessor: (r) => { const dn = Number(r.bytes_downloaded) || 0; const up = Number(r.bytes_uploaded) || 0; if (dn || up) return dn + up; const dur = Number(r.duration_seconds) || 0; return dur > 0 ? Math.max(1, Math.round(dur)) * 8192 : 8192 }, align: "right", cell: (r) => {
      const dn = Number(r.bytes_downloaded) || 0; const up = Number(r.bytes_uploaded) || 0; const hasBytes = !!(dn || up); const dur = Number(r.duration_seconds) || 0; const vol = hasBytes ? dn + up : dur > 0 ? Math.max(1, Math.round(dur)) * 8192 : 8192
      return <span className="inline-flex items-center gap-1.5" title={hasBytes ? `Real: ↓${dn}+↑${up}` : `Est: ${dur}s×8KiB`}><span className="font-mono text-xs tabular-nums">{formatBytes(vol)}</span><span className={`border px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${hasBytes ? "border-[#0A0A0A] bg-[#0A0A0A] text-white dark:border-[#F6F2E8] dark:bg-[#F6F2E8] dark:text-[#0A0A0A]" : "border-border bg-muted text-muted-foreground"}`}>{hasBytes ? "real" : "est."}</span></span>
    }, width: "w-32" },
  ], [])

  return (
    <div className="space-y-5">
      <PageHeader title="Client Report" description="Per-client analytics from findings (risk-only, whitelist-excluded).">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {rangeLabel(range)} · findings table
        </span>
        <Button variant="outline" onClick={handleCopyLink} aria-label="Copy share link"><Copy className="h-4 w-4" aria-hidden="true" />Copy link</Button>
        <Button variant="outline" onClick={handleExportPdf} aria-label="Export PDF"><Printer className="h-4 w-4" aria-hidden="true" />Print / PDF</Button>
        <Button variant="outline" onClick={handleExportCsv} aria-label="Export CSV" disabled={!report?.has_data}><Database className="h-4 w-4" aria-hidden="true" />CSV</Button>
      </PageHeader>

      <div className="brutal-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[280px] flex-1 items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label className="mb-0">Client IP</Label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={onKeyDown} placeholder="e.g. 192.168.1.45" aria-label="Client IP" />
            </div>
            <Button onClick={() => void lookup(target)} disabled={loading} aria-label="Generate report">
              <Search className="h-4 w-4" aria-hidden="true" />{loading ? "Loading…" : "Go"}
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="mb-0">Range</Label>
            <Select value={range} onChange={(v) => setRange(v as typeof range)} options={RANGE_OPTIONS} className="w-44" aria-label="Date range" />
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-xs text-danger">{error}</div>}

      {!hasSearched && !report && !loading && (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">Client Report</p>
          <p className="mt-2 text-sm text-muted-foreground">Enter a client IP and press Go. Try <span className="font-mono font-semibold text-foreground">192.168.1.45</span> for the demo shape.</p>
        </div>
      )}

      {loading && !report && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" />
        </div>
      )}

      {report && !hasRealData && hasSearched && !loading && (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">No findings for {report.client_ip} in {rangeLabel(range)}</p>
          <p className="mt-2 text-sm text-muted-foreground">Try a broader range.</p>
        </div>
      )}

      {showSections && hasRealData && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            <StatCard icon={Database} label="Total Requests" value={report.total_requests.toLocaleString()} tone="info" hint={rangeLabel(range)} />
            <StatCard icon={ShieldAlert} label="Risks (ALLOW)" value={report.total_risk.toLocaleString()} tone="danger" hint={report.top_pattern ? `top: ${report.top_pattern}` : rangeLabel(range)} />
            <StatCard icon={ShieldCheck} label="Enforcements (DENY)" value={report.total_enforcements.toLocaleString()} tone="success" hint="handled" />
            <StatCard icon={Server} label="Total Volume" value={volumeValue} tone="default" hint={`bytes + 8 KiB fallback · ${report.distinct_domains} domains`} />
            <StatCard icon={Activity} label="Peak Hour" value={report.peak_hour || "—"} tone="default" hint={`${report.distinct_urls} distinct URLs`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Daily Bandwidth (GB)" icon={Activity} description={`${rangeLabel(range)} · inbound vs outbound`}>
              <TrendCharts type="area" data={bandwidthPoints} labels={["inbound", "outbound"]} seriesNames={["Inbound", "Outbound"]} unit="GB" height={260} ariaLabel="Client daily bandwidth" />
            </Panel>
            <Panel title="Daily Enforcements" icon={Activity} description={`${rangeLabel(range)} · ALLOW vs DENY`}>
              <TrendCharts type="stackedBar" data={enforcementPoints} labels={["allow", "deny"]} seriesNames={["ALLOW", "DENY"]} unit="reqs" height={260} ariaLabel="Client daily enforcements" />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Top Domains" icon={Globe}>
              <DataTable columns={domainColumns} data={report.top_domains} rowId={(r) => r.domain} empty={{ icon: Globe, title: "No domains in window", description: "Try a broader date range." }} ariaLabel="Top domains" />
            </Panel>
            <Panel title="Top Patterns" icon={Link2}>
              <DataTable columns={patternColumns} data={report.top_patterns} rowId={(r) => r.pattern} empty={{ icon: SearchX, title: "No patterns in window", description: "No matched patterns." }} ariaLabel="Top patterns" />
            </Panel>
          </div>

          <Panel title="Top URLs" icon={Link2} description="Click to investigate">
            <DataTable columns={urlColumns} data={report.top_urls} rowId={(r) => r.url} empty={{ icon: SearchX, title: "No URLs in window" }} ariaLabel="Top URLs" />
          </Panel>

          <Panel title={`Raw Findings — ${report.client_ip}`} icon={Database} description={`${rawTotal.toLocaleString()} docs · ${rangeLabel(range)} window`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input type="search" placeholder="Filter (URL)..." value={rawSearch} onChange={(e) => { setRawSearch(e.target.value); setRawPage(0) }} className="w-64 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring" aria-label="Filter raw findings" />
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">findings table · whitelist-excluded</span>
            </div>
            <DataTable columns={rawColumns} data={raw} rowId={(r) => String(r.id)} loading={rawLoading} total={rawTotal} page={rawPage} pageSize={rawPageSize} onPageChange={setRawPage} empty={{ icon: SearchX, title: "No findings in window" }} ariaLabel="Raw findings" />
          </Panel>
        </>
      )}
    </div>
  )

  function handleCopyLink() {
    const url = window.location.href
    void copyText(url).then((ok) => {
      if (ok) toast({ title: "COPIED", description: url, variant: "success" })
      else toast({ title: "COPY FAILED", variant: "error" })
    })
  }
}
