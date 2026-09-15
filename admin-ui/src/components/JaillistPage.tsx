import { useCallback, useEffect, useMemo, useState } from "react"
import { ListPlus } from "lucide-react"
import {
  addClientIpToJaillist,
  bulkAddJaillist,
  bulkDeleteJaillist,
  deleteJaillistEntry,
  getJaillistIps,
  getJaillistUpstreamStatus,
  syncJaillistUpstream,
  type JaillistUpstreamStatus,
} from "../api"
import { FeedCard, type UpstreamFeedState } from "./BlacklistPage"
import {
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Label,
  LoadingIcon,
  SearchInput,
  useToast,
} from "./ui"

export function JaillistPage() {
  const [ips, setIps] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addValue, setAddValue] = useState("")
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [search, setSearch] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Bulk add
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState("")
  const [bulkSubmitting, setBulkSubmitting] = useState(false)

  // Bulk delete (single-feed selection)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  // Upstream sync status for the single jail feed.
  const [upstreamStatus, setUpstreamStatus] = useState<JaillistUpstreamStatus | null>(null)
  const [upstreamSyncing, setUpstreamSyncing] = useState(false)

  const { toast } = useToast()

  const splitLines = useCallback((text: string) => {
    // Feeds are CRLF files — split on \r?\n so entries carry no \r residue
    // (residue would break row-delete/copy, which send the value back).
    return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  }, [])

  const q = search.trim().toLowerCase()
  const filteredIps = useMemo(
    () => (q ? ips.filter((i) => i.toLowerCase().includes(q)) : ips),
    [ips, q],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const text = await getJaillistIps()
      setIps(splitLines(text))
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast({ title: "Failed to load jaillist", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [splitLines, toast])

  const loadUpstreamStatus = useCallback(async () => {
    try {
      setUpstreamStatus(await getJaillistUpstreamStatus())
    } catch {
      // Best-effort: the feed list still renders without upstream status.
    }
  }, [])

  useEffect(() => {
    load()
    void loadUpstreamStatus()
  }, [load, loadUpstreamStatus])

  const jailUpstream: UpstreamFeedState = {
    configured: upstreamStatus?.urls_configured ?? false,
    lastSync: upstreamStatus?.last_sync ?? null,
    lastAdded: upstreamStatus?.last_added ?? 0,
    lastSkipped: upstreamStatus?.last_skipped ?? 0,
    lastErrors: upstreamStatus?.last_errors ?? 0,
    lastError: upstreamStatus?.last_error ?? null,
  }

  const handleFetchUpstream = async () => {
    setUpstreamSyncing(true)
    try {
      const res = await syncJaillistUpstream()
      if (res.ok) {
        const parts: string[] = []
        if (typeof res.fetched === "number") parts.push(`${res.fetched} fetched`)
        if (typeof res.added === "number") parts.push(`${res.added} added`)
        if (typeof res.skipped === "number") parts.push(`${res.skipped} skipped`)
        const errCount = res.errors?.length ?? 0
        if (errCount) parts.push(`${errCount} invalid`)
        toast({
          title: "Upstream fetch complete",
          description: parts.join(" · ") || "Nothing fetched",
          variant: errCount ? "error" : "success",
        })
      } else {
        toast({ title: "Upstream fetch failed", description: res.reason ?? "Unknown error", variant: "error" })
      }
      await loadUpstreamStatus()
      await load()
    } catch (e) {
      toast({ title: "Upstream fetch failed", description: (e as Error).message, variant: "error" })
    } finally {
      setUpstreamSyncing(false)
    }
  }

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast({ title: `${label} copied`, variant: "success" })
      } catch {
        toast({ title: "Copy failed", variant: "error" })
      }
    },
    [toast],
  )

  const add = useCallback(async () => {
    const value = addValue.trim()
    if (!value) return
    setAdding(true)
    try {
      const res = await addClientIpToJaillist(value)
      setAddValue("")
      toast({ title: "Client IP jailed", description: res.added.join(", "), variant: "success" })
      await load()
    } catch (e) {
      toast({ title: "Failed to jail client IP", description: (e as Error).message, variant: "error" })
    } finally {
      setAdding(false)
    }
  }, [addValue, load, toast])

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    setDeleting(true)
    try {
      await deleteJaillistEntry(target)
      toast({ title: "Removed from jaillist", description: target, variant: "success" })
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      await load()
      setDeleting(false)
    }
  }

  const requestDelete = useCallback((_kind: "url" | "ip", value: string) => {
    setDeleteTarget(value)
  }, [])

  /* ── Bulk add ─────────────────────────────────────────────────── */
  const bulkLines = useMemo(
    () => bulkValue.split("\n").map((l) => l.trim()).filter(Boolean),
    [bulkValue],
  )

  const handleBulkAdd = async () => {
    if (bulkLines.length === 0) return
    setBulkSubmitting(true)
    try {
      const res = await bulkAddJaillist(bulkLines)
      const parts: string[] = []
      if (res.added.length) parts.push(`${res.added.length} added`)
      if (res.skipped.length) parts.push(`${res.skipped.length} already present`)
      if (res.errors.length) parts.push(`${res.errors.length} invalid`)
      toast({
        title: "Bulk add complete",
        description: parts.join(" · ") || "Nothing to add",
        variant: res.errors.length ? "error" : "success",
      })
      setBulkOpen(false)
      setBulkValue("")
      await load()
    } catch (e) {
      toast({ title: "Bulk add failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBulkSubmitting(false)
    }
  }

  /* ── Bulk delete ──────────────────────────────────────────────── */
  const enterSelectMode = () => {
    setSelectMode(true)
    setSelected(new Set())
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const toggleSelect = useCallback((value: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const handleBulkDelete = async () => {
    if (!selectMode || selected.size === 0) return
    const values = [...selected]
    setConfirmBulkDelete(false)
    setDeleting(true)
    try {
      const res = await bulkDeleteJaillist(values)
      toast({
        title: `Removed ${res.deleted} entr${res.deleted === 1 ? "y" : "ies"} from jaillist`,
        variant: "success",
      })
      exitSelectMode()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      await load()
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-4">
        <p className="mono-label">Jaillist</p>
        <h2 className="font-semibold tracking-tight mt-1 text-[26px] sm:text-[30px]">Jaillist</h2>
        <p className="mt-1.5 max-w-[60ch] text-xs font-medium leading-relaxed text-muted-foreground">
          Jailed client IPs, consumed as a plain-text feed by the firewall/fail2ban
          enforcement layer via <code className="font-mono">/api/jaillist/ips.txt</code>.
        </p>
      </div>

      <div className="rounded-md border border-border bg-card shadow-sm space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 gap-2">
            <Input
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add()
              }}
              placeholder="Add client IP — e.g. 1.2.3.4"
            />
            <Button onClick={add} disabled={adding || !addValue.trim()}>
              {adding && <LoadingIcon />}
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
          <Button variant="outline" onClick={() => setBulkOpen(true)}>
            <ListPlus className="h-4 w-4" />
            Bulk add
          </Button>
        </div>

        {/* Search */}
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            placeholder="Search jailed IPs..."
            value={search}
            onChange={setSearch}
            className="w-72"
            aria-label="Search jailed client IPs"
          />
          {q && (
            <span className="text-xs text-muted-foreground">
              {filteredIps.length} match
              {filteredIps.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-xs font-medium text-destructive">
          <span className="flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <FeedCard
            title="Jailed client IPs"
            path="/api/jaillist/ips.txt"
            kind="ip"
            entries={filteredIps}
            totalEntries={ips.length}
            searchActive={!!q}
            loading={loading}
            onRefresh={load}
            onCopy={() => copy(ips.join("\n"), "IPs")}
            onDelete={requestDelete}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
            onEnterSelectMode={enterSelectMode}
            onClearSelection={exitSelectMode}
            onDeleteSelected={() => setConfirmBulkDelete(true)}
            disabled={deleting}
            onClearSearch={() => setSearch("")}
            upstream={jailUpstream}
            upstreamSyncing={upstreamSyncing}
            onFetchUpstream={handleFetchUpstream}
          />
        </div>
      )}

      {/* Per-row delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove from jaillist?"
        description={
          deleteTarget
            ? `${deleteTarget} will no longer be jailed.`
            : undefined
        }
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Bulk delete confirm */}
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected entries?"
        description={`${selected.size} selected entr${selected.size === 1 ? "y" : "ies"} will be removed from the jaillist. This cannot be undone.`}
        confirmLabel="Delete selected"
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Bulk add dialog */}
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk add to jaillist">
        <div className="space-y-4">
          <div>
            <Label>Values (one per line)</Label>
            <textarea
              className="flex min-h-[140px] w-full border border-border bg-background px-3 py-2 font-mono text-sm font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder={"1.2.3.4\n5.6.7.8"}
              autoFocus
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {bulkLines.length === 0
                ? "Enter client IPs, one per line."
                : `${bulkLines.length} line${bulkLines.length === 1 ? "" : "s"} will be added`}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleBulkAdd} disabled={bulkLines.length === 0 || bulkSubmitting}>
              {bulkSubmitting ? "Adding…" : `Add${bulkLines.length > 0 ? ` (${bulkLines.length})` : ""}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
