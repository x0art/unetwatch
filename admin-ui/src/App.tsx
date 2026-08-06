import { useState, useEffect, useRef, useCallback } from "react"
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
import { DashboardPage } from "./components/DashboardPage"
import { FindingsPage } from "./components/FindingsPage"
import { GraphPage } from "./components/GraphPage"
import { BlacklistPage } from "./components/BlacklistPage"
import { RedirectsPage } from "./components/RedirectsPage"
import { AppShell } from "./components/AppShell"
import { type View } from "./components/Sidebar"
import { Button, ToastProvider, useToast } from "./components/ui"
import { RotateCcw } from "lucide-react"

function AppRoutes() {
  const { toast } = useToast()
  const [view, setView] = useState<View>("dashboard")
  const [findingsSearch, setFindingsSearch] = useState("")
  const [loggedIn, setLoggedIn] = useState(!!getToken())
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [counts, setCounts] = useState<PatternCounts | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(Date.now())

  // Countdown timer
  const intervalSec = (status?.poll_interval_minutes ?? 10) * 60
  const [remaining, setRemaining] = useState(intervalSec)
  const lastRunRef = useRef(Date.now())

  const fetchStats = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([getMonitorStatus(), getPatternCounts()])
      setStatus(s)
      setCounts(c)
      setLastUpdated(Date.now())
    } catch (e) {
      console.error("Failed to fetch stats:", e)
    }
  }, [])

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
  }, [status, intervalSec, fetchStats])

  useEffect(() => {
    if (loggedIn) fetchStats()
  }, [loggedIn, fetchStats])

  const handleManualRun = async (minutes: number) => {
    setLoadingRun(true)
    try {
      await triggerManualRun(minutes)
      toast({ title: "Manual run completed successfully", variant: "success" })
      lastRunRef.current = Date.now()
      setRemaining(intervalSec)
      fetchStats()
    } catch (e) {
      toast({ title: "Run failed", description: (e as Error).message, variant: "error" })
    } finally {
      setLoadingRun(false)
    }
  }

  const handleLogout = () => {
    setToken(null)
    setLoggedIn(false)
  }

  // Navigation that can optionally pre-filter the Findings page
  // (used by the Graph view when a node is clicked). Any other navigation
  // resets the filter so a stale graph filter never leaks back in.
  const handleNavigate = useCallback((next: View, search?: string) => {
    setFindingsSearch(search ?? "")
    setView(next)
  }, [])

  if (!loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />
  }

  return (
    <AppShell
      currentView={view}
      onNavigate={handleNavigate}
      onLogout={handleLogout}
      title="ELK Monitoring"
      description="Pattern console"
      actions={
        <Button
          variant="outline"
          size="icon"
          onClick={fetchStats}
          aria-label="Refresh dashboard"
          className="h-9 w-9"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      }
    >
      {view === "dashboard" && (
        <DashboardPage
          remaining={remaining}
          intervalSec={intervalSec}
          status={status}
          counts={counts}
          loadingRun={loadingRun}
          lastUpdated={lastUpdated}
          onRefresh={fetchStats}
          onManualRun={handleManualRun}
          onNavigate={setView}
        />
      )}
      {view === "patterns" && <PatternTable />}
      {view === "findings" && <FindingsPage initialSearch={findingsSearch} />}
      {view === "graph" && <GraphPage onNavigate={handleNavigate} />}
      {view === "blacklist" && <BlacklistPage />}
      {view === "redirects" && <RedirectsPage />}
    </AppShell>
  )
}

function App() {
  return (
    <ToastProvider>
      <AppRoutes />
    </ToastProvider>
  )
}

export default App