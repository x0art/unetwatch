import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2,
  Copy,
  Globe,
  Link2,
  Search,
  SearchX,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { hostOfUrl } from "../lib/logRow"
import {
  addBaseUrlToBlacklist,
  bulkImport,
  getUrlBreakdown,
  type UrlBreakdown,
  type UrlClientCount,
} from "../api"
import {
  Button,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn } from "./DataTable"

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function formatCount(n: number): string {
  return n.toLocaleString()
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function UrlInvestigationPage({
  onNavigate,
}: {
  onNavigate?: (view: "host" | "patterns" | "analytics" | "dashboard" | "query" | "findings" | "blacklist" | "redirects" | "logs" | "url") => void
} = {}) {
  const { toast } = useToast()
  const { globalFilter, setGlobalFilter } = useFilter()
  const [url, setUrl] = useState("")
  const [searched, setSearched] = useState("")
  const [result, setResult] = useState<UrlBreakdown | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const investigate = useCallback(async (target: string) => {
    const trimmed = target.trim()
    if (!trimmed) {
      toast({ title: "Enter a URL", description: "Paste a full URL or host to investigate.", variant: "info" })
      return
    }
    setLoading(true)
    setError(null)
    setSearched(trimmed)
    try {
      const res = await getUrlBreakdown(trimmed, { limit: 100 })
      setResult(res)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Auto-investigate an incoming URL — Host Inspector's "Top URLs" navigates
  // here with the URL pushed into the global filter. Run once on mount.
  useEffect(() => {
    if (globalFilter) {
      setUrl(globalFilter)
      void investigate(globalFilter)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleViewHost = (ip: string) => {
    setGlobalFilter(ip)
    try {
      window.localStorage.setItem("unetwatch_view", "host")
    } catch {
      /* ignore */
    }
    onNavigate?.("host")
  }

  const handleWhitelist = async () => {
    if (!result) return
    const host = hostOfUrl(result.url)
    const pattern = host ? `*.${host}/*` : result.url
    try {
      await bulkImport({ patterns: [pattern], pattern_type: "whitelist" })
      toast({ title: "Whitelisted", description: `${pattern} added to whitelist — excluded from findings & risk.`, variant: "success" })
    } catch (e) {
      toast({ title: "Whitelist failed", description: (e as Error).message, variant: "error" })
    }
  }

  const handleBlacklist = async () => {
    if (!result) return
    const value = hostOfUrl(result.url) || result.url
    try {
      const res = await addBaseUrlToBlacklist(value)
      toast({
        title: res.added.length ? "Blacklisted" : "Already blacklisted",
        description: `${value} added to the block feed.`,
        variant: res.added.length ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    }
  }

  const handleCopy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.url)
      toast({ title: "URL copied", variant: "success" })
    } catch {
      toast({ title: "Copy failed", variant: "error" })
    }
  }

  const columns: DataTableColumn<UrlClientCount>[] = [
    {
      id: "client_ip",
      header: "Client IP",
      accessor: (r) => r.client_ip,
      cell: (r) => (
        <button
          type="button"
          onClick={() => handleViewHost(r.client_ip)}
          className="group inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-primary hover:underline"
          title="Open Host Inspector"
        >
          {r.client_ip}
        </button>
      ),
    },
    {
      id: "count",
      header: "Accesses",
      accessor: (r) => r.count,
      align: "right",
      cell: (r) => <span className="font-mono text-xs font-bold tabular-nums">{formatCount(r.count)}</span>,
      width: "w-24",
    },
    {
      id: "last_seen",
      header: "Last seen",
      accessor: (r) => r.last_seen,
      cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(r.last_seen)}</span>,
      width: "w-44",
    },
  ]

  const host = result ? hostOfUrl(result.url) : ""
  const totalClients = result?.clients?.length ?? 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="URL Investigation"
        description="Investigate who reached a URL — clients, risk status, and enforcement actions."
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void investigate(url)
          }}
        >
          <SearchInput
            placeholder="Paste a URL or host to investigate…"
            value={url}
            onChange={setUrl}
            className="w-72"
            aria-label="URL to investigate"
          />
          <Button type="submit" disabled={loading}>
            <Search className="h-4 w-4" />
            Investigate
          </Button>
        </form>
      </PageHeader>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {loading && !result ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : result ? (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={Globe}
              label="URL"
              value={<span className="block max-w-[220px] truncate" title={result.url}>{result.url}</span>}
              tone="info"
              hint={host}
            />
            <StatCard
              icon={Link2}
              label="Total accesses"
              value={formatCount(result.total_accesses)}
              tone="default"
              hint="Persisted findings"
            />
            <StatCard
              icon={Users}
              label="Unique clients"
              value={formatCount(totalClients)}
              tone="warning"
              hint="Distinct client IPs"
            />
            <StatCard
              icon={CheckCircle2}
              label="Source"
              value={result.source === "findings" ? "findings" : "ES"}
              tone="success"
              hint="Where the breakdown comes from"
            />
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleWhitelist}>
              <ShieldCheck className="h-4 w-4" />
              Whitelist host
            </Button>
            <Button variant="outline" onClick={handleBlacklist} className="text-destructive hover:text-destructive">
              <ShieldAlert className="h-4 w-4" />
              Blacklist host
            </Button>
            <Button variant="ghost" onClick={handleCopy}>
              <Copy className="h-4 w-4" />
              Copy URL
            </Button>
          </div>

          {/* Client table */}
          <Panel
            title={`Clients accessing ${searched}`}
            icon={Users}
            description="Each client IP links to Host Inspector"
          >
            {result.clients.length > 0 ? (
              <DataTable
                columns={columns}
                data={result.clients}
                rowId={(r) => r.client_ip}
                loading={false}
                defaultSortBy="count"
                defaultSortDir="desc"
                ariaLabel="Clients accessing this URL"
                empty={{
                  icon: SearchX,
                  title: "No clients found",
                  description: "This URL has no persisted accesses in the window.",
                }}
              />
            ) : (
              <EmptyState
                icon={SearchX}
                title="No clients found"
                description="No persisted accesses for this URL."
              />
            )}
          </Panel>

          {/* Risk note */}
          <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Risk (ADR 0001): a URL that matched a block pattern with ALLOW is a risk; whitelisted hosts are
              excluded from findings and risk counts. DENY rows are enforcements — the proxy already handled them.
            </p>
          </div>
        </>
      ) : null}

      {/* Initial empty state */}
      {!loading && !result && !error && (
        <EmptyState
          icon={Link2}
          title="Investigate a URL"
          description="Paste a URL or host above to see every client that reached it, with actions to whitelist or blacklist."
        />
      )}
    </div>
  )
}

export default UrlInvestigationPage
