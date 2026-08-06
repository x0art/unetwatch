import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  CornerUpRight,
  GitBranch,
  History,
  RefreshCcw,
  Search,
  SearchX,
  Trash2,
  Zap,
} from "lucide-react"
import {
  type RedirectGraph,
  type RedirectLink,
  type TrackedUrl,
  type UrlRedirectHistory,
  addTrackedUrl,
  checkRedirects,
  deleteTrackedUrl,
  getRedirectGraph,
  getUrlRedirectHistory,
  listTrackedUrls,
} from "../api"
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Input,
  Pagination,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { useDebounce, cn } from "../lib/utils"

const PAGE_SIZE = 25

const STATUS_META: Record<
  TrackedUrl["status"],
  { label: string; variant: "secondary" | "success" | "warning" | "destructive" }
> = {
  unknown: { label: "Unknown", variant: "secondary" },
  ok: { label: "OK", variant: "success" },
  redirect: { label: "Redirecting", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
}

const SOURCE_META: Record<
  TrackedUrl["source"],
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  manual: { label: "Manual", variant: "secondary" },
  finding: { label: "From finding", variant: "outline" },
  auto: { label: "Auto", variant: "default" },
}

type SortKey = "id" | "url" | "source" | "status" | "last_checked_at"
type SortDir = "asc" | "desc"

function formatWhen(ts: string | null) {
  if (!ts) return "—"
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
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
        <Icon className={active ? "h-3 w-3 opacity-100" : "h-3 w-3 opacity-30"} aria-hidden="true" />
      </button>
    </th>
  )
}

/* ── Depth-layered graph (Traffic Graph style) ──────────────────────── */

const COLUMN_WIDTH = 380
const COLUMN_GAP = 40
const START_X = 24

const NODE_HEIGHT = 40
const TOP_PAD = 84
const BOTTOM_PAD = 32
const MAX_CANVAS_HEIGHT = 640

const STATUS_NODE_STYLE: Record<TrackedUrl["status"], string> = {
  ok: "fill-success/15 stroke-success",
  redirect: "fill-warning/15 stroke-warning",
  error: "fill-danger/15 stroke-danger",
  unknown: "fill-muted/30 stroke-muted-foreground/50",
}

const STATUS_LABEL_STYLE: Record<TrackedUrl["status"], string> = {
  ok: "fill-success",
  redirect: "fill-warning",
  error: "fill-danger",
  unknown: "fill-muted-foreground",
}

interface LayoutNode {
  id: string
  depth: number
  url: string
  status: TrackedUrl["status"]
  history_count: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * Longest-path layering: a node's depth is 1 + the max depth of its
 * incoming neighbours; nodes with no incoming edges sit at depth 0, so
 * chains like url1 → url2 → url3 flow left to right across columns.
 * Cycles (rare) are parked in a fallback column instead of looping.
 */
function computeDepths(nodeIds: Set<string>, links: RedirectLink[]): Map<string, number> {
  const preds = new Map<string, string[]>()
  for (const id of nodeIds) preds.set(id, [])
  for (const l of links) {
    if (!nodeIds.has(l.source) || !nodeIds.has(l.target)) continue
    preds.get(l.target)!.push(l.source)
  }

  const depth = new Map<string, number>()
  const remaining = new Set(nodeIds)
  let fallback = 0
  while (remaining.size > 0) {
    const frontier = [...remaining].filter((n) =>
      preds.get(n)!.every((p) => depth.has(p)),
    )
    if (frontier.length === 0) {
      // Cycle: park the rest in one fallback column.
      for (const n of remaining) depth.set(n, fallback)
      break
    }
    for (const n of frontier) {
      const predDepths = preds.get(n)!.map((p) => depth.get(p)!)
      depth.set(n, predDepths.length === 0 ? 0 : 1 + Math.max(...predDepths))
      remaining.delete(n)
    }
    fallback += 1
  }
  return depth
}

function buildLayout(graph: RedirectGraph, showHistory: boolean) {
  // When historical edges are shown, include the nodes they touch so the
  // dashed edges (e.g. url1→url2 before url2 stopped being a destination)
  // actually render. Otherwise only active relations are placed.
  const links = showHistory ? graph.links : graph.links.filter((l) => l.active)
  const nodeIds = new Set<string>()
  for (const l of links) {
    nodeIds.add(l.source)
    nodeIds.add(l.target)
  }
  const depths = computeDepths(nodeIds, links)
  const relevantNodes = graph.nodes.filter((n) => nodeIds.has(n.id))

  const byDepth = new Map<number, RedirectGraph["nodes"]>()
  for (const n of relevantNodes) {
    const d = depths.get(n.id) ?? 0
    const list = byDepth.get(d) ?? []
    list.push(n)
    byDepth.set(d, list)
  }

  const maxRows = Math.max(1, ...[...byDepth.values()].map((l) => l.length))
  const slot = Math.max(
    52,
    Math.min(64, Math.floor((MAX_CANVAS_HEIGHT - TOP_PAD - BOTTOM_PAD) / maxRows)),
  )
  const height = Math.max(320, TOP_PAD + maxRows * slot + BOTTOM_PAD)
  const maxDepth = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0

  const nodes: LayoutNode[] = []
  for (const [d, list] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.label.localeCompare(b.label))
    const x = START_X + d * (COLUMN_WIDTH + COLUMN_GAP)
    list.forEach((n, i) => {
      nodes.push({
        id: n.id,
        depth: d,
        url: n.id,
        status: n.status,
        history_count: n.history_count,
        x,
        y: TOP_PAD + i * slot + (slot - NODE_HEIGHT) / 2,
        width: COLUMN_WIDTH,
        height: NODE_HEIGHT,
      })
    })
  }

  const columns = Array.from({ length: maxDepth + 1 }, (_, d) => ({
    depth: d,
    x: START_X + d * (COLUMN_WIDTH + COLUMN_GAP),
    label: d === 0 ? "Sources" : `Hop ${d}`,
  }))

  return {
    nodes,
    columns,
    width: START_X + maxDepth * (COLUMN_WIDTH + COLUMN_GAP) + COLUMN_WIDTH + 16,
    height,
  }
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function edgePath(a: LayoutNode, b: LayoutNode) {
  const sx = a.x + a.width
  const sy = a.y + a.height / 2
  const tx = b.x
  const ty = b.y + b.height / 2
  const dx = Math.max(40, (tx - sx) / 2)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function RedirectsPage() {
  const { toast } = useToast()
  const [items, setItems] = useState<TrackedUrl[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [graph, setGraph] = useState<RedirectGraph | null>(null)
  const [graphLoading, setGraphLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState<SortKey | null>("id")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [addUrl, setAddUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TrackedUrl | null>(null)
  const [historyTarget, setHistoryTarget] = useState<TrackedUrl | null>(null)
  const [history, setHistory] = useState<UrlRedirectHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [showHistory, setShowHistory] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)

  const debouncedSearch = useDebounce(search, 300)
  const activeUrl = focused ?? hovered

  const loadTable = useCallback(() => {
    let cancelled = false
    setLoading(true)
    listTrackedUrls({
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort_by: sortBy ?? undefined,
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
  }, [debouncedSearch, page, sortBy, sortDir])

  const loadGraph = useCallback(() => {
    let cancelled = false
    setGraphLoading(true)
    getRedirectGraph()
      .then((data) => {
        if (!cancelled) setGraph(data)
      })
      .catch(() => {
        if (!cancelled) setGraph(null)
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => loadTable(), [loadTable])
  useEffect(() => loadGraph(), [loadGraph])

  const reload = useCallback(() => {
    loadTable()
    loadGraph()
  }, [loadTable, loadGraph])

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setPage(0)
  }

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(key)
      setSortDir(key === "id" ? "desc" : "asc")
    }
    setPage(0)
  }

  const handleAdd = async () => {
    const url = addUrl.trim()
    if (!url) return
    setBusy(true)
    try {
      await addTrackedUrl({ url, source: "manual" })
      toast({ title: "URL added to redirect tracking", description: url, variant: "success" })
      setAddUrl("")
      reload()
    } catch (e) {
      const message = (e as Error).message
      if (message.includes("already tracked")) {
        toast({ title: "Already tracked", description: url, variant: "info" })
      } else {
        toast({ title: "Failed to add URL", description: message, variant: "error" })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleCheckNow = async () => {
    setBusy(true)
    try {
      const res = await checkRedirects()
      const changed = res.updated.filter((u) => u.error || u.status === "redirect").length
      toast({
        title: `Checked ${res.checked} URL${res.checked === 1 ? "" : "s"}`,
        description: `${changed} changed or errored`,
        variant: changed ? "info" : "success",
      })
      reload()
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleCheckOne = async (item: TrackedUrl) => {
    setBusyUrl(item.url)
    try {
      const res = await checkRedirects(item.url)
      const result = res.updated[0]
      toast({
        title: `Checked ${item.url}`,
        description: result
          ? `${STATUS_META[result.status].label}${
              result.final_url && result.final_url !== item.url
                ? ` → ${result.final_url}`
                : ""
            }`
          : "No result",
        variant:
          result?.status === "error"
            ? "error"
            : result?.status === "redirect"
              ? "info"
              : "success",
      })
      reload()
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusyUrl(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    setBusy(true)
    try {
      await deleteTrackedUrl(target.id)
      toast({
        title: "URL removed from tracking",
        description: target.url,
        variant: "success",
      })
      if (items.length === 1 && page > 0) setPage(page - 1)
      else reload()
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const openHistory = async (target: TrackedUrl) => {
    setHistoryTarget(target)
    setHistory(null)
    setHistoryLoading(true)
    try {
      setHistory(await getUrlRedirectHistory(target.id))
    } catch (e) {
      toast({ title: "Failed to load history", description: (e as Error).message, variant: "error" })
    } finally {
      setHistoryLoading(false)
    }
  }

  /* Stats from the full node set (graph endpoint returns every tracked URL) */
  const stats = useMemo(() => {
    const nodes = graph?.nodes ?? []
    return {
      total: nodes.length,
      redirecting: nodes.filter((n) => n.status === "redirect").length,
      ok: nodes.filter((n) => n.status === "ok").length,
      error: nodes.filter((n) => n.status === "error").length,
    }
  }, [graph])

  /* Graph interactivity */
  const layout = useMemo(
    () => (graph ? buildLayout(graph, showHistory) : null),
    [graph, showHistory],
  )
  const layoutById = useMemo(
    () => new Map((layout?.nodes ?? []).map((n) => [n.id, n])),
    [layout],
  )
  const visibleLinks = useMemo(
    () => (graph?.links ?? []).filter((l) => showHistory || l.active),
    [graph, showHistory],
  )

  const isNodeActive = (url: string) =>
    activeUrl === null ||
    url === activeUrl ||
    !!graph?.links.some(
      (l) =>
        (l.source === activeUrl && l.target === url) ||
        (l.source === url && l.target === activeUrl),
    )

  const isLinkActive = (l: { source: string; target: string }) =>
    activeUrl === null || l.source === activeUrl || l.target === activeUrl

  const focusNode = (url: string) => {
    setSearch(url)
    setPage(0)
    toast({ title: "Filtering table", description: url, variant: "info" })
  }

  const tableEmpty = !loading && total === 0
  const graphEmpty =
    !graphLoading && (!graph || graph.nodes.length === 0 || (layout?.nodes.length ?? 0) === 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Redirect Tracker</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            URLs under watch for redirects — chains are followed, destinations monitored, and
            target changes recorded over time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <CornerUpRight className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd()
              }}
              placeholder="http://example.com/path"
              className="w-72 pl-8"
              aria-label="Add URL to redirect tracking"
            />
          </div>
          <Button onClick={handleAdd} disabled={busy || !addUrl.trim()}>
            Track URL
          </Button>
          <Button variant="outline" size="sm" onClick={handleCheckNow} disabled={busy || loading}>
            <Zap className="h-4 w-4" />
            Check now
          </Button>
          <Button variant="outline" size="sm" onClick={reload} disabled={busy}>
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={GitBranch} label="Tracked URLs" value={stats.total.toLocaleString()} tone="info" hint="Manual + auto-discovered" />
        <StatCard icon={CornerUpRight} label="Redirecting" value={stats.redirecting.toLocaleString()} tone="warning" hint="Currently pointing elsewhere" />
        <StatCard icon={RefreshCcw} label="OK" value={stats.ok.toLocaleString()} tone="success" hint="No redirect, reachable" />
        <StatCard icon={SearchX} label="Errors" value={stats.error.toLocaleString()} tone="danger" hint="Unreachable or failed check" />
      </div>

      {/* Graph */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">URL relations</h3>
            <p className="text-xs text-muted-foreground">
              Current redirect flow between tracked URLs. Click a node to filter the table.
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            Show historical edges
          </label>
        </div>

        {graphLoading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : graphEmpty ? (
          <EmptyState
            icon={GitBranch}
            title="No relations yet"
            description="Track a URL and run “Check now” — redirect chains will appear here as nodes and edges."
            className="border-0"
          />
        ) : layout && graph ? (
          <div className="overflow-auto p-2">
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label="URL redirect relations graph"
              className="block"
            >
              <defs>
                <marker
                  id="redirect-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/60" />
                </marker>
              </defs>

              {layout.columns.map((c) => (
                <text
                  key={c.depth}
                  x={c.x + COLUMN_WIDTH / 2}
                  y={TOP_PAD - 30}
                  textAnchor="middle"
                  fontSize={10}
                  letterSpacing="0.14em"
                  className="fill-muted-foreground font-medium uppercase"
                >
                  {c.label}
                </text>
              ))}

              {visibleLinks.map((l, i) => {
                const src = layoutById.get(l.source)
                const dst = layoutById.get(l.target)
                if (!src || !dst) return null
                const active = isLinkActive(l)
                return (
                  <path
                    key={i}
                    d={edgePath(src, dst)}
                    fill="none"
                    strokeDasharray={l.active ? undefined : "6 5"}
                    className={cn(
                      "transition-opacity duration-150",
                      active && activeUrl
                        ? l.active
                          ? "stroke-warning"
                          : "stroke-muted-foreground/70"
                        : "stroke-muted",
                    )}
                    style={{
                      strokeWidth: l.active ? 1.8 : 1,
                      opacity: active ? (activeUrl ? 1 : 0.55) : 0.12,
                    }}
                    markerEnd="url(#redirect-arrow)"
                  >
                    <title>
                      {`${l.source} → ${l.target} · HTTP ${l.http_status}${l.active ? "" : " (historical)"}`}
                    </title>
                  </path>
                )
              })}

              {layout.nodes.map((n) => (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.url} — ${n.history_count} targets seen. Filter table.`}
                  onClick={() => focusNode(n.url)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      focusNode(n.url)
                    }
                  }}
                  onMouseEnter={() => setHovered(n.url)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setFocused(n.url)}
                  onBlur={() => setFocused(null)}
                  className="cursor-pointer transition-opacity duration-150"
                  style={{ opacity: isNodeActive(n.url) ? 1 : 0.25 }}
                >
                  <rect
                    x={n.x}
                    y={n.y}
                    width={n.width}
                    height={n.height}
                    rx={9}
                    strokeWidth={activeUrl === n.url ? 2 : 1.2}
                    className={cn(STATUS_NODE_STYLE[n.status], "transition-all duration-150")}
                  />
                  <text
                    x={n.x + n.width / 2}
                    y={n.y + n.height / 2 - 5}
                    textAnchor="middle"
                    fontSize={11}
                    className={cn(STATUS_LABEL_STYLE[n.status], "font-mono")}
                  >
                    {truncate(n.url, 46)}
                  </text>
                  <text
                    x={n.x + n.width / 2}
                    y={n.y + n.height / 2 + 10}
                    textAnchor="middle"
                    fontSize={9.5}
                    className="fill-muted-foreground"
                  >
                    {n.history_count === 0
                      ? "no target seen"
                      : `${n.history_count} target${n.history_count === 1 ? "" : "s"} seen`}
                  </text>
                  <title>{`${n.url} — ${n.history_count} target${n.history_count === 1 ? "" : "s"} seen`}</title>
                </g>
              ))}
            </svg>
          </div>
        ) : null}
      </div>

      {/* Table */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} tracked URL{total !== 1 ? "s" : ""}
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search URLs..."
              value={search}
              onChange={handleSearchChange}
              className="w-64 pl-8"
              aria-label="Search tracked URLs"
            />
          </div>
        </div>

        {tableEmpty ? (
          <EmptyState
            icon={SearchX}
            title={debouncedSearch ? "No matching URLs" : "No tracked URLs"}
            description={
              debouncedSearch
                ? "Try adjusting your search."
                : "Add a URL above, or use the Track button on a Finding."
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <SortableTh label="ID" sortKey="id" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableTh label="URL" sortKey="url" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableTh label="Status" sortKey="status" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      <span className="uppercase tracking-wide">Current target</span>
                    </th>
                    <SortableTh label="Source" sortKey="source" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableTh label="Last checked" sortKey="last_checked_at" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      <span className="uppercase tracking-wide">Targets</span>
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-border">
                          <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-56" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-48" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-10" /></td>
                          <td className="px-4 py-3" />
                        </tr>
                      ))
                    : items.map((item) => (
                        <tr key={item.id} className="border-b border-border transition-colors hover:bg-muted/30">
                          <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{item.id}</td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-xs" title={item.url}>
                              {truncate(item.url, 52)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={STATUS_META[item.status].variant}>
                              {STATUS_META[item.status].label}
                              {item.http_status ? ` · ${item.http_status}` : ""}
                            </Badge>
                            {item.last_error && (
                              <span
                                className="block max-w-[200px] truncate text-[11px] text-muted-foreground"
                                title={item.last_error}
                              >
                                {item.last_error}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            <span className="max-w-[280px] block truncate" title={item.final_url ?? undefined}>
                              {item.final_url ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={SOURCE_META[item.source].variant}>
                              {SOURCE_META[item.source].label}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                            {formatWhen(item.last_checked_at)}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              onClick={() => openHistory(item)}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-info/40 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`View redirect history for ${item.url}`}
                            >
                              <History className="h-3 w-3" />
                              {item.history_count}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                onClick={() => handleCheckOne(item)}
                                disabled={busy || busyUrl !== null}
                                aria-label={`Check redirects for ${item.url}`}
                              >
                                {busyUrl === item.url ? (
                                  <RefreshCcw className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Zap className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteTarget(item)}
                                disabled={busy || busyUrl !== null}
                                aria-label={`Stop tracking ${item.url}`}
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
      </div>

      {/* History dialog */}
      <Dialog
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title="Redirect history"
        description={historyTarget ? historyTarget.url : undefined}
        className="max-w-xl"
      >
        {historyLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : history && history.edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No redirects observed yet — run “Check now” to follow this URL's chain.
          </p>
        ) : (
          <div className="space-y-2">
            {history?.edges.map((e, i) => (
              <div
                key={i}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2",
                  e.active ? "bg-warning/5" : "opacity-70",
                )}
              >
                <span className="font-mono text-xs" title={e.target_url}>
                  {truncate(e.target_url, 56)}
                </span>
                <Badge variant="secondary">HTTP {e.http_status}</Badge>
                {e.active ? (
                  <Badge variant="warning">Current</Badge>
                ) : (
                  <Badge variant="outline">Historical</Badge>
                )}
                <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
                  {formatWhen(e.first_seen_at)} → {formatWhen(e.last_seen_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Stop tracking this URL?"
        description={
          deleteTarget
            ? `${deleteTarget.url} will be removed from redirect monitoring. Its redirect history is kept.`
            : undefined
        }
        confirmLabel="Stop tracking"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
