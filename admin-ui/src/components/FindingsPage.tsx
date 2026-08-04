import { useState, useEffect } from "react"
import { type Finding, getFindings } from "../api"

export function FindingsPage() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-5">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
        <div className="text-center">
          <h3 className="text-base font-semibold">No findings yet</h3>
          <p className="mt-1.5 max-w-xs text-sm text-muted-foreground leading-relaxed">
            Findings appear here when the ES poll detects log entries matching your
            block patterns.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Findings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {findings.length} finding{findings.length !== 1 ? "s" : ""} detected
          </p>
        </div>
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
              <tr
                key={f.id}
                className="border-b border-border transition-colors hover:bg-muted/30"
              >
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