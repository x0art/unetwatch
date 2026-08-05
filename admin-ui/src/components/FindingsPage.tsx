import { useCallback, useEffect, useState } from "react"
import { SearchX, Search, RefreshCcw } from "lucide-react"
import { type Finding, getFindings } from "../api"
import { Button, EmptyState, Input, Pagination, Skeleton } from "./ui"
import { useDebounce } from "../lib/utils"

const PAGE_SIZE = 25

function formatDetected(ts: string) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

export function FindingsPage() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search, 300)

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
          <Button variant="outline" size="sm" onClick={refetch}>
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
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b border-border">
                        <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-56" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
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
  )
}
