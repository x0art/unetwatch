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

type View = "dashboard" | "patterns" | "findings"

const THEME_KEY = "elk-theme"

function getStoredTheme(): "dark" | "light" {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === "light" || stored === "dark") return stored
  return "dark"
}

function applyTheme(theme: "dark" | "light") {
  document.documentElement.classList.toggle("dark", theme === "dark")
}

function App() {
  const [view, setView] = useState<View>("dashboard")
  const [loggedIn, setLoggedIn] = useState(!!getToken())
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [counts, setCounts] = useState<PatternCounts | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState(Date.now())
  const [theme, setTheme] = useState<"dark" | "light">(getStoredTheme)

  // Countdown timer
  const intervalSec = (status?.poll_interval_minutes ?? 10) * 60
  const [remaining, setRemaining] = useState(intervalSec)
  const lastRunRef = useRef(Date.now())

  // Theme
  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"))
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

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

  if (!loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md bg-primary px-4 py-3 text-sm text-primary-foreground shadow-lg animate-in slide-in-from-bottom-2">
          <svg
            className="h-4 w-4 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {toast}
        </div>
      )}

      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-card sm:flex">
        {/* Logo */}
        <div className="flex h-14 items-center gap-3 border-b border-border px-5">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-primary"
            aria-hidden="true"
          >
            <path d="M21.75 17.25A8.954 8.954 0 0 1 17.25 21M21.75 6.75v11.25" />
            <path d="M12 3a9 9 0 1 0 9 9" />
          </svg>
          <span className="text-base font-semibold tracking-tight">ELK Monitor</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 p-3" role="navigation" aria-label="Main navigation">
          {[
            { id: "dashboard" as View, label: "Dashboard", icon: "layout-dashboard" },
            { id: "patterns" as View, label: "Patterns", icon: "list-filter" },
            { id: "findings" as View, label: "Findings", icon: "search" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                view === item.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
              aria-current={view === item.id ? "page" : undefined}
            >
              {item.icon === "layout-dashboard" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect width="7" height="9" x="3" y="3" rx="1" />
                  <rect width="7" height="5" x="14" y="3" rx="1" />
                  <rect width="7" height="9" x="14" y="12" rx="1" />
                  <rect width="7" height="5" x="3" y="16" rx="1" />
                </svg>
              )}
              {item.icon === "list-filter" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11 18H3" />
                  <path d="m15 18 2 2 4-4" />
                  <path d="M16 12H3" />
                  <path d="M16 6H3" />
                </svg>
              )}
              {item.icon === "search" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              )}
              {item.label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-border p-3">
          {/* Theme toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" />
                <path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" />
                <path d="m19.07 4.93-1.41 1.41" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            )}
            {theme === "dark" ? "Light Mode" : "Dark Mode"}
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </svg>
            Logout
          </button>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="flex h-14 items-center gap-3 border-b border-border bg-card px-4 sm:hidden">
        <span className="text-base font-semibold tracking-tight">ELK Monitor</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" />
                <path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" />
                <path d="m19.07 4.93-1.41 1.41" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Mobile nav tabs */}
      <div className="flex border-b border-border bg-card sm:hidden">
        {[
          { id: "dashboard" as View, label: "Dashboard" },
          { id: "patterns" as View, label: "Patterns" },
          { id: "findings" as View, label: "Findings" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setView(tab.id)}
            className={`flex-1 px-3 py-2.5 text-center text-sm font-medium transition-colors ${
              view === tab.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main content */}
      <main className="min-h-[calc(100vh-3.5rem)] sm:ml-60">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
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
            />
          )}
          {view === "patterns" && <PatternTable />}
          {view === "findings" && <FindingsPage />}
        </div>
      </main>
    </div>
  )
}

export default App