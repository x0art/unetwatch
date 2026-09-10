import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  Copy,
  CornerUpRight,
  Eraser,
  History,
  Radar,
  Search,
  SearchX,
  RefreshCcw,
  Trash2,
} from "lucide-react"
import {
  type Finding,
  addTrackedUrl,
  bulkDeleteFindings,
  clearFindings,
  deleteFinding,
  getFindings,
  getBlacklistSet,
  listPatterns,
  originOf,
  listTrackedUrls,
  type Pattern,
} from "../api"
import {
  Button,
  ConfirmDialog,
  CopyUrlButton,
  PageHeader,
  Panel,
  RefreshIntervalSelect,
  SearchInput,
  useToast,
} from "./ui"
import { ListActionCell } from "./ListActionDropdown"
import { DataTable, type DataTableColumn } from "./DataTable"
import { useAutoRefresh, useDebounce } from "../lib/utils"
import { useFilter } from "../contexts/FilterContext"

const DEFAULT_PAGE_SIZE = 25

function formatDetected(ts: string) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

/* Module-level handles to component state, synced each render, so
 * FINDINGS_COLUMNS stays referentially stable at module scope while its
 * cells still read live state (indexes, busy) and trigger actions. */
const FINDINGS_UI: {
  whitelistIndex: Record<string, true>
  blacklistIndex: Record<string, true>
  trackedIndex: Record<string, true>
  busy: boolean
  onBlacklisted: (host: string) => void
  onCopy: (url: string) => void
  onTrack: (url: string) => void
  onDelete: (f: Finding) => void
  onInspectHost: (ip: string) => void
  onInspectUrl: (url: string) => void
} = {
  whitelistIndex: {},
  blacklistIndex: {},
  trackedIndex: {},
  busy: false,
  onBlacklisted: () => {},
  onCopy: () => {},
  onTrack: () => {},
  onDelete: () => {},
  onInspectHost: () => {},
  onInspectUrl: () => {},
}

/** Stable row identity for the findings table. */
const FINDINGS_ROW_ID = (f: Finding) => f.id

/* Module-scope column definitions — referentially stable, so DataTable never
 * re-sorts/re-renders when FindingsPage re-renders (search keystrokes,
 * auto-refresh ticks, busy flips). State reads go through FINDINGS_UI. */
const FINDINGS_COLUMNS: DataTableColumn<Finding>[] = [
  {
    id: "id",
    header: "ID",
    accessor: (f) => f.id,
    cell: (f) => <span className="font-mono text-xs text-muted-foreground">{f.id}</span>,
    width: "w-14",
  },
  {
    id: "client_ip",
    header: "Client IP",
    accessor: (f) => f.client_ip,
    defaultSortDir: "asc",
    cell: (f) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-sm">{f.client_ip}</span>
        <button
          type="button"
          onClick={() => FINDINGS_UI.onInspectHost(f.client_ip)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
          aria-label="Open in Host Inspector"
          title="Open in Host Inspector"
        >
          <Search className="h-3 w-3" />
        </button>
        <CopyUrlButton value={f.client_ip} label="Client IP" />
      </span>
    ),
  },
  {
    id: "server_ip",
    header: "Server IP",
    accessor: (f) => f.server_ip,
    defaultSortDir: "asc",
    cell: (f) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-sm">{f.server_ip}</span>
        <CopyUrlButton value={f.server_ip} label="Server IP" />
      </span>
    ),
  },
  {
    id: "url",
    header: "URL",
    accessor: (f) => f.url,
    defaultSortDir: "asc",
    cell: (f) => (
      <div className="flex items-center gap-2 max-w-[320px]">
        <span className="truncate font-mono text-xs" title={f.url}>
          {f.url}
        </span>
        <button
          type="button"
          onClick={() => FINDINGS_UI.onInspectUrl(f.url)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
          aria-label="Open in URL Investigation"
          title="Open in URL Investigation"
        >
          <Search className="h-3 w-3" />
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => FINDINGS_UI.onCopy(f.url)}
          disabled={FINDINGS_UI.busy}
          aria-label={`Copy URL ${f.url}`}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    ),
  },
  {
    id: "base_url",
    header: "Base URL",
    accessor: (f) => f.base_url,
    defaultSortDir: "asc",
    cell: (f) => (
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-sm text-muted-foreground">{f.base_url}</span>
        <button
          type="button"
          onClick={() => FINDINGS_UI.onInspectUrl(f.base_url)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
          aria-label="Open in URL Investigation"
          title="Open in URL Investigation"
        >
          <Search className="h-3 w-3" />
        </button>
        <CopyUrlButton value={f.base_url} label="Base URL" />
        {FINDINGS_UI.whitelistIndex[f.base_url] ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/20 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
            title="Already in whitelist"
            aria-label="Already in whitelist"
          >
            <CheckCircle2 className="h-3 w-3" />
            Whitelist
          </span>
        ) : FINDINGS_UI.blacklistIndex[f.base_url] ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-danger/20 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger"
            title="In blacklist"
            aria-label="In blacklist"
          >
            <CheckCircle2 className="h-3 w-3" />
            Blacklist
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: "pattern",
    header: "Pattern",
    enableSorting: false,
    accessor: (f) => f.matched_patterns,
    cell: (f) => {
      let pats: string[] = []
      try {
        const parsed = f.matched_patterns ? JSON.parse(f.matched_patterns) : []
        pats = Array.isArray(parsed) ? parsed : []
      } catch {
        pats = []
      }
      const label = pats.join(", ") || "—"
      return (
        <span className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground" title={label}>
          {label}
        </span>
      )
    },
    width: "w-40",
  },
  {
    id: "log_timestamp",
    header: "Detected",
    accessor: (f) => f.log_timestamp,
    cell: (f) => (
      <span className="whitespace-nowrap text-muted-foreground">{formatDetected(f.log_timestamp)}</span>
    ),
    defaultSortDir: "desc",
  },
  {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    enableSorting: false,
    align: "right",
    width: "w-40",
    cell: (f) => (
      <div className="flex justify-end">
        <ListActionCell
          baseUrl={f.base_url}
          onBlacklisted={FINDINGS_UI.onBlacklisted}
          extra={[
            {
              key: "track",
              label: FINDINGS_UI.trackedIndex[originOf(f.url)] ? "Tracked" : "Track redirects",
              icon: FINDINGS_UI.trackedIndex[originOf(f.url)] ? History : CornerUpRight,
              onClick: () => FINDINGS_UI.onTrack(f.url),
              disabled: FINDINGS_UI.busy || FINDINGS_UI.trackedIndex[originOf(f.url)],
            },
            {
              key: "delete",
              label: "Delete finding",
              icon: Trash2,
              variant: "destructive",
              separator: true,
              onClick: () => FINDINGS_UI.onDelete(f),
              disabled: FINDINGS_UI.busy,
            },
          ]}
        />
      </div>
    ),
  },
]

export function FindingsPage({ initialSearch, onNavigate }: { initialSearch?: string; onNavigate?: (view: "host" | "url") => void } = {}) {
  const { toast } = useToast()
  const { setGlobalFilter } = useFilter()
  const [findings, setFindings] = useState<Finding[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [search, setSearch] = useState(initialSearch ?? "")
  const [uniqueDomainsOnly, setUniqueDomainsOnly] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Finding | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [pendingBulk, setPendingBulk] = useState<Set<string | number> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [indexError, setIndexError] = useState(false)
  const [whitelistIndex, setWhitelistIndex] = useState<Record<string, true>>({})
  const [blacklistIndex, setBlacklistIndex] = useState<Record<string, true>>({})
  const [trackedIndex, setTrackedIndex] = useState<Record<string, true>>({})
  const debouncedSearch = useDebounce(search, 300)

  // Keep rows visible while an auto-refresh is in flight (no skeleton flicker).
  // Keyed on "an initial load finished" rather than data presence, so an
  // empty table doesn't re-skeleton on every interval tick.
  const loadedRef = useRef(false)

  // Allow the Graph view to deep-link into findings filtered by an IP/URL.
  // `search` is intentionally excluded from deps: including it would reset
  // the user's typing back to the initial filter on every keystroke.
  useEffect(() => {
    if (initialSearch !== undefined && initialSearch !== search) {
      setSearch(initialSearch)
      setPage(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearch])

  const refetch = useCallback(() => {
    let cancelled = false
    if (!loadedRef.current) setLoading(true)
    setError(null)
    getFindings({
      search: debouncedSearch || undefined,
      limit: pageSize,
      offset: page * pageSize,
    })
      .then((data) => {
        if (cancelled) return
        setFindings(data.items)
        setTotal(data.total)
      })
      .catch((e) => {
        if (!cancelled) {
          setFindings([])
          setTotal(0)
          setError((e as Error).message)
        }
      })
      .finally(() => {
        if (!cancelled) {
          loadedRef.current = true
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, page, pageSize])

  useEffect(() => {
    const cancel = refetch()
    return cancel
  }, [refetch])

  // Live updates: refetch findings on an interval.
  const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refetch, "findings", 0)

  const refetchIndexes = useCallback(async () => {
    setIndexError(false)
    const [wlRes, trackedRes, blRes] = await Promise.allSettled([
      listPatterns({ pattern_type: "whitelist", limit: 5000 }),
      listTrackedUrls({ limit: 5000 }),
      getBlacklistSet(),
    ])
    let failed = false
    if (wlRes.status === "fulfilled") {
      const wlNext: Record<string, true> = {}
      for (const p of wlRes.value as Pattern[]) wlNext[p.pattern] = true
      setWhitelistIndex(wlNext)
    } else {
      failed = true
    }
    if (trackedRes.status === "fulfilled") {
      const trackedNext: Record<string, true> = {}
      for (const t of trackedRes.value.items) trackedNext[t.url] = true
      setTrackedIndex(trackedNext)
    } else {
      failed = true
    }
    if (blRes.status === "fulfilled") {
      const blNext: Record<string, true> = {}
      for (const url of blRes.value.urls) blNext[url] = true
      for (const ip of blRes.value.ips) blNext[ip] = true
      setBlacklistIndex(blNext)
    } else {
      failed = true
    }
    if (failed) setIndexError(true)
  }, [])

  useEffect(() => {
    refetchIndexes()
  }, [refetchIndexes])

  const handleSearchChange = (value: string) => {
    setSearch(value)
    setPage(0)
  }

  const handleBulkDelete = async (ids: Set<string | number>) => {
    const idList = [...ids] as number[]
    setPendingBulk(null)
    setConfirmBulkDelete(false)
    if (idList.length === 0) return
    setBusy(true)
    try {
      const res = await bulkDeleteFindings(idList)
      toast({
        title: `${res.deleted} finding${res.deleted !== 1 ? "s" : ""} deleted`,
        variant: "success",
      })
      // If we just emptied the current page, step back a page.
      if (idList.length >= findings.length && page > 0) setPage(page - 1)
      else refetch()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    setBusy(true)
    try {
      await deleteFinding(target.id)
      toast({
        title: "Finding deleted",
        description: `${target.client_ip} → ${target.url}`,
        variant: "success",
      })
      if (findings.length === 1 && page > 0) setPage(page - 1)
      else refetch()
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleClearAll = async () => {
    setConfirmClear(false)
    setBusy(true)
    try {
      await clearFindings()
      toast({ title: "All findings cleared", variant: "success" })
      setPage(0)
      refetch()
    } catch (e) {
      toast({ title: "Clear failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleTrackRedirect = async (url: string) => {
    // Track the origin (protocol://domain), not the full URL path — avoids
    // duplicate entries when the same domain is tracked via different paths.
    const origin = originOf(url)
    setBusy(true)
    try {
      await addTrackedUrl({ url: origin, source: "finding" })
      toast({ title: "Domain added to redirect tracking", description: origin, variant: "success" })
      setTrackedIndex((prev) => ({ ...prev, [origin]: true }))
    } catch (e) {
      const message = (e as Error).message
      if (message.includes("already tracked")) {
        setTrackedIndex((prev) => ({ ...prev, [origin]: true }))
        toast({ title: "Already tracked", description: origin, variant: "info" })
      } else {
        toast({ title: "Track redirect failed", description: message, variant: "error" })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleCopyUrl = async (url: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        const ta = document.createElement("textarea")
        ta.value = url
        ta.setAttribute("readonly", "")
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      toast({ title: "URL copied", description: url, variant: "success" })
    } catch (e) {
      toast({ title: "Copy failed", description: (e as Error).message, variant: "error" })
    }
  }

  // Sync live state into the module-scope FINDINGS_COLUMNS handles.
  FINDINGS_UI.whitelistIndex = whitelistIndex
  FINDINGS_UI.blacklistIndex = blacklistIndex
  FINDINGS_UI.trackedIndex = trackedIndex
  FINDINGS_UI.busy = busy
  FINDINGS_UI.onBlacklisted = (host) =>
    setBlacklistIndex((prev) => ({ ...prev, [host]: true }))
  FINDINGS_UI.onCopy = handleCopyUrl
  FINDINGS_UI.onTrack = handleTrackRedirect
  FINDINGS_UI.onDelete = (f) => setDeleteTarget(f)
  FINDINGS_UI.onInspectHost = (ip: string) => {
    setGlobalFilter(ip)
    try { window.localStorage.setItem("unetwatch_view", "host") } catch { /* ignore */ }
    onNavigate?.("host")
  }
  FINDINGS_UI.onInspectUrl = (url: string) => {
    setGlobalFilter(url)
    try { window.localStorage.setItem("unetwatch_view", "url") } catch { /* ignore */ }
    onNavigate?.("url")
  }
  const columns: DataTableColumn<Finding>[] = FINDINGS_COLUMNS

  // Optional dedupe to one row per unique domain (base_url).
  const tableFindings = useMemo(() => {
    if (!uniqueDomainsOnly) return findings
    const seen = new Set<string>()
    const out: Finding[] = []
    for (const f of findings) {
      const key = f.base_url || f.url
      if (seen.has(key)) continue
      seen.add(key)
      out.push(f)
    }
    return out
  }, [findings, uniqueDomainsOnly])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Findings"
        description={`${total.toLocaleString()} finding${total !== 1 ? "s" : ""} detected`}
      >
        <SearchInput
          placeholder="Search IP or URL..."
          value={search}
          onChange={handleSearchChange}
          className="w-64"
          aria-label="Search findings"
        />
        <Button
          variant={uniqueDomainsOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setUniqueDomainsOnly((v) => !v)}
          aria-pressed={uniqueDomainsOnly}
        >
          {uniqueDomainsOnly ? "Unique domains" : "Unique domains"}
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
        <RefreshIntervalSelect value={refreshSeconds} onChange={setRefreshSeconds} />
        <Button variant="outline" size="sm" onClick={refetch} disabled={busy}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </PageHeader>

      {error && (
        <div className="flex items-center gap-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-xs font-medium text-destructive">
          <span className="flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}
      {indexError && (
        <div className="flex items-center gap-3 rounded-md border border-warning/20 bg-warning/10 px-4 py-3 text-xs font-medium text-warning">
          <span className="flex-1">Some badges may be unavailable — index data failed to load.</span>
          <Button variant="outline" size="sm" onClick={refetchIndexes}>
            Retry
          </Button>
        </div>
      )}

      <Panel
  title="Findings"
  icon={Radar}
  description={`${total.toLocaleString()} finding${total !== 1 ? "s" : ""} detected`}
>
<DataTable
        columns={columns}
        data={tableFindings}
        rowId={FINDINGS_ROW_ID}
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
        empty={{
          icon: SearchX,
          title: debouncedSearch ? "No matching findings" : "No findings yet",
          description: debouncedSearch
            ? "Try adjusting your search."
            : "Findings appear here when the ES poll detects matching log entries.",
          action: (
            <Button variant="outline" onClick={refetch}>
              Refresh
            </Button>
          ),
        }}
        defaultSortBy="id"
        defaultSortDir="desc"
        page={page}
        pageSize={pageSize}
        onPageSizeChange={(size) => { setPageSize(size); setPage(0) }}
        total={total}
        onPageChange={setPage}
        ariaLabel="Findings"
      />
</Panel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete finding?"
        description={
          deleteTarget
            ? `Finding #${deleteTarget.id} (${deleteTarget.client_ip} → ${deleteTarget.url}) will be permanently removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={confirmClear}
        title="Clear all findings?"
        description={`All ${total.toLocaleString()} persisted findings will be permanently deleted. This cannot be undone.`}
        confirmLabel="Clear all"
        variant="destructive"
        onConfirm={handleClearAll}
        onCancel={() => setConfirmClear(false)}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected findings?"
        description={`${pendingBulk?.size ?? 0} selected finding${
          (pendingBulk?.size ?? 0) !== 1 ? "s" : ""
        } will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete selected"
        variant="destructive"
        onConfirm={() => {
          if (pendingBulk) handleBulkDelete(pendingBulk)
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </div>
  )
}
