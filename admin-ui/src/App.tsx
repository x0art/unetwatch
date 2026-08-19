import { useState, useEffect, useCallback, lazy, Suspense } from "react"
import { AnimatePresence } from "framer-motion"
import {
  type MonitorStatus,
  type PatternCounts,
  getMonitorStatus,
  getPatternCounts,
  triggerManualRun,
  getToken,
  setToken,
  onSessionExpired,
} from "./api"
import { LoginPage } from "./components/LoginPage"
import { AppShell } from "./components/AppShell"
import { AddPatternDialog, AddPatternButton } from "./components/AddPatternDialog"
import { ThemeProvider, type View } from "./components/Sidebar"
import { ToastProvider, useToast, Skeleton } from "./components/ui"
import { MotionGate, MotionPage } from "./components/motion"
import { usePageVisible } from "./lib/utils"

const BlockDomainPage = lazy(() =>
  import("./components/BlockDomainPage").then((m) => ({ default: m.BlockDomainPage })),
)

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

function isBlockDomainPath() {
  return window.location.pathname === "/blockDomain"
}

function AppRoutes() {
  const { toast } = useToast()
  const pageVisible = usePageVisible()
  const [blockDomainPath] = useState(isBlockDomainPath)
  const VIEW_KEY = "unetwatch_view"
  const storedView = localStorage.getItem(VIEW_KEY) as View | null
  const [view, setView] = useState<View>(
    storedView && ["dashboard", "query", "patterns", "findings", "graph", "blacklist", "redirects", "logs"].includes(storedView)
      ? storedView
      : "dashboard",
  )
  const [findingsSearch, setFindingsSearch] = useState("")
  const [loggedIn, setLoggedIn] = useState(!!getToken())
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [counts, setCounts] = useState<PatternCounts | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(Date.now())
  const [patternDialogOpen, setPatternDialogOpen] = useState(false)

  // Countdown timer — computed from the backend's last_poll_at timestamp
  const intervalSec = (status?.poll_interval_minutes ?? 10) * 60
  const [remaining, setRemaining] = useState(intervalSec)

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

  // Countdown ticker — derived from the real last_poll_at timestamp
  useEffect(() => {
    if (!status) return

    const calcRemaining = () => {
      if (status.last_poll_at) {
        const lastPoll = new Date(status.last_poll_at).getTime()
        const elapsed = Math.floor((Date.now() - lastPoll) / 1000)
        const left = intervalSec - elapsed
        // If the poll is overdue, show the full interval — the scheduler
        // will fire any moment and a fresh cycle begins.
        return left > 0 ? left : intervalSec
      }
      // No poll recorded yet — show the full interval
      return intervalSec
    }

    setRemaining(calcRemaining())
    const tick = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          // Countdown reached zero — refresh stats from backend to get the
          // real new last_poll_at, then reset to the full interval.
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
      // Refresh stats to pick up the new last_poll_at from the backend
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

  // Persist current view to localStorage so page refreshes land on the same tab.
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])

  // When the API receives a 401, flip to the login page instead of a hard reload.
  useEffect(() => {
    onSessionExpired(() => setLoggedIn(false))
  }, [])

  // Pause infinite CSS animations (ping dots, pulse, edge-flow) while the
  // tab is hidden — honored by the `html[data-paused]` rule in index.css.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-paused", !pageVisible)
  }, [pageVisible])

  // Navigation that can optionally pre-filter the Findings page
  // (used by the Graph view when a node is clicked). Any other navigation
  // resets the filter so a stale graph filter never leaks back in.
  const handleNavigate = useCallback((next: View, search?: string) => {
    setFindingsSearch(search ?? "")
    setView(next)
  }, [])

  if (!loggedIn) {
    // For the /blockDomain path, store the full URL so after login we
    // redirect back to the same page with all query parameters intact.
    const handleLogin = () => {
      setLoggedIn(true)
      if (blockDomainPath) {
        // Force a re-render so the logged-in branch picks up the path
        window.location.reload()
      }
    }
    return (
      <LoginPage
        onLogin={handleLogin}
      />
    )
  }

  // Standalone /blockDomain page — rendered outside the normal AppShell
  if (blockDomainPath) {
    return (
      <Suspense fallback={<div className="flex min-h-dvh items-center justify-center bg-background"><Skeleton className="h-10 w-48" /></div>}>
        <BlockDomainPage />
      </Suspense>
    )
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
        <AnimatePresence mode="wait">
          <MotionPage key={view}>
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
                onNavigate={handleNavigate}
              />
            )}
            {view === "query" && <QueryPage />}
            {view === "patterns" && <PatternTable />}
            {view === "findings" && <FindingsPage initialSearch={findingsSearch} />}
            {view === "graph" && <GraphPage />}
            {view === "blacklist" && <BlacklistPage />}
            {view === "redirects" && <RedirectsPage />}
            {view === "logs" && <LogsPage />}
          </MotionPage>
        </AnimatePresence>
      </Suspense>
    </AppShell>
  )
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <MotionGate>
          <AppRoutes />
        </MotionGate>
      </ToastProvider>
    </ThemeProvider>
  )
}

export default App