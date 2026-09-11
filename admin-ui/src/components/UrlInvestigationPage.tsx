import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2,
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
  LoadingIcon,
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

/** True when a search string looks like a URL rather than a bare host/IP —
 * used so the URL page only reacts to URL filters (not host/IP ones). A bare
 * dotted host (e.g. ``evil.example``) counts as a URL so quick-nav from a
 * base_url column auto-investigates it; a bare IPv4 (``192.168.1.45``) does not
 * (that stays a Host Inspector filter). */
function looksLikeUrl(s: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ||
    s.includes("/") ||
    s.includes("?") ||
    s.startsWith("www.") ||
    /[a-z0-9-]*[a-z][a-z0-9-]*\.[a-z0-9-]+/i.test(s)
  )
}

/* ── Page ───────────────────────────────────────────────────────────── */

type UrlSource = "live" | "findings"

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
  const [uSource, setUSource] = useState<UrlSource>("findings")
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
      const res = await getUrlBreakdown(trimmed, { limit: 100, source: uSource })
      setResult(res)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [toast, uSource])

  // Auto-investigate an incoming URL — Host Inspector's "Top URLs" and the
  // Ctrl+K palette navigate here with the URL in the global filter. Re-runs on
  // every globalFilter change (the page stays mounted across tabs now), but
  // only when the filter is URL-like (not a bare host/IP filter).
  useEffect(() => {
    if (globalFilter && looksLikeUrl(globalFilter)) {
      setUrl(globalFilter)
      void investigate(globalFilter)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter])

  useEffect(() => {
    if (searched && !loading) void investigate(searched)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uSource])

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
    // Whitelist targets the investigated URL (path-scoped), not just its host:
    // exclude this exact URL prefix from findings & risk, leaving the rest of
    // the host untouched.
    const u = result.url
    if (!u || !u.trim()) { toast({ title: "No URL", variant: "error" }); return }
    const clean = u.split("?")[0].split("#")[0].replace(/\/$/, "")
    // Ensure the wildcard has a path boundary so a bare-host URL like
    // "https://example.com" does not become "https://example.com*" matching
    // "https://example.com.evil.com".
    const hasPath = /^https?:\/\/[^/]+\//.test(clean)
    const pattern = hasPath ? `${clean}*` : `${clean}/*`
    try {
      await bulkImport({ patterns: [pattern], pattern_type: "whitelist" })
      toast({ title: "URL whitelisted", description: `${pattern} excluded from findings & risk.`, variant: "success" })
    } catch (e) {
      toast({ title: "Whitelist failed", description: (e as Error).message, variant: "error" })
    }
  }

  const handleBlacklist = async () => {
    if (!result) return
    // Blacklist the investigated URL as a whole. The backend feed stores the
    // bare host/FQDN (protocol + path stripped) so every access to the domain
    // is blocked at the device firewall.
    try {
      const res = await addBaseUrlToBlacklist(result.url)
      const host = hostOfUrl(result.url)
      toast({
        title: res.added.length ? "URL blacklisted" : "Already blacklisted",
        description: `${host} added to the block feed (all paths).`,
        variant: res.added.length ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
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
          className="group inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
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
        description="Investigate who reached a URL - clients, risk status, and enforcement actions."
      />

      {/* Standardized search toolbar - matches Host Investigation's card form. */}
      <form
        className="rounded-md border border-border bg-card p-4 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault()
          void investigate(url)
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            placeholder="Paste a URL or host to investigate..."
            value={url}
            onChange={setUrl}
            className="flex-1 min-w-[240px]"
            aria-label="URL to investigate"
          />
          <Button type="submit" disabled={loading}>
            {loading ? <LoadingIcon /> : <Search className="h-4 w-4" />}
            {loading ? "Investigating..." : "Investigate"}
          </Button>
          <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Data source">
            <button type="button" onClick={() => setUSource("findings")} aria-pressed={uSource === "findings"} className={`rounded-sm px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${uSource === "findings" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>Findings</button>
            <button type="button" onClick={() => setUSource("live")} aria-pressed={uSource === "live"} className={`rounded-sm px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${uSource === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>Live</button>
          </div>
        </div>
        {uSource === "findings" && (
          <p className="mt-2 text-xs text-muted-foreground">Findings covers pattern-matched traffic only — switch to Live for the full stream.</p>
        )}
      </form>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger flex items-center justify-between gap-3">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void investigate(searched || url)}>Retry</Button>
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
              value={<span className="block max-w-[220px] truncate font-mono" title={result.url}>{result.url}</span>}
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

          {/* Actions — target the investigated URL, not just its host. */}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleWhitelist}>
              <ShieldCheck className="h-4 w-4" />
              Whitelist URL
            </Button>
            <Button variant="outline" onClick={handleBlacklist} className="text-destructive hover:text-destructive">
              <ShieldAlert className="h-4 w-4" />
              Blacklist URL
            </Button>
          </div>

          {/* Client table */}
          <Panel
            title={`Clients accessing ${searched}`}
            icon={Users}
            description="Each client IP links to Host Inspector"
          >
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
                action: <Button variant="outline" size="sm" onClick={() => void investigate(url)}>Search again</Button>,
              }}
            />
          </Panel>

        </>
      ) : null}

      {/* Initial empty state */}
      {!loading && !result && !error && (
        <EmptyState
          icon={Link2}
          title="Investigate a URL"
          description="Paste a URL or host above to see every client that reached it, with actions to whitelist or blacklist."
          action={<Button variant="outline" size="sm" onClick={() => void investigate("https://example.com")}>Try example.com</Button>}
        />
      )}
    </div>
  )
}

export default UrlInvestigationPage
