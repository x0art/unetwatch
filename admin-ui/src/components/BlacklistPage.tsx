import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDownToLine,
  Copy,
  Link2,
  ListPlus,
  RefreshCcw,
  Search,
  Trash2,
} from "lucide-react"
import {
  addBaseUrlToBlacklist,
  bulkAddBlacklist,
  bulkDeleteBlacklist,
  deleteBlacklistEntry,
  getBlacklistDomains,
  getBlacklistIps,
  getBlacklistUrls,
  getBlacklistUpstreamStatus,
  sanctionBlacklistDomains,
  syncBlacklistUpstream,
  type BlacklistUpstreamStatus,
} from "../api"
import { copyText } from "../lib/utils"
import {
  Button,
  IconButton,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  CopyUrlButton,
  Dialog,
  EmptyState,
  Input,
  Label,
  LoadingIcon,
  PageHeader,
  SearchInput,
  SkeletonShape,
  Toolbar,
  useToast,
} from "./ui"

export interface UpstreamFeedState {
  /** False when no upstream URL is configured for this feed. */
  configured: boolean
  lastSync: string | null
  lastAdded: number
  lastSkipped: number
  lastErrors: number
  lastError: string | null
}

/** Enforcement-device form of a feed entry: the URL feed is a Palo Alto EDL,
 *  which requires each host terminated with a trailing slash. Display-only —
 *  the bare value stays the identity for keys, delete, and selection. */
function edlDisplay(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

interface FeedCardProps {
  title: string
  path: string
  kind: "url" | "ip" | "domain"
  entries: string[]
  /** Total entries before filtering (shown when a search is active). */
  totalEntries?: number
  searchActive?: boolean
  loading: boolean
  /** A refetch with entries already loaded: keep the list and show a quiet cue. */
  refreshing?: boolean
  onRefresh: () => void
  onCopy: () => void
  onDelete: (kind: "url" | "ip" | "domain", value: string) => void
  /** Selection mode for bulk delete. */
  selectMode?: boolean
  selected?: Set<string>
  onToggleSelect?: (value: string) => void
  onEnterSelectMode?: () => void
  onClearSelection?: () => void
  onDeleteSelected?: () => void
  disabled?: boolean
  onClearSearch?: () => void
  /** Optional muted hint rendered under the feed path. */
  note?: string
  /** Upstream feed state for this card; omit to hide the fetch button. */
  upstream?: UpstreamFeedState
  upstreamSyncing?: boolean
  onFetchUpstream?: () => void
  /** Optional extra header action (rendered last in the button row). */
  extraAction?: React.ReactNode
}

function formatUpstreamLine(u: UpstreamFeedState): string {
  if (!u.configured) return "Upstream: not configured"
  if (!u.lastSync) return "Upstream: configured — never synced"
  const when = new Date(u.lastSync)
  const stamp = Number.isNaN(when.getTime()) ? u.lastSync : when.toLocaleString()
  return `Upstream · ${stamp} — ${u.lastAdded} added · ${u.lastSkipped} skipped · ${u.lastErrors} errors`
}

export function FeedCard({
  title,
  path,
  kind,
  entries,
  totalEntries,
  searchActive,
  loading,
  refreshing = false,
  onRefresh,
  onCopy,
  onDelete,
  selectMode = false,
  selected = new Set(),
  onToggleSelect,
  onEnterSelectMode,
  onClearSelection,
  onDeleteSelected,
  disabled,
  onClearSearch,
  note,
  upstream,
  upstreamSyncing = false,
  onFetchUpstream,
  extraAction,
 }: FeedCardProps) {
  const fetchUpstreamLabel =
    upstream && !upstream.configured ? "No upstream URL configured for this feed" : "Fetch upstream now"
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle>{title}</CardTitle>
            {typeof totalEntries === "number" && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                {searchActive ? `${entries.length}/${totalEntries}` : totalEntries}
              </span>
            )}
          </div>
          <code className="mt-1.5 inline-block rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-bold text-muted-foreground">
            {path}
          </code>
          {note ? <p className="mt-1.5 text-xs text-muted-foreground">{note}</p> : null}
          {upstream ? (
            <p
              className="mt-1.5 text-xs font-medium text-muted-foreground"
              title={upstream.lastError ? `Last error: ${upstream.lastError}` : undefined}
            >
              {formatUpstreamLine(upstream)}
              {upstream.lastError ? <span className="text-destructive"> · {upstream.lastError}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {selectMode ? (
            <Button variant="outline" size="sm" onClick={onClearSelection} disabled={disabled}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onEnterSelectMode} disabled={loading || entries.length === 0}>
                <Trash2 className="h-3.5 w-3.5" />
                Select
              </Button>
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                <RefreshCcw className="h-3.5 w-3.5" />
                Refresh
              </Button>
              {onFetchUpstream ? (
                <span title={fetchUpstreamLabel}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onFetchUpstream}
                    disabled={loading || upstreamSyncing || (upstream ? !upstream.configured : false)}
                    aria-label={fetchUpstreamLabel}
                  >
                    {upstreamSyncing ? <LoadingIcon className="h-3.5 w-3.5" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
                    {upstreamSyncing ? "Fetching…" : "Fetch upstream"}
                  </Button>
                </span>
              ) : null}
              <Button variant="outline" size="sm" onClick={onCopy} disabled={loading || entries.length === 0}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              {extraAction}
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Bulk-select toolbar */}
        {selectMode ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 shadow-sm">
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {selected.size} selected
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={disabled}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onDeleteSelected}
                disabled={selected.size === 0 || disabled}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>
        ) : null}

        {/* A refetch with entries already on screen: keep the list mounted and
            say so. The skeleton above is reserved for the first read. */}
        {refreshing && (
          <span
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            aria-hidden="true"
          >
            <LoadingIcon className="h-3.5 w-3.5" />
            Refreshing feed…
          </span>
        )}

        {loading && entries.length === 0 ? (
          <div className="space-y-3" aria-busy="true">
            {/* The loaded list is a `max-h-80` scrolling feed of one-line rows —
                mirror the container and the row height, not a flat block. */}
            <SkeletonShape variant="feed-list" />
          </div>
        ) : entries.length > 0 ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border bg-muted/30 shadow-sm">
            {entries.map((value) => {
              const isSelected = selected.has(value)
              return (
                <li
                  key={value}
                  className={`group flex items-center gap-2 px-3 py-1.5 transition-colors ${
                    isSelected ? "bg-primary/10" : "hover:bg-muted/40"
                  }`}
                >
                  {selectMode && onToggleSelect && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelect(value)}
                      aria-label={`Select ${value}`}
                      className="h-4 w-4 shrink-0 rounded border-input accent-primary"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={kind === "url" ? edlDisplay(value) : value}>
                    {kind === "url" ? edlDisplay(value) : value}
                  </span>
                  {!selectMode && (
                    <span className="flex items-center gap-1">
                      <CopyUrlButton value={kind === "url" ? edlDisplay(value) : value} label="Entry" />
                      <IconButton
                        icon={Trash2}
                        label={`Remove ${value} from blacklist`}
                        onClick={() => onDelete(kind, value)}
                        disabled={disabled}
                        variant="danger"
                        size="md"
                      />
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        ) : searchActive ? (
          <EmptyState
            icon={Search}
            title="No matches"
            description="Nothing in this feed matches your search."
            action={
              onClearSearch ? (
                <Button variant="outline" size="sm" onClick={onClearSearch}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            icon={Link2}
            title="Empty feed"
            description="No entries yet."
            action={
              <Button variant="outline" size="sm" onClick={onRefresh}>
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </Button>
            }
          />
        )}
      </CardContent>
    </Card>
  )
}

// WHY active: App.tsx keeps every visited page mounted behind a CSS `hidden`
// wrapper, so a hidden Blacklist page would keep firing its mount feed read.
// `active` (the current in-app view) gates that work; it defaults to true so
// the page behaves identically before App.tsx passes the prop.
export function BlacklistPage({ active = true }: { active?: boolean } = {}) {
  const [urls, setUrls] = useState<string[]>([])
  const [ips, setIps] = useState<string[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // True once the first feed read finished. A later refetch keeps the lists
  // mounted and reports itself quietly; a refetch ERROR keeps them too, so a
  // transient failure never blanks a populated feed.
  const haveEntries = urls.length > 0 || ips.length > 0 || domains.length > 0
  const [addValue, setAddValue] = useState("")
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [search, setSearch] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "url" | "ip" | "domain"
    value: string
  } | null>(null)

  // Bulk add
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState("")
  const [bulkSubmitting, setBulkSubmitting] = useState(false)

  // Bulk delete (per-feed selection)
  const [selectFeed, setSelectFeed] = useState<"url" | "ip" | "domain" | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  // Domain feed is DERIVED from the URL feed — no upstream, manual re-derive.
  const [deriving, setDeriving] = useState(false)

  // Upstream sync: per-feed status, one combined sync call.
  const [upstreamStatus, setUpstreamStatus] = useState<BlacklistUpstreamStatus | null>(null)
  const [upstreamSyncing, setUpstreamSyncing] = useState(false)

  const { toast } = useToast()

  const splitLines = useCallback((text: string) => {
    // Feeds are CRLF files — split on \r?\n so entries carry no \r residue
    // (residue would break row-delete/copy, which send the value back).
    return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  }, [])

  const q = search.trim().toLowerCase()
  const filteredUrls = useMemo(
    () => (q ? urls.filter((u) => u.toLowerCase().includes(q)) : urls),
    [urls, q],
  )
  const filteredIps = useMemo(
    () => (q ? ips.filter((i) => i.toLowerCase().includes(q)) : ips),
    [ips, q],
  )
  const filteredDomains = useMemo(
    () => (q ? domains.filter((d) => d.toLowerCase().includes(q)) : domains),
    [domains, q],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [u, i, d] = await Promise.all([
        getBlacklistUrls(),
        getBlacklistIps(),
        getBlacklistDomains(),
      ])
      setUrls(splitLines(u))
      setIps(splitLines(i))
      setDomains(splitLines(d))
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast({ title: "Failed to load blacklist", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [splitLines, toast])

  const loadUpstreamStatus = useCallback(async () => {
    try {
      setUpstreamStatus(await getBlacklistUpstreamStatus())
    } catch {
      // Best-effort: the feed lists still render without upstream status.
    }
  }, [])

  // Keyed on `active` (not `load`/`loadUpstreamStatus`, which stay out of deps
  // on purpose): an inactive page reads nothing, the first visit has `active`
  // already true so it still loads immediately, and later visits refetch on
  // arrival.
  useEffect(() => {
    if (!active) return
    load()
    void loadUpstreamStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const urlsFeed = upstreamStatus?.feeds.urls
  const ipsFeed = upstreamStatus?.feeds.ips
  const urlsUpstream: UpstreamFeedState = {
    configured: upstreamStatus?.urls_configured ?? false,
    lastSync: upstreamStatus?.last_sync ?? null,
    lastAdded: urlsFeed?.last_added ?? 0,
    lastSkipped: urlsFeed?.last_skipped ?? 0,
    lastErrors: urlsFeed?.last_errors ?? 0,
    lastError: urlsFeed?.last_error ?? upstreamStatus?.last_error ?? null,
  }
  const ipsUpstream: UpstreamFeedState = {
    configured: upstreamStatus?.ips_configured ?? false,
    lastSync: upstreamStatus?.last_sync ?? null,
    lastAdded: ipsFeed?.last_added ?? 0,
    lastSkipped: ipsFeed?.last_skipped ?? 0,
    lastErrors: ipsFeed?.last_errors ?? 0,
    lastError: ipsFeed?.last_error ?? upstreamStatus?.last_error ?? null,
  }

  const handleFetchUpstream = async () => {
    setUpstreamSyncing(true)
    try {
      const res = await syncBlacklistUpstream()
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

  // Manual re-derive of the domain feed from the URL blacklist.
  const handleSanctionDomains = async () => {
    setDeriving(true)
    try {
      const res = await sanctionBlacklistDomains()
      const parts: string[] = []
      parts.push(`${res.scanned} scanned`)
      parts.push(`${res.added} added`)
      parts.push(`${res.skipped} skipped`)
      parts.push(`${res.pruned} pruned`)
      toast({
        title: res.ok ? "Domain feed re-derived" : "Domain feed re-derive failed",
        description: parts.join(" · "),
        variant: res.ok ? "success" : "error",
      })
      await load()
    } catch (e) {
      toast({ title: "Domain feed re-derive failed", description: (e as Error).message, variant: "error" })
    } finally {
      setDeriving(false)
    }
  }

  const copy = useCallback(
    async (text: string, label: string) => {
      const ok = await copyText(text)
      if (ok) toast({ title: `${label} copied`, variant: "success" })
      else toast({ title: "Copy failed", variant: "error" })
    },
    [toast],
  )

  const add = useCallback(async () => {
    const value = addValue.trim()
    if (!value) return
    setAdding(true)
    try {
      const res = await addBaseUrlToBlacklist(value)
      setAddValue("")
      toast({ title: "Added to blacklist", description: res.added.join(", "), variant: "success" })
      await load()
    } catch (e) {
      toast({ title: "Failed to add blacklist entry", description: (e as Error).message, variant: "error" })
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
      await deleteBlacklistEntry(target.kind, target.value)
      toast({ title: "Removed from blacklist", description: target.value, variant: "success" })
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      // Refresh either way so a stale row (e.g. already removed server-side)
      // never lingers in the list.
      await load()
      setDeleting(false)
    }
  }

  const requestDelete = useCallback((kind: "url" | "ip" | "domain", value: string) => {
    setDeleteTarget({ kind, value })
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
      const res = await bulkAddBlacklist(bulkLines)
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
  const enterSelectMode = (kind: "url" | "ip" | "domain") => {
    setSelectFeed(kind)
    setSelected(new Set())
  }

  const exitSelectMode = () => {
    setSelectFeed(null)
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
    if (!selectFeed || selected.size === 0) return
    const kind = selectFeed
    const values = [...selected]
    setConfirmBulkDelete(false)
    setDeleting(true)
    try {
      const res = await bulkDeleteBlacklist(values.map((v) => ({ kind, value: v })))
      toast({
        title: `Removed ${res.deleted} entr${res.deleted === 1 ? "y" : "ies"} from ${kind} blacklist`,
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
    // Page root is the canonical `space-y-5`; the title row is the shared
    // `PageHeader` so it can never drift from every other page's title again.
    <div className="space-y-5">
      <PageHeader
        title="Blacklist"
        description="Blacklisted destinations, consumed as separate URL, IP, and domain feeds by the device firewall (nginx/fail2ban). IP entries are destinations whose host is an IP address; the domain feed is derived from the URL entries."
      />

      <div className="rounded-md border border-border bg-card shadow-sm space-y-4 p-4">
        <Toolbar
          aria-label="Blacklist add controls"
          left={
            <div className="flex min-w-0 flex-1 gap-2">
              <Input
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add()
                }}
                placeholder="Add URL or IP — saved as bare host"
              />
              <Button onClick={add} disabled={adding || !addValue.trim()}>
                {adding && <LoadingIcon />}
                {adding ? "Adding…" : "Add"}
              </Button>
            </div>
          }
          right={
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              <ListPlus className="h-4 w-4" />
              Bulk add
            </Button>
          }
        />

        {/* Search */}
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            placeholder="Search URLs or IPs..."
            value={search}
            onChange={setSearch}
            className="w-72"
            aria-label="Search blacklist entries"
          />
          {q && (
            <span className="text-xs text-muted-foreground">
              {filteredUrls.length + filteredIps.length + filteredDomains.length} match
              {filteredUrls.length + filteredIps.length + filteredDomains.length === 1 ? "" : "es"} across all feeds
            </span>
          )}
        </div>
      </div>

      {error && !haveEntries ? (
        <Callout action={<Button variant="outline" size="sm" onClick={load}>Retry</Button>}>
          {error}
        </Callout>
      ) : (
        <div className="space-y-4">
          {/* A refetch failure with feeds already on screen still shows the
              error, but never hides the data the operator can still act on. */}
          {error && haveEntries && (
            <Callout action={<Button variant="outline" size="sm" onClick={load}>Retry</Button>}>
              Refresh failed — {error}
            </Callout>
          )}
          <FeedCard
            title="URL blacklist"
            path="/api/blacklist/urls.txt"
            kind="url"
            entries={filteredUrls}
            totalEntries={urls.length}
            searchActive={!!q}
            loading={loading}
            refreshing={loading && haveEntries}
            onRefresh={load}
            note="EDL form — each host terminated with a trailing slash"
            onCopy={() => copy(urls.map(edlDisplay).join("\n"), "URLs")}
            onDelete={requestDelete}
            selectMode={selectFeed === "url"}
            selected={selected}
            onToggleSelect={toggleSelect}
            onEnterSelectMode={() => enterSelectMode("url")}
            onClearSelection={exitSelectMode}
            onDeleteSelected={() => setConfirmBulkDelete(true)}
            disabled={deleting}
            onClearSearch={() => setSearch("")}
            upstream={upstreamStatus ? urlsUpstream : undefined}
            upstreamSyncing={upstreamSyncing}
            onFetchUpstream={handleFetchUpstream}
          />
          <FeedCard
            title="Destination IP blacklist"
            path="/api/blacklist/ips.txt"
            kind="ip"
            entries={filteredIps}
            totalEntries={ips.length}
            searchActive={!!q}
            loading={loading}
            refreshing={loading && haveEntries}
            onRefresh={load}
            onCopy={() => copy(ips.join("\n"), "IPs")}
            onDelete={requestDelete}
            selectMode={selectFeed === "ip"}
            selected={selected}
            onToggleSelect={toggleSelect}
            onEnterSelectMode={() => enterSelectMode("ip")}
            onClearSelection={exitSelectMode}
            onDeleteSelected={() => setConfirmBulkDelete(true)}
            disabled={deleting}
            onClearSearch={() => setSearch("")}
            upstream={upstreamStatus ? ipsUpstream : undefined}
            upstreamSyncing={upstreamSyncing}
            onFetchUpstream={handleFetchUpstream}
          />
          {/* Third card: the DERIVED domain feed. No upstream — it is
              sanctioned from the URL blacklist, so the header offers a
              manual "Re-derive" instead of a fetch button. */}
          <FeedCard
            title="Domain Blacklist"
            path="/api/blacklist/domains.txt"
            kind="domain"
            entries={filteredDomains}
            totalEntries={domains.length}
            searchActive={!!q}
            loading={loading}
            refreshing={loading && haveEntries}
            onRefresh={load}
            note="Derived from the URL blacklist — domains sanctioned from URL entries. No upstream feed."
            onCopy={() => copy(domains.join("\n"), "Domains")}
            onDelete={requestDelete}
            selectMode={selectFeed === "domain"}
            selected={selected}
            onToggleSelect={toggleSelect}
            onEnterSelectMode={() => enterSelectMode("domain")}
            onClearSelection={exitSelectMode}
            onDeleteSelected={() => setConfirmBulkDelete(true)}
            disabled={deleting}
            onClearSearch={() => setSearch("")}
            extraAction={
              <Button variant="outline" size="sm" onClick={handleSanctionDomains} disabled={loading || deriving}>
                {deriving ? <LoadingIcon className="h-3.5 w-3.5" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                {deriving ? "Re-deriving…" : "Re-derive"}
              </Button>
            }
          />
        </div>
      )}

      {/* Per-row delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove from blacklist?"
        description={
          deleteTarget
            ? `${deleteTarget.value} will no longer be blocked by the ${
                deleteTarget.kind === "domain" ? "domain" : deleteTarget.kind
              } blacklist.`
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
        description={
          selectFeed
            ? `${selected.size} selected entr${selected.size === 1 ? "y" : "ies"} will be removed from the ${
                selectFeed === "domain" ? "domain" : selectFeed
              } blacklist. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete selected"
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Bulk add dialog */}
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk add to blacklist">
        <div className="space-y-4">
          <div>
            <Label>Values (one per line)</Label>
            <textarea
              className="flex min-h-[140px] w-full border border-border bg-background px-3 py-2 font-mono text-sm font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder={"http://example.com/foo\n1.2.3.4"}
              aria-label="Values (one per line)"
              autoFocus
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {bulkLines.length === 0
                ? "Enter URLs or IPs, one per line. Each is saved as a bare host."
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
