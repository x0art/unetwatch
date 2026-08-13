import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2,
  CircleSlash,
  Eraser,
  Eye,
  FileJson,
  Link2,
  RefreshCcw,
  ScrollText,
  Send,
  Trash2,
  XCircle,
} from "lucide-react"
import {
  type MonitorLog,
  bulkDeleteLogs,
  clearLogs,
  listLogs,
} from "../api"
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn, type SortDir, type SortKey } from "./DataTable"
import { cn } from "../lib/utils"

const PAGE_SIZE = 25

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  { value: "poll", label: "Polls (webhook)" },
  { value: "query", label: "Query runs" },
]

function formatWhen(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString()
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function parseQuery(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/* Module-level handles to component state, synced each render, so
 * LOGS_COLUMNS stays referentially stable at module scope while its cells
 * still open the detail dialog and read the busy flag. */
const LOGS_UI: {
  busy: boolean
  onDetail: (l: MonitorLog) => void
} = {
  busy: false,
  onDetail: () => {},
}

/** Stable row identity for the logs table. */
const LOGS_ROW_ID = (l: MonitorLog) => l.id

/* Module-scope columns for the logs table — referentially stable so
 * DataTable never re-sorts/re-renders when LogsPage re-renders. */
const LOGS_COLUMNS: DataTableColumn<MonitorLog>[] = [
  {
    id: "started_at",
    header: "Time",
    accessor: (l) => l.started_at,
    cell: (l) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground" title={l.started_at}>
        {formatWhen(l.started_at)}
      </span>
    ),
    width: "w-44",
    defaultSortDir: "desc",
  },
  {
    id: "kind",
    header: "Type",
    accessor: (l) => l.kind,
    defaultSortDir: "asc",
    cell: (l) => (
      <Badge variant={l.kind === "poll" ? "default" : "secondary"}>
        {l.kind === "poll" ? "Poll" : "Query"}
      </Badge>
    ),
    width: "w-24",
  },
  {
    id: "minutes",
    header: "Window",
    accessor: (l) => l.minutes,
    cell: (l) => (
      <span className="tabular-nums text-xs text-muted-foreground">
        {l.minutes !== null && l.minutes !== undefined ? `${l.minutes}m` : "—"}
      </span>
    ),
    align: "right",
    width: "w-20",
  },
  {
    id: "matches",
    header: "Hits",
    accessor: (l) => l.matches,
    cell: (l) => <span className="tabular-nums">{l.matches.toLocaleString()}</span>,
    align: "right",
    width: "w-20",
  },
  {
    id: "stored",
    header: "Stored",
    accessor: (l) => l.stored,
    cell: (l) => (
      <span className="tabular-nums text-muted-foreground">
        {l.kind === "poll" ? l.stored.toLocaleString() : "—"}
      </span>
    ),
    align: "right",
    width: "w-20",
  },
  {
    id: "flagged",
    header: "Flagged URLs",
    accessor: (l) => (l.topUrls?.length ?? 0),
    cell: (l) => {
      const urls = l.topUrls ?? []
      if (urls.length === 0) {
        return <span className="text-xs text-muted-foreground/50">—</span>
      }
      return (
        <span className="flex max-w-[280px] items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={urls.join("\n")}>
            {urls[0]}
          </span>
          {urls.length > 1 && (
            <Badge variant="secondary" className="shrink-0">
              +{urls.length - 1}
            </Badge>
          )}
        </span>
      )
    },
    width: "w-64",
  },
  {
    id: "webhook_status",
    header: "Webhook",
    accessor: (l) => l.webhook_status,
    cell: (l) => <WebhookBadge log={l} />,
    enableSorting: true,
    width: "w-24",
  },
  {
    id: "duration_ms",
    header: "Duration",
    accessor: (l) => l.duration_ms,
    cell: (l) => <span className="tabular-nums text-xs">{formatDuration(l.duration_ms)}</span>,
    align: "right",
    width: "w-20",
  },
  {
    id: "error",
    header: "Outcome",
    accessor: (l) => l.error,
    cell: (l) =>
      l.error ? (
        <span className="block max-w-[220px] truncate text-xs text-destructive" title={l.error}>
          {l.error}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5" />
          ok
        </span>
      ),
  },
  {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    enableSorting: false,
    align: "right",
    width: "w-16",
    cell: (l) => (
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        onClick={() => LOGS_UI.onDetail(l)}
        disabled={LOGS_UI.busy}
        aria-label={`View log ${l.id}`}
      >
        <Eye className="h-4 w-4" />
      </Button>
    ),
  },
]

function WebhookBadge({ log }: { log: MonitorLog }) {
  if (log.kind === "query") {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  if (log.webhook_error) {
    return (
      <span title={log.webhook_error}>
        <Badge variant="destructive">
          <XCircle className="mr-1 h-3 w-3" />
          Failed
        </Badge>
      </span>
    )
  }
  if (log.webhook_status !== null && log.webhook_status !== undefined) {
    const ok = log.webhook_status >= 200 && log.webhook_status < 300
    return (
      <span title={`HTTP ${log.webhook_status}`}>
        <Badge variant={ok ? "success" : "destructive"}>
          {ok ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
          {log.webhook_status}
        </Badge>
      </span>
    )
  }
  if (log.webhook_reason) {
    return (
      <span title={log.webhook_reason}>
        <Badge variant="secondary">
          <CircleSlash className="mr-1 h-3 w-3" />
          Skipped
        </Badge>
      </span>
    )
  }
  return <span className="text-xs text-muted-foreground">not sent</span>
}

export function LogsPage() {
  const { toast } = useToast()
  const [items, setItems] = useState<MonitorLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [kind, setKind] = useState("")
  const [sortBy, setSortBy] = useState<SortKey | null>("started_at")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<MonitorLog | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [pendingBulk, setPendingBulk] = useState<Set<string | number> | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    listLogs({
      kind: (kind || undefined) as "poll" | "query" | undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort_by: sortBy ?? "started_at",
      sort_order: sortDir,
    })
      .then((data) => {
        if (cancelled) return
        setItems(data.items)
        setTotal(data.total)
      })
      .catch(() => {
        if (!cancelled) {
          setItems([])
          setTotal(0)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [kind, page, sortBy, sortDir])

  useEffect(() => load(), [load])

  const handleSortChange = (key: SortKey, dir: SortDir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handleBulkDelete = async (ids: Set<string | number>) => {
    const idList = [...ids] as number[]
    setPendingBulk(null)
    setConfirmBulkDelete(false)
    if (!idList.length) return
    setBusy(true)
    try {
      const res = await bulkDeleteLogs(idList)
      toast({ title: `${res.deleted} log${res.deleted === 1 ? "" : "s"} deleted`, variant: "success" })
      if (idList.length >= items.length && page > 0) setPage(page - 1)
      else load()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleClearAll = async () => {
    setConfirmClear(false)
    setBusy(true)
    try {
      const res = await clearLogs()
      toast({ title: `Cleared ${res.deleted} log${res.deleted === 1 ? "" : "s"}`, variant: "success" })
      setPage(0)
      load()
    } catch (e) {
      toast({ title: "Clear failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  // Sync live state into the module-scope LOGS_COLUMNS handles.
  LOGS_UI.busy = busy
  LOGS_UI.onDetail = (l) => setDetail(l)
  const columns: DataTableColumn<MonitorLog>[] = LOGS_COLUMNS

  const parsedQuery = detail ? parseQuery(detail.es_query) : null

  return (
    <div className="space-y-4">
      {/* Header */}
      <PageHeader
        title="Logs"
        description="Audit trail of every Elasticsearch query and webhook delivery — what was sent, how many matched, and whether the alert landed."
      >
        <Select
          value={kind}
          onChange={(v) => {
            setKind(v)
            setPage(0)
          }}
          options={KIND_OPTIONS}
          className="w-40"
          aria-label="Filter log kind"
        />
        <Button variant="outline" size="sm" onClick={load} disabled={loading || busy}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={total === 0 || loading || busy}
          onClick={() => setConfirmClear(true)}
          className="text-destructive hover:text-destructive"
        >
          <Eraser className="h-4 w-4" />
          Clear all
        </Button>
      </PageHeader>

      {loading && items.length === 0 ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-56 w-full rounded-lg" />
        </div>
      ) : total === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <ScrollText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">
            {kind ? `No ${kind} logs yet` : "No logs yet"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground/80">
            Every monitor poll and Query page run is recorded here with its ES query DSL,
            match counts and webhook result.
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={items}
          rowId={LOGS_ROW_ID}
          loading={loading}
          selectable
          busy={busy}
          bulkActions={[
            {
              label: "Delete",
              icon: Trash2,
              variant: "destructive",
              onClick: (ids) => {
                setPendingBulk(ids)
                setConfirmBulkDelete(true)
              },
            },
          ]}
          sortBy={sortBy}
          sortDir={sortDir}
          onSortChange={handleSortChange}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          ariaLabel="Monitor logs"
        />
      )}

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected logs?"
        description={`The selected log entries will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (pendingBulk) handleBulkDelete(pendingBulk)
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      <ConfirmDialog
        open={confirmClear}
        title="Clear all logs?"
        description={`All ${total.toLocaleString()} log entries will be permanently deleted. This cannot be undone.`}
        confirmLabel="Clear all"
        variant="destructive"
        onConfirm={handleClearAll}
        onCancel={() => setConfirmClear(false)}
      />

      {/* Detail dialog */}
      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title="Run details"
        description={detail ? `${detail.kind === "poll" ? "Poll" : "Query run"} · ${formatWhen(detail.started_at)}` : undefined}
        className="max-w-2xl"
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-muted-foreground">Duration</p>
                <p className="mt-0.5 font-semibold tabular-nums">{formatDuration(detail.duration_ms)}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-muted-foreground">Window</p>
                <p className="mt-0.5 font-semibold tabular-nums">
                  {detail.minutes !== null && detail.minutes !== undefined ? `${detail.minutes}m` : "—"}
                </p>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-muted-foreground">ES online</p>
                <p className="mt-0.5 font-semibold">
                  {detail.es_online ? (
                    <span className="text-success">Yes</span>
                  ) : (
                    <span className="text-destructive">No</span>
                  )}
                </p>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-muted-foreground">Raw matches</p>
                <p className="mt-0.5 font-semibold tabular-nums">{detail.matches.toLocaleString()}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-muted-foreground">After filters</p>
                <p className="mt-0.5 font-semibold tabular-nums">{detail.filtered.toLocaleString()}</p>
              </div>
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-muted-foreground">Findings stored</p>
                <p className="mt-0.5 font-semibold tabular-nums">{detail.stored.toLocaleString()}</p>
              </div>
            </div>

            {/* URL matches */}
            {(detail.topUrls?.length ?? 0) > 0 && (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  URL matches
                </div>
                <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3">
                  {detail.topUrls?.map((url) => (
                    <p key={url} className="truncate font-mono text-[11px] leading-relaxed text-foreground/90" title={url}>
                      {url}
                    </p>
                  ))}
                </div>
                {detail.matchedPatterns && detail.matchedPatterns.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Matched pattern{detail.matchedPatterns.length === 1 ? "" : "s"}:{" "}
                    <span className="font-mono text-[10px]">
                      {detail.matchedPatterns.join(", ")}
                    </span>
                  </p>
                )}
              </div>
            )}

            {/* ES query */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
                ES query DSL
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
                {parsedQuery ? JSON.stringify(parsedQuery, null, 2) : detail.es_query ?? "—"}
              </pre>
            </div>

            {/* Webhook */}
            {detail.kind === "poll" && (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  Webhook delivery
                </div>
                <div
                  className={cn(
                    "rounded-md border px-3 py-2 text-xs",
                    detail.webhook_error || (detail.webhook_status !== null && detail.webhook_status >= 300)
                      ? "border-danger/40 bg-danger/10"
                      : detail.webhook_status !== null
                        ? "border-success/40 bg-success/10"
                        : "border-border/60 bg-muted/30",
                  )}
                >
                  <p className="truncate font-mono">{detail.webhook_url ?? "Not configured"}</p>
                  <p className="mt-1 text-muted-foreground">
                    {detail.webhook_error
                      ? `Delivery failed: ${detail.webhook_error}`
                      : detail.webhook_status !== null && detail.webhook_status !== undefined
                        ? `HTTP ${detail.webhook_status}`
                        : detail.webhook_reason
                          ? detail.webhook_reason
                          : "No webhook call was made"}
                  </p>
                </div>
              </div>
            )}

            {detail.error && (
              <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{detail.error}</span>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
