import { useCallback, useEffect, useState } from "react"
import { Eraser, SearchX, Search, RefreshCcw, Trash2 } from "lucide-react"
import { type Finding, clearFindings, deleteFinding, getFindings } from "../api"
import { Button, ConfirmDialog, EmptyState, Input, Pagination, Skeleton, useToast } from "./ui"
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
  const [busy, setBusy] = useState(false)
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

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setPage(0)
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
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">ID</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Client IP</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Server IP</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">URL</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Base URL</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Detected</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b border-border">
                        <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-56" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                        <td className="px-4 py-3" />
                      </tr>
                    ))
                  : findings.map((f) => (
                      <tr
                        key={f.id}
                        className="border-b border-border transition-colors hover:bg-muted/30"
                      >
                        <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{f.id}</td>
                        <td className="px-4 py-3 font-mono text-sm">{f.client_ip}</td>
                        <td className="px-4 py-3 font-mono text-sm">{f.server_ip}</td>
                        <td
                          className="px-4 py-3 font-mono text-xs max-w-[320px] truncate"
                          title={f.url}
                        >
                          {f.url}
                        </td>
                        <td className="px-4 py-3 font-mono text-sm text-muted-foreground">
                          {f.base_url}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {formatDetected(f.log_timestamp)}
                        </td>
                        <td className="px-4 py-3 text-right">
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
    </div>
  )
}
