import { useCallback, useEffect, useState } from "react"
import { SearchX } from "lucide-react"
import { type Finding, getFindings } from "../api"
import { Button, EmptyState } from "./ui"

export function FindingsPage() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(() => {
    let cancelled = false
    setLoading(true)
    getFindings()
      .then((data) => {
        if (!cancelled) setFindings(data)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cancel = refetch()
    return cancel
  }, [refetch])

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" aria-busy="true">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
          <p className="text-sm text-muted-foreground">Loading findings...</p>
        </div>
      </div>
    )
  }

  if (findings.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No findings yet"
        description="Findings appear here when the ES poll detects matching log entries."
        action={<Button variant="outline" onClick={refetch}>Refresh</Button>}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Findings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {findings.length} finding{findings.length !== 1 ? "s" : ""} detected
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">ID</th>
              <th className="px-4 py-3 text-left font-medium">Pattern</th>
              <th className="px-4 py-3 text-left font-medium">Client IP</th>
              <th className="px-4 py-3 text-left font-medium">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f.id} className="border-b border-border transition-colors hover:bg-muted/30">
                <td className="px-4 py-3 text-muted-foreground">{f.id}</td>
                <td className="px-4 py-3 font-mono text-sm">{f.pattern}</td>
                <td className="px-4 py-3 font-mono text-sm text-muted-foreground">{f.client_ip}</td>
                <td className="px-4 py-3 text-muted-foreground">{f.timestamp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
