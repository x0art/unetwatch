import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Ban,
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
  addBaseUrlToBlacklist,
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

/* ── Flow layout: depth-layered columns (Sources → Hop 1 → Hop 2 …) ── */

type FlowNode = RedirectGraph["nodes"][number] & {
  x: number
  y: number
  width: number
  height: number
}

const FLOW_NODE_W = 224
const FLOW_NODE_H = 44
const FLOW_COL_GAP = 110
const FLOW_ROW_GAP = 16
const FLOW_TOP_PAD = 58
const FLOW_SIDE_PAD = 28

const STATUS_NODE_STYLE: Record<
  TrackedUrl["status"],
  { rect: string; text: string }
> = {
  ok: { rect: "fill-success/15 stroke-success", text: "fill-success" },
  redirect: { rect: "fill-warning/15 stroke-warning", text: "fill-warning" },
  error: { rect: "fill-danger/15 stroke-danger", text: "fill-danger" },
  unknown: {
    rect: "fill-muted-foreground/10 stroke-muted-foreground/70",
    text: "fill-muted-foreground",
  },
}

// Longest-path layering: nodes with no incoming edge sit at depth 0; every
// other node lands one column past its deepest source. DAG edges therefore
// always flow strictly left → right. Unresolvable cycles are parked in a
// single fallback column instead of looping forever.
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

function buildFlowLayout(
  graph: RedirectGraph,
  showHistorical: boolean,
): {
  nodes: FlowNode[]
  links: RedirectLink[]
  width: number
  height: number
  columns: string[]
} | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const links = showHistorical ? graph.links : graph.links.filter((l) => l.active)

  const linkedIds = new Set<string>()
  for (const l of links) {
    linkedIds.add(l.source)
    linkedIds.add(l.target)
  }
  const nodeIds = new Set<string>([...linkedIds].filter((id) => byId.has(id)))
  if (nodeIds.size === 0) return null

  const depth = computeDepths(nodeIds, links)
  const byDepth = new Map<number, string[]>()
  for (const id of nodeIds) {
    const d = depth.get(id) ?? 0
    const list = byDepth.get(d) ?? []
    list.push(id)
    byDepth.set(d, list)
  }
  const cols = [...byDepth.keys()].sort((a, b) => a - b)
  const maxRows = Math.max(...[...byDepth.values()].map((l) => l.length))
  const width =
    FLOW_SIDE_PAD +
    cols.length * FLOW_NODE_W +
    (cols.length - 1) * FLOW_COL_GAP +
    FLOW_SIDE_PAD
  const height =
    FLOW_TOP_PAD + maxRows * FLOW_NODE_H + (maxRows - 1) * FLOW_ROW_GAP + FLOW_SIDE_PAD

  const nodes: FlowNode[] = []
  cols.forEach((d, ci) => {
    const ids = byDepth.get(d)!.sort((a, b) => a.localeCompare(b))
    ids.forEach((id, ri) => {
      nodes.push({
        ...byId.get(id)!,
        x: FLOW_SIDE_PAD + ci * (FLOW_NODE_W + FLOW_COL_GAP),
        y: FLOW_TOP_PAD + ri * (FLOW_NODE_H + FLOW_ROW_GAP),
        width: FLOW_NODE_W,
        height: FLOW_NODE_H,
      })
    })
  })

  const columns = cols.map((_, i) => (i === 0 ? "Sources" : `Hop ${i}`))
  return { nodes, links, width, height, columns }
}

function flowEdgePath(a: FlowNode, b: FlowNode) {
  const sx = a.x + a.width
  const sy = a.y + a.height / 2
  const tx = b.x
  const ty = b.y + b.height / 2
  const dx = Math.max(48, (tx - sx) / 2)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

function formatWhen(ts: string | null) {
  if (!ts) return "—"
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
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
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showHistorical, setShowHistorical] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [historyTarget, setHistoryTarget] = useState<TrackedUrl | null>(null)
  const [history, setHistory] = useState<UrlRedirectHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  const debouncedSearch = useDebounce(search, 300)

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
    setHovered(null) // a stale highlight must not survive a refetch
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

  /* ── Selection (bulk actions) ─────────────────────────────────────── */

  // Drop selections for rows no longer present after a refetch/page change.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(items.map((i) => i.id))
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  const allSelected = items.length > 0 && selectedIds.size === items.length
  const someSelected = selectedIds.size > 0 && !allSelected

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((i) => i.id)))
  }

  const toggleSelectOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedUrls = items.filter((i) => selectedIds.has(i.id)).map((i) => i.url)

  const handleBulkCheck = async () => {
    const urls = [...selectedUrls]
    if (!urls.length) return
    setBusy(true)
    try {
      const res = await checkRedirects(urls)
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

  const handleBulkBlacklist = async () => {
    const urls = [...selectedUrls]
    if (!urls.length) return
    setBusy(true)
    try {
      const results = await Promise.all(urls.map((u) => addBaseUrlToBlacklist(u)))
      const added = results.reduce((n, r) => n + r.added.length, 0)
      toast({
        title: added
          ? `${added} URL${added === 1 ? "" : "s"} added to blacklist`
          : "Already in blacklist",
        variant: added ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleBulkDelete = async () => {
    setConfirmBulkDelete(false)
    const ids = [...selectedIds]
    if (!ids.length) return
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => deleteTrackedUrl(id)))
      toast({
        title: `Removed ${ids.length} URL${ids.length === 1 ? "" : "s"} from tracking`,
        variant: "success",
      })
      setSelectedIds(new Set())
      if (ids.length >= items.length && page > 0) setPage(page - 1)
      else reload()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  /* ── Single-row actions ───────────────────────────────────────────── */

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
      const res = await checkRedirects([item.url])
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

  /* ── Flow visualization (depth-layered columns) ───────────────────── */

  const flow = useMemo(
    () => (graph ? buildFlowLayout(graph, showHistorical) : null),
    [graph, showHistorical],
  )
  const flowById = useMemo(
    () => new Map((flow?.nodes ?? []).map((n) => [n.id, n])),
    [flow],
  )

  // Tracked URLs with no edges at all (never redirected, never a target).
  const isolatedNodes = useMemo(() => {
    if (!graph) return []
    const linked = new Set<string>()
    for (const l of graph.links) {
      linked.add(l.source)
      linked.add(l.target)
    }
    return graph.nodes
      .filter((n) => !linked.has(n.id))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [graph])

  const flowNeighbours = useCallback(
    (id: string) => {
      const set = new Set<string>([id])
      for (const l of flow?.links ?? []) {
        if (l.source === id) set.add(l.target)
        if (l.target === id) set.add(l.source)
      }
      return set
    },
    [flow],
  )

  const flowNodeDimmed = (id: string) =>
    hovered !== null && !flowNeighbours(hovered).has(id)
  const flowEdgeDimmed = (l: RedirectLink) =>
    hovered !== null && l.source !== hovered && l.target !== hovered

  const focusTable = (url: string) => {
    setSearch(url)
    setPage(0)
    toast({ title: "Filtering table", description: url, variant: "info" })
  }

  /* ── Stats from the full node set ─────────────────────────────────── */

  const stats = useMemo(() => {
    const nodes = graph?.nodes ?? []
    return {
      total: nodes.length,
      redirecting: nodes.filter((n) => n.status === "redirect").length,
      ok: nodes.filter((n) => n.status === "ok").length,
      error: nodes.filter((n) => n.status === "error").length,
    }
  }, [graph])

  const graphEmpty = !graphLoading && (!graph || graph.nodes.length === 0)
  const tableEmpty = !loading && total === 0

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

      {/* Visualization: redirect flow */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Redirect flow</h3>
            <p className="text-xs text-muted-foreground">
              Chains flow left to right — sources on the left, each hop in its own column. Hover
              to highlight · click a URL to filter the table.
            </p>
          </div>
          {graph && !graphEmpty && (
            <button
              type="button"
              onClick={() => setShowHistorical((v) => !v)}
              aria-pressed={showHistorical}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-info/40 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <History className="h-3.5 w-3.5" aria-hidden="true" />
              Show historical edges
            </button>
          )}
        </div>

        {graphLoading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : graphEmpty ? (
          <EmptyState
            icon={GitBranch}
            title="No relations yet"
            description="Track a URL and run “Check now” — redirect chains will flow here, hop by hop."
            className="border-0"
          />
        ) : flow ? (
          <>
            <div className="overflow-x-auto">
              <div className="min-w-fit p-2">
                <svg
                  width={flow.width}
                  height={flow.height}
                  viewBox={`0 0 ${flow.width} ${flow.height}`}
                  role="img"
                  aria-label="Redirect chain flow graph"
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

                  {/* Column headers */}
                  {flow.columns.map((label, i) => (
                    <text
                      key={label}
                      x={FLOW_SIDE_PAD + i * (FLOW_NODE_W + FLOW_COL_GAP) + FLOW_NODE_W / 2}
                      y={FLOW_TOP_PAD - 26}
                      textAnchor="middle"
                      fontSize={10}
                      letterSpacing="0.14em"
                      className="fill-muted-foreground font-medium uppercase"
                    >
                      {label}
                    </text>
                  ))}

                  {/* Edges */}
                  {flow.links.map((l, i) => {
                    const src = flowById.get(l.source)
                    const dst = flowById.get(l.target)
                    if (!src || !dst) return null
                    const dimmed = flowEdgeDimmed(l)
                    return (
                      <path
                        key={i}
                        d={flowEdgePath(src, dst)}
                        fill="none"
                        className={cn(
                          "stroke-muted-foreground transition-opacity duration-150",
                          hovered !== null && !dimmed && "stroke-foreground/80",
                        )}
                        style={{
                          strokeDasharray: l.active ? undefined : "4 5",
                          opacity: dimmed ? 0.12 : l.active ? 0.7 : 0.45,
                          strokeWidth: l.active ? 1.6 : 1.3,
                        }}
                        markerEnd="url(#redirect-arrow)"
                      >
                        <title>{`${src.label} → ${dst.label} · HTTP ${l.http_status}${l.active ? "" : " (historical)"}`}</title>
                      </path>
                    )
                  })}

                  {/* Nodes */}
                  {flow.nodes.map((n) => (
                    <g
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${n.label} — ${STATUS_META[n.status].label}${
                        n.final_url && n.final_url !== n.label
                          ? `, redirects to ${n.final_url}`
                          : ""
                      }. Click to filter the table.`}
                      onClick={() => focusTable(n.label)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          focusTable(n.label)
                        }
                      }}
                      onMouseEnter={() => setHovered(n.id)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(n.id)}
                      onBlur={() => setHovered(null)}
                      className="cursor-pointer transition-opacity duration-150"
                      style={{ opacity: flowNodeDimmed(n.id) ? 0.15 : 1 }}
                    >
                      <rect
                        x={n.x}
                        y={n.y}
                        width={n.width}
                        height={n.height}
                        rx={9}
                        strokeWidth={hovered === n.id ? 2 : 1.2}
                        className={cn(
                          STATUS_NODE_STYLE[n.status].rect,
                          "transition-all duration-150",
                        )}
                      />
                      <text
                        x={n.x + n.width / 2}
                        y={n.y + n.height / 2 - 5}
                        textAnchor="middle"
                        fontSize={11}
                        className={cn(STATUS_NODE_STYLE[n.status].text, "font-mono")}
                      >
                        {truncate(n.label, 30)}
                      </text>
                      <text
                        x={n.x + n.width / 2}
                        y={n.y + n.height / 2 + 11}
                        textAnchor="middle"
                        fontSize={9.5}
                        className="fill-muted-foreground"
                      >
                        {STATUS_META[n.status].label}
                        {n.final_url && n.final_url !== n.label
                          ? ` → ${truncate(n.final_url, 18)}`
                          : ""}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            </div>

            {/* Tracked URLs with no relations at all */}
            {isolatedNodes.length > 0 && (
              <div className="border-t border-border px-4 py-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Not redirecting · {isolatedNodes.length}
                </p>
                <div className="flex flex-wrap gap-2">
                  {isolatedNodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => focusTable(n.label)}
                      title={n.label}
                      aria-label={`Filter table by ${n.label}`}
                      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-xs transition-colors hover:border-info/40 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate">{truncate(n.label, 42)}</span>
                      <Badge variant={STATUS_META[n.status].variant} className="shrink-0">
                        {STATUS_META[n.status].label}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : isolatedNodes.length > 0 ? (
          <div className="border-t border-border px-4 py-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Not redirecting · {isolatedNodes.length}
            </p>
            <div className="flex flex-wrap gap-2">
              {isolatedNodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => focusTable(n.label)}
                  title={n.label}
                  aria-label={`Filter table by ${n.label}`}
                  className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-xs transition-colors hover:border-info/40 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">{truncate(n.label, 42)}</span>
                  <Badge variant={STATUS_META[n.status].variant} className="shrink-0">
                    {STATUS_META[n.status].label}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={GitBranch}
            title="No relations yet"
            description="Tracked URLs aren’t redirecting anywhere yet. Run “Check now” to follow their chains."
            className="border-0"
          />
        )}
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

        {selectedIds.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <span className="font-medium">{selectedIds.size} selected</span>
            <Button size="sm" variant="outline" onClick={handleBulkCheck} disabled={busy}>
              <Zap className="h-3.5 w-3.5" />
              Check
            </Button>
            <Button size="sm" variant="outline" onClick={handleBulkBlacklist} disabled={busy}>
              <Ban className="h-3.5 w-3.5" />
              Add to blacklist
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmBulkDelete(true)}
              disabled={busy}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        )}

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
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      <label className="inline-flex items-center gap-2 uppercase tracking-wide">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected
                          }}
                          onChange={toggleSelectAll}
                          disabled={busy || items.length === 0}
                          aria-label="Select all tracked URLs"
                          className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        />
                        <span className="sr-only">Select</span>
                      </label>
                    </th>
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
                          <td className="px-4 py-3"><Skeleton className="h-4 w-4" /></td>
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
                        <tr
                          key={item.id}
                          className={cn(
                            "border-b border-border transition-colors hover:bg-muted/30",
                            selectedIds.has(item.id) && "bg-muted/40",
                          )}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleSelectOne(item.id)}
                              disabled={busy}
                              aria-label={`Select ${item.url}`}
                              className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            />
                          </td>
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
                            <span className="block max-w-[280px] truncate" title={item.final_url ?? undefined}>
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

      {/* Single delete confirm */}
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

      {/* Bulk delete confirm */}
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Stop tracking selected URLs?"
        description={`${selectedIds.size} selected URL${
          selectedIds.size !== 1 ? "s" : ""
        } will be removed from redirect monitoring. Their redirect history is kept.`}
        confirmLabel="Stop tracking"
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </div>
  )
}
