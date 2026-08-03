import { useState, useEffect, useRef } from "react"
import {
  type MonitorStatus,
  type PatternCounts,
  getMonitorStatus,
  getPatternCounts,
  triggerManualRun,
  getToken,
  setToken,
} from "./api"
import { PatternTable } from "./components/PatternTable"
import { LoginPage } from "./components/LoginPage"
import { Button, Card, CardContent, CardHeader, CardTitle } from "./components/ui"

function App() {
  const [loggedIn, setLoggedIn] = useState(!!getToken())
  const [tab, setTab] = useState<"patterns" | "dashboard">("dashboard")
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [counts, setCounts] = useState<PatternCounts | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Countdown timer
  const intervalSec = (status?.poll_interval_minutes ?? 10) * 60
  const [remaining, setRemaining] = useState(intervalSec)
  const lastRunRef = useRef(Date.now())

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const fetchStats = async () => {
    try {
      const [s, c] = await Promise.all([getMonitorStatus(), getPatternCounts()])
      setStatus(s)
      setCounts(c)
    } catch (e) {
      console.error("Failed to fetch stats:", e)
    }
  }

  // Countdown ticker
  useEffect(() => {
    if (!status) return
    const elapsed = Math.floor((Date.now() - lastRunRef.current) / 1000)
    setRemaining(Math.max(0, intervalSec - elapsed))

    const tick = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          lastRunRef.current = Date.now()
          fetchStats()
          return intervalSec
        }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [status, intervalSec])

  useEffect(() => {
    if (loggedIn) {
      fetchStats()
    }
  }, [loggedIn])

  const handleManualRun = async () => {
    setLoadingRun(true)
    try {
      await triggerManualRun()
      showToast("Manual run completed successfully")
      lastRunRef.current = Date.now()
      setRemaining(intervalSec)
      fetchStats()
    } catch (e) {
      showToast(`Run failed: ${(e as Error).message}`)
    } finally {
      setLoadingRun(false)
    }
  }

  const handleLogout = () => {
    setToken(null)
    setLoggedIn(false)
  }

  const formatCountdown = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, "0")}`
  }

  const countdownPct = status ? (remaining / intervalSec) * 100 : 0

  if (!loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />
  }

  return (
    <div className="min-h-screen bg-background">
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md bg-primary text-primary-foreground px-4 py-3 text-sm shadow-lg animate-in slide-in-from-bottom-2 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {toast}
        </div>
      )}

      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold tracking-tight">ELK Monitoring</h1>
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
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-green-400" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Live
            </span>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {tab === "dashboard" && (
          <div className="space-y-6">
            {/* Countdown + Stats grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Next Poll</CardTitle>
                  <span className="text-2xl">⏱️</span>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold tabular-nums">
                    {formatCountdown(remaining)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    until next ES query
                  </p>
                  {/* Progress bar */}
                  <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-1000 ease-linear"
                      style={{ width: `${countdownPct}%` }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Block Patterns</CardTitle>
                  <span className="text-2xl">🚫</span>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{counts?.block ?? "—"}</div>
                  <p className="text-xs text-muted-foreground">URL patterns to flag</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Whitelist Patterns</CardTitle>
                  <span className="text-2xl">✅</span>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">{counts?.whitelist ?? "—"}</div>
                  <p className="text-xs text-muted-foreground">URL patterns to allow</p>
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
                    {loadingRun ? "Running…" : "Trigger Now"}
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Config */}
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
                    <dd className="font-medium">{status?.poll_interval_minutes ?? "?"} min</dd>
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