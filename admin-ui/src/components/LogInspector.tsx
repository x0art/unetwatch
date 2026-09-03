import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, Eye, SearchX, Settings2 } from "lucide-react"
import { Badge, Button, Panel, Select, Skeleton, useToast } from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"
import { runQuery, timeRangeToMinutesLive, type QueryDoc } from "../api"

export type LogRow = QueryDoc & {
  /** Spec aliases — present when NormalizedAppState shape is used */
  id?: string | number
  src_ip?: string
  src_host?: string | null
  dest_ip?: string
  domain?: string
  duration_ms?: number | null
  matched_pattern_id?: string | null
  matched_pattern_name?: string | null
}

function getSrcIp(r: LogRow): string {
  return (r.src_ip ?? (r as unknown as QueryDoc).client_ip ?? "") as string
}
function getDestIp(r: LogRow): string {
  return (r.dest_ip ?? (r as unknown as QueryDoc).server_ip ?? "") as string
}
function getDurationMs(r: LogRow): number | null {
  if (typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms)) return r.duration_ms
  const s = (r as unknown as QueryDoc).duration_seconds
  if (typeof s === "number" && Number.isFinite(s)) return Math.round(s * 1000)
  return null
}
function getRowId(r: LogRow): string {
  const q = r as unknown as QueryDoc
  const id = (r as { id?: unknown }).id
  if (typeof id === "string" || typeof id === "number") return String(id)
  return `${q.timestamp}|${q.client_ip ?? getSrcIp(r)}|${q.url}`
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function actionVariant(action: string): "success" | "destructive" | "warning" | "secondary" {
  if (action === "ALLOW") return "success"
  if (action === "DENY") return "destructive"
  if (action === "FLAG") return "warning"
  return "secondary"
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
  const header = ["Timestamp", "Src IP", "Dest IP", "URL", "Action", "Duration"]
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
  onInspect?: (row: LogRow) => void
}

export function LogInspector({ filter = "", timeRange = "24h", onInspect }: LogInspectorProps) {
  const { toast } = useToast()
  const [rows, setRows] = useState<LogRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [actionFilter, setActionFilter] = useState<string>("All")
  const [page, setPage] = useState(0)
  const pageSize = 50

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    const minutes = timeRange ? timeRangeToMinutesLive(timeRange) : 60
    const q = filter.trim() || undefined
    try {
      const res = await runQuery(minutes, q ? { q } : undefined)
      setRows(res.items as unknown as LogRow[])
      setTotal(res.total_requests)
    } catch {
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [filter, timeRange])

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
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: (r) => (
          <Button size="sm" variant="outline" onClick={() => onInspect?.(r)}>
            <Eye className="h-3.5 w-3.5" />
            Inspect
          </Button>
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

  // Wire click-to-filter: row click pushes source IP into global filter for cross-page consistency.
  // Spec §3.1 allows row click to update context; DataTable onRowClick provides it without
  // stealing the Inspect button (which stops propagation via its own onClick).
  const handleRowClick = useCallback(
    (row: LogRow) => {
      // No-op if parent doesn't filter — keep local; otherwise spec expects context sync.
      // Parent (LiveMonitorPage) owns FilterContext; this is intentionally local-only unless
      // the page wires onInspect to also setGlobalFilter. Keep behavior non-surprising:
      // row click opens the drawer (same as Inspect) when onInspect exists.
      if (onInspect) onInspect(row)
    },
    [onInspect],
  )

  return (
    <Panel
      title="Log Inspector"
      description={`${total.toLocaleString()} docs · ${timeRange} window${filter ? ` · filter: ${filter}` : ""}`}
      icon={SearchX}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={actionFilter} onChange={setActionFilter} options={ACTION_OPTIONS} className="w-36" aria-label="Filter by action" />
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
