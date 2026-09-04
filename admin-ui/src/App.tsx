import { useState, useEffect, useCallback, lazy, Suspense } from "react"
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
import { FilterProvider } from "./contexts/FilterContext"
import { ToastProvider, useToast, Skeleton } from "./components/ui"
import { MotionGate } from "./components/motion"
import { GlobalSearchPalette } from "./components/GlobalSearchPalette"
import { usePageVisible } from "./lib/utils"

const BlockDomainPage = lazy(() =>
  import("./components/BlockDomainPage").then((m) => ({ default: m.BlockDomainPage })),
)
const WhitelistDomainPage = lazy(() =>
  import("./components/WhitelistDomainPage").then((m) => ({ default: m.WhitelistDomainPage })),
)

const DashboardPage = lazy(() =>
  import("./components/DashboardPage").then((m) => ({ default: m.DashboardPage })),
)
const FindingsPage = lazy(() =>
  import("./components/FindingsPage").then((m) => ({ default: m.FindingsPage })),
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
const HostInspectorPage = lazy(() =>
  import("./components/HostInspectorPage").then((m) => ({ default: m.HostInspectorPage })),
)
const UrlInvestigationPage = lazy(() =>
  import("./components/UrlInvestigationPage").then((m) => ({ default: m.UrlInvestigationPage })),
)
const AnalyticsPage = lazy(() =>
  import("./components/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })),
)

function PageFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  )
}

function isStandalonePath() {
  const p = window.location.pathname
  return p === "/blockDomain" || p === "/whitelistDomain"
}

function AppRoutes() {
  const { toast } = useToast()
  const pageVisible = usePageVisible()
  const [standalonePath] = useState(isStandalonePath)
  const VIEW_KEY = "unetwatch_view"
  const storedView = localStorage.getItem(VIEW_KEY) as View | null
  const [view, setView] = useState<View>(
    storedView && ["dashboard", "query", "patterns", "findings", "blacklist", "redirects", "logs", "host", "url", "analytics"].includes(storedView)
      ? storedView
      : "dashboard",
  )
  const [findingsSearch, setFindingsSearch] = useState("")
  const [patternSearch, setPatternSearch] = useState("")
  const [logsSearch, setLogsSearch] = useState("")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [visited, setVisited] = useState<Set<string>>(() => new Set([storedView ?? "dashboard"]))
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

  // Ctrl/Cmd+K opens the global search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // When the API receives a 401, flip to the login page instead of a hard reload.
  useEffect(() => {
    onSessionExpired(() => setLoggedIn(false))
  }, [])

  // Pause infinite CSS animations (ping dots, pulse, edge-flow) while the
  // tab is hidden — honored by the `html[data-paused]` rule in index.css.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-paused", !pageVisible)
  }, [pageVisible])

  // Navigation — keeps pages mounted so their content persists across switches
  // (no reset on every tab change). The Ctrl+K palette applies its search via
  // the dedicated external-search state AFTER navigation.
  const handleNavigate = useCallback((next: View, _search?: string) => {
    setView(next)
    setVisited((prev) => new Set(prev).add(next))
  }, [])

  if (!loggedIn) {
    // For standalone paths (/blockDomain, /whitelistDomain), reload after
    // login so the authenticated branch picks up the correct page.
    const handleLogin = () => {
      setLoggedIn(true)
      if (standalonePath) {
        window.location.reload()
      }
    }
    return (
      <LoginPage
        onLogin={handleLogin}
      />
    )
  }

  // Standalone pages rendered outside the normal AppShell
  if (standalonePath) {
    const p = window.location.pathname
    return (
      <Suspense fallback={<div className="flex min-h-dvh items-center justify-center bg-background"><Skeleton className="h-10 w-48" /></div>}>
        {p === "/blockDomain" ? <BlockDomainPage /> : <WhitelistDomainPage />}
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
        {/* Keep visited pages mounted so switching tabs never resets their
            state — each renders in a hidden wrapper when inactive. */}
        {visited.has("dashboard") && (
          <div hidden={view !== "dashboard"}>
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
          </div>
        )}
        {visited.has("query") && (
          <div hidden={view !== "query"}>
            <QueryPage onNavigate={handleNavigate} />
          </div>
        )}
        {visited.has("patterns") && (
          <div hidden={view !== "patterns"}>
            <PatternTable externalSearch={patternSearch} />
          </div>
        )}
        {visited.has("findings") && (
          <div hidden={view !== "findings"}>
            <FindingsPage initialSearch={findingsSearch} onNavigate={handleNavigate} />
          </div>
        )}
        {visited.has("blacklist") && (
          <div hidden={view !== "blacklist"}>
            <BlacklistPage />
          </div>
        )}
        {visited.has("redirects") && (
          <div hidden={view !== "redirects"}>
            <RedirectsPage />
          </div>
        )}
        {visited.has("logs") && (
          <div hidden={view !== "logs"}>
            <LogsPage externalSearch={logsSearch} />
          </div>
        )}
        {visited.has("host") && (
          <div hidden={view !== "host"}>
            <HostInspectorPage onNavigate={handleNavigate} />
          </div>
        )}
        {visited.has("url") && (
          <div hidden={view !== "url"}>
            <UrlInvestigationPage onNavigate={handleNavigate} />
          </div>
        )}
        {visited.has("analytics") && (
          <div hidden={view !== "analytics"}>
            <AnalyticsPage onNavigate={handleNavigate} />
          </div>
        )}
      </Suspense>

      <GlobalSearchPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={handleNavigate}
        onFindingsSearch={setFindingsSearch}
        onPatternSearch={setPatternSearch}
        onLogsSearch={setLogsSearch}
      />
    </AppShell>
  )
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <MotionGate>
          <FilterProvider>
            <AppRoutes />
          </FilterProvider>
        </MotionGate>
      </ToastProvider>
    </ThemeProvider>
  )
}

export default App