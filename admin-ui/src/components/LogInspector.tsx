import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, Eye, SearchX, Settings2 } from "lucide-react"
import { Badge, Button, Panel, Select, Skeleton, useToast } from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { formatBytes, runQuery, timeRangeToMinutesLive } from "../api"
import { useFilter } from "../contexts/FilterContext"
import { getSrcIp, getDestIp, getDurationMs, getRowId, getMatchedRule, actionVariant, type LogRow } from "../lib/logRow"

export type { LogRow }

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

const ACTION_OPTIONS = [
  { value: "All", label: "All" },
  { value: "ALLOW", label: "ALLOW" },
  { value: "DENY", label: "DENY" },
  { value: "FLAG", label: "FLAG" },
]

function toCsvValue(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`
  return v
}

function exportCsv(rows: LogRow[], filename: string) {
  const header = ["Timestamp", "Src IP", "Dest IP", "URL", "Action", "Duration", "Category", "Method", "Status", "Country", "Bytes Down", "Bytes Up", "Rule"]
  const lines = [
    header.map(toCsvValue).join(","),
    ...rows.map((r) =>
      [
        toCsvValue(r.timestamp ?? ""),
        toCsvValue(getSrcIp(r)),
        toCsvValue(getDestIp(r)),
        toCsvValue(r.url ?? ""),
        toCsvValue(r.action ?? ""),
        toCsvValue(getDurationMs(r) != null ? `${getDurationMs(r)}ms` : ""),
        toCsvValue(r.category ?? ""),
        toCsvValue(r.http_method ?? ""),
        toCsvValue(String(r.http_status_code ?? "")),
        toCsvValue(r.country_code ?? ""),
        toCsvValue(String(r.bytes_downloaded ?? "")),
        toCsvValue(String(r.bytes_uploaded ?? "")),
        toCsvValue(r.rule_name && r.rule_name !== "-" ? r.rule_name : r.rule_info ?? ""),
      ].join(","),
    ),
  ]
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export interface LogInspectorProps {
  filter?: string
  timeRange?: string
  viewMode?: "all" | "flagged"
  onInspect?: (row: LogRow) => void
}

export function LogInspector({ filter = "", timeRange = "24h", viewMode = "flagged", onInspect }: LogInspectorProps) {
  const { toast } = useToast()
  const { setGlobalFilter, actionFilter, setActionFilter } = useFilter()
  const [rows, setRows] = useState<LogRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const pageSize = 50

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    const minutes = timeRange ? timeRangeToMinutesLive(timeRange) : 60
    const q = filter.trim() || undefined
    try {
      const res = await runQuery(minutes, q ? { q, viewMode } : { viewMode })
      setRows(res.items as unknown as LogRow[])
      setTotal(res.total_requests)
    } catch {
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [filter, timeRange, viewMode])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Reset pagination when filter or action changes
  useEffect(() => {
    setPage(0)
  }, [filter, timeRange, actionFilter])

  const filtered = useMemo(() => {
    if (actionFilter === "All") return rows
    return rows.filter((r) => (r.action ?? "") === actionFilter)
  }, [rows, actionFilter])

  const columns: DataTableColumn<LogRow>[] = useMemo(
    () => [
      {
        id: "timestamp",
        header: "Timestamp",
        accessor: (r) => r.timestamp,
        cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(r.timestamp)}</span>,
        width: "w-44",
        defaultSortDir: "desc" as const,
      },
      {
        id: "src_ip",
        header: "Src IP",
        accessor: (r) => getSrcIp(r),
        cell: (r) => <span className="font-mono text-xs font-semibold">{getSrcIp(r)}</span>,
      },
      {
        id: "dest_ip",
        header: "Dest IP",
        accessor: (r) => getDestIp(r),
        cell: (r) => <span className="font-mono text-xs text-muted-foreground">{getDestIp(r)}</span>,
      },
      {
        id: "url",
        header: "URL / Domain",
        accessor: (r) => r.url,
        cell: (r) => (
          <span className="block max-w-[320px] truncate font-mono text-xs" title={r.url}>
            {r.url}
          </span>
        ),
      },
      {
        id: "action",
        header: "Action",
        accessor: (r) => r.action,
        cell: (r) => <Badge variant={actionVariant(r.action ?? "")}>{r.action || "—"}</Badge>,
        width: "w-24",
      },
      {
        id: "duration",
        header: "Duration",
        accessor: (r) => getDurationMs(r),
        cell: (r) => {
          const ms = getDurationMs(r)
          return <span className="font-mono text-xs tabular-nums">{ms != null ? `${ms}ms` : "—"}</span>
        },
        align: "right" as const,
        width: "w-24",
      },
      {
        id: "category",
        header: "Category",
        accessor: (r) => r.category,
        cell: (r) => <span className="font-mono text-xs text-muted-foreground">{r.category || "—"}</span>,
        width: "w-24",
      },
      {
        id: "method",
        header: "Method",
        accessor: (r) => r.http_method,
        cell: (r) => <span className="font-mono text-xs">{r.http_method || "—"}</span>,
        width: "w-20",
      },
      {
        id: "status",
        header: "Status",
        accessor: (r) => r.http_status_code,
        cell: (r) => <span className="font-mono text-xs tabular-nums">{r.http_status_code ?? "—"}</span>,
        width: "w-20",
        align: "right" as const,
      },
      {
        id: "country",
        header: "Country",
        accessor: (r) => r.country_code,
        cell: (r) => <span className="font-mono text-xs">{r.country_code || "—"}</span>,
        width: "w-20",
      },
      {
        id: "bytes",
        header: "↓/↑ Bytes",
        accessor: (r) => (Number(r.bytes_downloaded) || 0) + (Number(r.bytes_uploaded) || 0),
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
        align: "right" as const,
        width: "w-24",
      },
      {
        id: "rule",
        header: "Rule",
        accessor: (r) => r.rule_name ?? r.rule_info ?? getMatchedRule(r),
        cell: (r) => {
          const rule = r.rule_name && r.rule_name !== "-" ? r.rule_name : r.rule_info || getMatchedRule(r)
          return <span className="block max-w-[140px] truncate font-mono text-xs text-muted-foreground" title={rule}>{rule || "—"}</span>
        },
        width: "w-28",
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: (r) => (
          <span onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="outline" onClick={() => onInspect?.(r)}>
              <Eye className="h-3.5 w-3.5" />
              Inspect
            </Button>
          </span>
        ),
        width: "w-28",
        align: "right" as const,
      },
    ],
    [onInspect],
  )

  const handleExport = () => {
    if (filtered.length === 0) {
      toast({ title: "Nothing to export", description: "No rows match the current filter.", variant: "info" })
      return
    }
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
    exportCsv(filtered, `log-inspector-${ts}.csv`)
    toast({ title: `Exported ${filtered.length} rows`, variant: "success" })
  }

  const handleGear = () => {
    toast({ title: "Table settings", description: "Column visibility coming soon.", variant: "info" })
  }

  // Wire click-to-filter: row click pushes source IP into global filter for cross-page consistency
  // (spec §3.1) and opens the drawer. Inspect button uses stopPropagation so it fires once.
  const handleRowClick = useCallback(
    (row: LogRow) => {
      const ip = getSrcIp(row)
      if (ip) setGlobalFilter(ip)
      if (onInspect) onInspect(row)
    },
    [onInspect, setGlobalFilter],
  )

  return (
    <Panel
      title="Log Inspector"
      description={`${total.toLocaleString()} docs · ${timeRange} window${filter ? ` · filter: ${filter}` : ""}`}
      icon={SearchX}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={actionFilter} onChange={(v) => setActionFilter(v as typeof actionFilter)} options={ACTION_OPTIONS} className="w-36" aria-label="Filter by action" />
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={handleGear} aria-label="Table settings">
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
            {loading ? "LOADING…" : "REFRESH"}
          </Button>
        </div>
      }
    >
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          rowId={getRowId}
          loading={false}
          empty={{
            icon: SearchX,
            title: "No log entries",
            description: "Try a broader time range or clear the filter.",
          }}
          defaultSortBy="timestamp"
          defaultSortDir="desc"
          internalPagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPage}
          onRowClick={handleRowClick}
          ariaLabel="Log Inspector"
        />
      )}
    </Panel>
  )
}
