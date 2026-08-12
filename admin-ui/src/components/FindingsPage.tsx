import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2,
  Copy,
  CornerUpRight,
  Eraser,
  History,
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
  listTrackedUrls,
  type Pattern,
} from "../api"
import { Button, ConfirmDialog, CopyUrlButton, PageHeader, SearchInput, useToast } from "./ui"
import { ListActionCell } from "./ListActionDropdown"
import { DataTable, type DataTableColumn } from "./DataTable"
import { useDebounce } from "../lib/utils"

const PAGE_SIZE = 25

function formatDetected(ts: string) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

export function FindingsPage({ initialSearch }: { initialSearch?: string }) {
  const { toast } = useToast()
  const [findings, setFindings] = useState<Finding[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState(initialSearch ?? "")
  const [deleteTarget, setDeleteTarget] = useState<Finding | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [pendingBulk, setPendingBulk] = useState<Set<string | number> | null>(null)
  const [busy, setBusy] = useState(false)
  const [whitelistIndex, setWhitelistIndex] = useState<Record<string, true>>({})
  const [blacklistIndex, setBlacklistIndex] = useState<Record<string, true>>({})
  const [trackedIndex, setTrackedIndex] = useState<Record<string, true>>({})
  const debouncedSearch = useDebounce(search, 300)

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
    setLoading(true)
    getFindings({
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then((data) => {
        if (cancelled) return
        setFindings(data.items)
        setTotal(data.total)
      })
      .catch(() => {
        if (!cancelled) {
          setFindings([])
          setTotal(0)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, page])

  useEffect(() => {
    const cancel = refetch()
    return cancel
  }, [refetch])

  useEffect(() => {
    let cancelled = false
    listPatterns({ pattern_type: "whitelist", limit: 5000 })
      .then((items: Pattern[]) => {
        if (cancelled) return
        const next: Record<string, true> = {}
        for (const p of items) next[p.pattern] = true
        setWhitelistIndex(next)
      })
      .catch(() => {
        if (!cancelled) setWhitelistIndex({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Tracked-for-redirects index (for the Track button state).
  useEffect(() => {
    let cancelled = false
    listTrackedUrls({ limit: 5000 })
      .then((data) => {
        if (cancelled) return
        const next: Record<string, true> = {}
        for (const t of data.items) next[t.url] = true
        setTrackedIndex(next)
      })
      .catch(() => {
        if (!cancelled) setTrackedIndex({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refetchBlacklist = useCallback(() => {
    let cancelled = false
    getBlacklistSet()
      .then((data) => {
        if (cancelled) return
        const next: Record<string, true> = {}
        for (const url of data.urls) next[url] = true
        for (const ip of data.ips) next[ip] = true
        setBlacklistIndex(next)
      })
      .catch(() => {
        if (!cancelled) setBlacklistIndex({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cancel = refetchBlacklist()
    return cancel
  }, [refetchBlacklist])

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
    setBusy(true)
    try {
      await addTrackedUrl({ url, source: "finding" })
      toast({ title: "URL added to redirect tracking", description: url, variant: "success" })
      setTrackedIndex((prev) => ({ ...prev, [url]: true }))
    } catch (e) {
      const message = (e as Error).message
      if (message.includes("already tracked")) {
        setTrackedIndex((prev) => ({ ...prev, [url]: true }))
        toast({ title: "Already tracked", description: url, variant: "info" })
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

  const columns: DataTableColumn<Finding>[] = [
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
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => handleCopyUrl(f.url)}
            disabled={busy}
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
          <CopyUrlButton value={f.base_url} label="Base URL" />
          {whitelistIndex[f.base_url] ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
              title="Already in whitelist"
              aria-label="Already in whitelist"
            >
              <CheckCircle2 className="h-3 w-3" />
              whitelist
            </span>
          ) : blacklistIndex[f.base_url] ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
              title="In blacklist"
              aria-label="In blacklist"
            >
              <CheckCircle2 className="h-3 w-3" />
              In blacklist
            </span>
          ) : null}
        </div>
      ),
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
            extra={[
              {
                key: "track",
                label: trackedIndex[f.url] ? "Tracked" : "Track redirects",
                icon: trackedIndex[f.url] ? History : CornerUpRight,
                onClick: () => handleTrackRedirect(f.url),
                disabled: busy || trackedIndex[f.url],
              },
              {
                key: "delete",
                label: "Delete finding",
                icon: Trash2,
                variant: "destructive",
                separator: true,
                onClick: () => setDeleteTarget(f),
                disabled: busy,
              },
            ]}
          />
        </div>
      ),
    },
  ]

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
          variant="outline"
          size="sm"
          disabled={total === 0 || loading || busy}
          onClick={() => setConfirmClear(true)}
          className="text-destructive hover:text-destructive"
        >
          <Eraser className="h-4 w-4" />
          Clear all
        </Button>
        <Button variant="outline" size="sm" onClick={refetch} disabled={busy}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={findings}
        rowId={(f) => f.id}
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
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        ariaLabel="Findings"
      />

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
