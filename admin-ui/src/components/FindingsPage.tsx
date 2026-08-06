import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, CheckCircle2, Copy, CornerUpRight, Eraser, History, SearchX, Search, RefreshCcw, Trash2 } from "lucide-react"
import {
  type Finding,
  addBaseUrlToBlacklist,
  addTrackedUrl,
  bulkDeleteFindings,
  clearFindings,
  createPattern,
  deleteFinding,
  getFindings,
  getBlacklistSet,
  listPatterns,
  listTrackedUrls,
  type Pattern,
} from "../api"
import { Button, ConfirmDialog, EmptyState, Input, Pagination, Skeleton, useToast } from "./ui"
import { useDebounce } from "../lib/utils"

const PAGE_SIZE = 25

type SortKey = "id" | "client_ip" | "server_ip" | "url" | "base_url" | "log_timestamp"
type SortDir = "asc" | "desc"

function formatDetected(ts: string) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null || a === "") return 1
  if (b === undefined || b === null || b === "") return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
}

function SortableTh({
  label,
  sortKey,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string
  sortKey: SortKey
  sortBy: SortKey | null
  sortDir: SortDir
  onSort: (key: SortKey) => void
}) {
  const active = sortBy === sortKey
  const Icon = active && sortDir === "asc" ? ArrowUp : ArrowDown
  return (
    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex cursor-pointer items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        aria-label={`Sort by ${label}${active ? `, currently ${sortDir}ending` : ""}`}
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <Icon
          className={active ? "h-3 w-3 opacity-100" : "h-3 w-3 opacity-30"}
          aria-hidden="true"
        />
      </button>
    </th>
  )
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [whitelistIndex, setWhitelistIndex] = useState<Record<string, true>>({})
  const [blacklistIndex, setBlacklistIndex] = useState<Record<string, true>>({})
  const [trackedIndex, setTrackedIndex] = useState<Record<string, true>>({})
  const [sortBy, setSortBy] = useState<SortKey | null>("id")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
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

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setPage(0)
  }

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      // Toggle direction on repeat click.
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(key)
      setSortDir(key === "id" ? "desc" : "asc")
    }
    setPage(0)
  }

  const sortedFindings = useMemo(() => {
    if (!sortBy) return findings
    const dir = sortDir === "asc" ? 1 : -1
    return [...findings].sort((a, b) => dir * compareValues(a[sortBy], b[sortBy]))
  }, [findings, sortBy, sortDir])

  // Drop selections for rows no longer present after a refetch/page change so
  // the bulk bar count never references stale ids.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(findings.map((f) => f.id))
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [findings])

  const allSelected = findings.length > 0 && selectedIds.size === findings.length
  const someSelected = selectedIds.size > 0 && !allSelected

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(findings.map((f) => f.id)))
  }

  const toggleSelectOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedIds]
    // Close the dialog immediately so a double-click can't fire twice.
    setConfirmBulkDelete(false)
    if (ids.length === 0) return
    setBusy(true)
    try {
      const res = await bulkDeleteFindings(ids)
      toast({
        title: `${res.deleted} finding${res.deleted !== 1 ? "s" : ""} deleted`,
        variant: "success",
      })
      setSelectedIds(new Set())
      // If we just emptied the current page, step back a page.
      if (ids.length >= findings.length && page > 0) setPage(page - 1)
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
    // Close the dialog immediately so a double-click can't fire twice.
    setDeleteTarget(null)
    setBusy(true)
    try {
      await deleteFinding(target.id)
      toast({
        title: "Finding deleted",
        description: `${target.client_ip} → ${target.url}`,
        variant: "success",
      })
      // If we just removed the last row on this page, step back a page.
      if (findings.length === 1 && page > 0) setPage(page - 1)
      else refetch()
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleClearAll = async () => {
    // Close the dialog immediately so a double-click can't fire twice.
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

  const handleAddBaseUrl = async (baseUrl: string) => {
    setBusy(true)
    try {
      await createPattern({ pattern: baseUrl, pattern_type: "whitelist" })
      toast({
        title: "Whitelist pattern added",
        description: baseUrl,
        variant: "success",
      })
      // Refresh findings so the row disappears once the new whitelist filter
      // hides it from the graph, and so the W/B button reflects updated state.
      refetch()
      const next: Record<string, true> = { ...whitelistIndex, [baseUrl]: true }
      setWhitelistIndex(next)
    } catch (e) {
      const message = (e as Error).message
      if (message.includes("already exists")) {
        toast({
          title: "Pattern already exists",
          description: baseUrl,
          variant: "info",
        })
      } else {
        toast({ title: "Add pattern failed", description: message, variant: "error" })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleAddToBlacklist = async (baseUrl: string) => {
    setBusy(true)
    try {
      const res = await addBaseUrlToBlacklist(baseUrl)
      if (res.added.length) {
        const next: Record<string, true> = { ...blacklistIndex, [baseUrl]: true }
        setBlacklistIndex(next)
      }
      toast({
        title: res.added.length ? "Added to blacklist" : "Already in blacklist",
        description: baseUrl,
        variant: res.added.length ? "success" : "info",
      })
      refetchBlacklist()
    } catch (e) {
      toast({ title: "Add to blacklist failed", description: (e as Error).message, variant: "error" })
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
        // Fallback for older browsers / non-secure contexts.
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Findings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {total.toLocaleString()} finding{total !== 1 ? "s" : ""} detected
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search IP or URL..."
              value={search}
              onChange={handleSearchChange}
              className="pl-8 w-64"
              aria-label="Search findings"
            />
          </div>
          {selectedIds.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmBulkDelete(true)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete selected ({selectedIds.size})
            </Button>
          )}
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
        </div>
      </div>

      {!loading && total === 0 ? (
        <EmptyState
          icon={SearchX}
          title={debouncedSearch ? "No matching findings" : "No findings yet"}
          description={
            debouncedSearch
              ? "Try adjusting your search."
              : "Findings appear here when the ES poll detects matching log entries."
          }
          action={
            <Button variant="outline" onClick={refetch}>
              Refresh
            </Button>
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    <label className="inline-flex items-center gap-2 uppercase tracking-wide">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelected
                        }}
                        onChange={toggleSelectAll}
                        disabled={busy || findings.length === 0}
                        aria-label="Select all findings"
                        className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      />
                      <span className="sr-only">Select</span>
                    </label>
                  </th>
                  <SortableTh
                    label="ID"
                    sortKey="id"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableTh
                    label="Client IP"
                    sortKey="client_ip"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableTh
                    label="Server IP"
                    sortKey="server_ip"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableTh
                    label="URL"
                    sortKey="url"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableTh
                    label="Base URL"
                    sortKey="base_url"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableTh
                    label="Detected"
                    sortKey="log_timestamp"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b border-border">
                        <td className="px-4 py-3"><Skeleton className="h-4 w-4" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-56" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                        <td className="px-4 py-3" />
                      </tr>
                    ))
                  : sortedFindings.map((f) => (
                      <tr
                        key={f.id}
                        className={`border-b border-border transition-colors hover:bg-muted/30 ${
                          selectedIds.has(f.id) ? "bg-muted/40" : ""
                        }`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(f.id)}
                            onChange={() => toggleSelectOne(f.id)}
                            disabled={busy}
                            aria-label={`Select finding ${f.id}`}
                            className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          />
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{f.id}</td>
                        <td className="px-4 py-3 font-mono text-sm">{f.client_ip}</td>
                        <td className="px-4 py-3 font-mono text-sm">{f.server_ip}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 max-w-[320px]">
                            <span
                              className="font-mono text-xs truncate"
                              title={f.url}
                            >
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
                        </td>
                        <td className="px-4 py-3 font-mono text-sm text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span className="truncate">{f.base_url}</span>
                            {whitelistIndex[f.base_url] ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
                                title="Already in whitelist"
                                aria-label="Already in whitelist"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                whitelist
                              </span>
                            ) : blacklistIndex[f.base_url] ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
                                title="In blacklist"
                                aria-label="In blacklist"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                In blacklist
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {formatDetected(f.log_timestamp)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              onClick={() => handleAddBaseUrl(f.base_url)}
                              disabled={busy || whitelistIndex[f.base_url]}
                              aria-label={`Add base URL ${f.base_url} to whitelist`}
                            >
                              <span className="text-[10px] font-semibold">W</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-muted-foreground hover:text-destructive"
                              onClick={() => handleAddToBlacklist(f.base_url)}
                              disabled={busy || blacklistIndex[f.base_url]}
                              aria-label={`Add base URL ${f.base_url} to blacklist`}
                            >
                              <span className="text-[10px] font-semibold">Blacklist</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              onClick={() => handleTrackRedirect(f.url)}
                              disabled={busy || trackedIndex[f.url]}
                              aria-label={`Track redirects for ${f.url}`}
                            >
                              {trackedIndex[f.url] ? (
                                <History className="h-4 w-4" />
                              ) : (
                                <CornerUpRight className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteTarget(f)}
                              disabled={busy}
                              aria-label={`Delete finding ${f.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        </>
      )}

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
        description={`${selectedIds.size} selected finding${
          selectedIds.size !== 1 ? "s" : ""
        } will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete selected"
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </div>
  )
}
