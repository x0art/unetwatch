import { useState, useEffect } from "react"
import { type MonitorStatus, type PatternCounts, getMonitorStatus, getPatternCounts, triggerManualRun } from "./api"
import { PatternTable } from "./components/PatternTable"
import { Button, Card, CardContent, CardHeader, CardTitle } from "./components/ui"

function App() {
  const [tab, setTab] = useState<"patterns" | "dashboard">("dashboard")
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [counts, setCounts] = useState<PatternCounts | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)

  const fetchStats = async () => {
    try {
      const [s, c] = await Promise.all([getMonitorStatus(), getPatternCounts()])
      setStatus(s)
      setCounts(c)
    } catch (e) {
      console.error("Failed to fetch stats:", e)
    }
  }

  useEffect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleManualRun = async () => {
    setLoadingRun(true)
    try {
      await triggerManualRun()
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingRun(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold tracking-tight">🔍 ELK Monitoring</h1>
            <nav className="flex gap-1">
              <Button
                variant={tab === "dashboard" ? "default" : "ghost"}
                size="sm"
                onClick={() => setTab("dashboard")}
              >
                Dashboard
              </Button>
              <Button
                variant={tab === "patterns" ? "default" : "ghost"}
                size="sm"
                onClick={() => setTab("patterns")}
              >
                Patterns
              </Button>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 text-sm ${status ? "text-green-600" : "text-muted-foreground"}`}>
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status ? "bg-green-400" : "bg-gray-400"}`} />
                <span className={`relative inline-flex rounded-full h-2 w-2 ${status ? "bg-green-500" : "bg-gray-400"}`} />
              </span>
              {status ? "Active" : "Loading..."}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {tab === "dashboard" && (
          <div className="space-y-6">
            {/* Stats grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Block Patterns</CardTitle>
                  <span className="text-2xl">🚫</span>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{counts?.block ?? "-"}</div>
                  <p className="text-xs text-muted-foreground">URL patterns to block</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Whitelist Patterns</CardTitle>
                  <span className="text-2xl">✅</span>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{counts?.whitelist ?? "-"}</div>
                  <p className="text-xs text-muted-foreground">URL patterns to allow</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Poll Interval</CardTitle>
                  <span className="text-2xl">⏱️</span>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{status?.poll_interval_minutes ?? "-"}m</div>
                  <p className="text-xs text-muted-foreground">Between ES queries</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Manual Run</CardTitle>
                  <span className="text-2xl">▶️</span>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={handleManualRun}
                    disabled={loadingRun}
                    className="w-full"
                  >
                    {loadingRun ? "Running..." : "Trigger Now"}
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Config info */}
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="font-medium">{status?.status ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Poll Interval</dt>
                    <dd className="font-medium">{status?.poll_interval_minutes ?? "?"} minutes</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Block Patterns</dt>
                    <dd className="font-medium">{status?.block_patterns ?? "?"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Whitelist Patterns</dt>
                    <dd className="font-medium">{status?.whitelist_patterns ?? "?"}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "patterns" && <PatternTable />}
      </main>
    </div>
  )
}

export default App