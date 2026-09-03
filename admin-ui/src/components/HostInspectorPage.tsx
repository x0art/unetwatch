import { useEffect, useState } from "react"
import { Search, Download } from "lucide-react"
import { useFilter } from "../contexts/FilterContext"
import { Button, Input, Select, PageHeader, Skeleton, useToast } from "./ui"
import { HostEntityCard } from "./HostEntityCard"
import { getHostProfile, type HostProfile } from "../api"

const TIME_RANGE_OPTIONS = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
]

export function HostInspectorPage() {
  const { globalFilter } = useFilter()
  const { toast } = useToast()

  const [target, setTarget] = useState(() => globalFilter || "")
  const [timeRange, setTimeRange] = useState("24h")
  const [host, setHost] = useState<HostProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  // Pre-fill from FilterContext (?q=) so InspectionDrawer "View Host History" lands filled.
  useEffect(() => {
    if (globalFilter && !target) {
      setTarget(globalFilter)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter])

  const lookup = async (ip: string) => {
    const clean = ip.trim()
    if (!clean) {
      toast({ title: "Enter a host or IP", variant: "info" })
      return
    }
    setLoading(true)
    setError(null)
    setHasSearched(true)
    try {
      const profile = await getHostProfile(clean, timeRange)
      setHost(profile)
    } catch (e) {
      const msg = (e as Error).message || "Lookup failed"
      setError(msg)
      setHost(null)
      toast({ title: "Lookup failed", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const handleExport = () => {
    if (!host) {
      toast({ title: "No host selected", description: "Run a lookup first.", variant: "info" })
      return
    }
    // Interim: export as JSON download until backend report lands.
    try {
      const blob = new Blob([JSON.stringify(host, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `host-${host.primaryIp}-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: "Report exported", variant: "success" })
    } catch {
      toast({ title: "Export failed", variant: "error" })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") lookup(target)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Host Investigation"
        description="Single-entity forensic investigation"
      >
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export Report
        </Button>
      </PageHeader>

      <div className="flex gap-2">
        <Input
          placeholder="Host / IP Search: 192.168.1.45"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 font-mono text-[13px]"
          aria-label="Host or IP search"
        />
        <Button onClick={() => lookup(target)} disabled={loading}>
          <Search className="h-4 w-4" aria-hidden="true" />
          {loading ? "Looking up…" : "Lookup"}
        </Button>
        <Select
          value={timeRange}
          onChange={setTimeRange}
          options={TIME_RANGE_OPTIONS}
          className="w-36 shrink-0"
          aria-label="Time range"
        />
      </div>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {!loading && !error && host && (
        <HostEntityCard host={host} risk={host.risk} />
      )}

      {!loading && !error && !host && hasSearched && (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">No host found</p>
          <p className="mt-2 text-sm text-muted-foreground">No data for “{target}” in the selected window.</p>
        </div>
      )}

      {!loading && !error && !host && !hasSearched && (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">Host Investigation</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter a host or IP (e.g. 192.168.1.45) and run Lookup. Try the wireframe demo IP <span className="font-mono font-semibold text-foreground">192.168.1.45</span> to see the spec card.
          </p>
        </div>
      )}
    </div>
  )
}
