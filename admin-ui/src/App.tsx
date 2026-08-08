import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react"
import {
  type MonitorStatus,
  type PatternCounts,
  getMonitorStatus,
  getPatternCounts,
  triggerManualRun,
  getToken,
  setToken,
} from "./api"
import { LoginPage } from "./components/LoginPage"
import { AppShell } from "./components/AppShell"
import { AddPatternDialog, AddPatternButton } from "./components/AddPatternDialog"
import { ThemeProvider, type View } from "./components/Sidebar"
import { ToastProvider, useToast, Skeleton } from "./components/ui"

const DashboardPage = lazy(() =>
  import("./components/DashboardPage").then((m) => ({ default: m.DashboardPage })),
)
const FindingsPage = lazy(() =>
  import("./components/FindingsPage").then((m) => ({ default: m.FindingsPage })),
)
const GraphPage = lazy(() =>
  import("./components/GraphPage").then((m) => ({ default: m.GraphPage })),
)
const BlacklistPage = lazy(() =>
  import("./components/BlacklistPage").then((m) => ({ default: m.BlacklistPage })),
)
const RedirectsPage = lazy(() =>
  import("./components/RedirectsPage").then((m) => ({ default: m.RedirectsPage })),
)
const QueryPage = lazy(() =>
  import("./components/QueryPage").then((m) => ({ default: m.QueryPage })),
)
const LogsPage = lazy(() =>
  import("./components/LogsPage").then((m) => ({ default: m.LogsPage })),
)
const PatternTable = lazy(() =>
  import("./components/PatternTable").then((m) => ({ default: m.PatternTable })),
)

function PageFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-10 w-64 rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
    </div>
  )
}

function AppRoutes() {
  const { toast } = useToast()
  const [view, setView] = useState<View>("dashboard")
  const [findingsSearch, setFindingsSearch] = useState("")
  const [loggedIn, setLoggedIn] = useState(!!getToken())
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [counts, setCounts] = useState<PatternCounts | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(Date.now())
  const [patternDialogOpen, setPatternDialogOpen] = useState(false)

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
      title="uNetWatch"
      description="Pattern console"
      actions={
        <>
          <AddPatternButton onOpen={() => setPatternDialogOpen(true)} />
          <AddPatternDialog
            open={patternDialogOpen}
            onClose={() => setPatternDialogOpen(false)}
          />
        </>
      }
    >
      <Suspense fallback={<PageFallback />}>
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
        {view === "query" && <QueryPage />}
        {view === "patterns" && <PatternTable />}
        {view === "findings" && <FindingsPage initialSearch={findingsSearch} />}
        {view === "graph" && <GraphPage />}
        {view === "blacklist" && <BlacklistPage />}
        {view === "redirects" && <RedirectsPage />}
        {view === "logs" && <LogsPage />}
      </Suspense>
    </AppShell>
  )
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppRoutes />
      </ToastProvider>
    </ThemeProvider>
  )
}

export default App