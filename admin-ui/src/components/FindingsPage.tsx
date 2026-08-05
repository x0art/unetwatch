import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Copy, Eraser, SearchX, Search, RefreshCcw, Trash2 } from "lucide-react"
import {
  type Finding,
  clearFindings,
  createPattern,
  deleteFinding,
  getFindings,
  listPatterns,
  type Pattern,
} from "../api"
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
  const [patternIndex, setPatternIndex] = useState<Record<string, "block" | "whitelist">>({})
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
    listPatterns({ limit: 5000 })
      .then((items: Pattern[]) => {
        if (cancelled) return
        const next: Record<string, "block" | "whitelist"> = {}
        for (const p of items) next[p.pattern] = p.pattern_type
        setPatternIndex(next)
      })
      .catch(() => {
        if (!cancelled) setPatternIndex({})
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  const handleAddBaseUrl = async (patternType: "block" | "whitelist", baseUrl: string) => {
    setBusy(true)
    try {
      await createPattern({ pattern: baseUrl, pattern_type: patternType })
      toast({
        title: `${patternType === "block" ? "Block" : "Whitelist"} pattern added`,
        description: baseUrl,
        variant: "success",
      })
      // Refresh findings so the row disappears once the new whitelist filter
      // hides it from the graph, and so the W/B button reflects updated state.
      refetch()
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
                            {patternIndex[f.base_url] ? (
                              <span
                                className={
                                  patternIndex[f.base_url] === "whitelist"
                                    ? "inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
                                    : "inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
                                }
                                title={
                                  patternIndex[f.base_url] === "whitelist"
                                    ? "Already in whitelist"
                                    : "Already in blocklist"
                                }
                                aria-label={
                                  patternIndex[f.base_url] === "whitelist"
                                    ? "Already in whitelist"
                                    : "Already in blocklist"
                                }
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                {patternIndex[f.base_url]}
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
                              onClick={() => handleAddBaseUrl("whitelist", f.base_url)}
                              disabled={busy || patternIndex[f.base_url] === "whitelist"}
                              aria-label={`Add base URL ${f.base_url} to whitelist`}
                            >
                              <span className="text-[10px] font-semibold">W</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => handleAddBaseUrl("block", f.base_url)}
                              disabled={busy || patternIndex[f.base_url] === "block"}
                              aria-label={`Add base URL ${f.base_url} to blocklist`}
                            >
                              <span className="text-[10px] font-semibold">B</span>
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
    </div>
  )
}
