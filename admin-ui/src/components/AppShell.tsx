import { useState, type ReactNode, useRef, useEffect } from "react"
import { ShieldCheck } from "lucide-react"
import { MobileSidebar, MobileMenuButton, Sidebar, useTheme, type View } from "./Sidebar"
import { cn } from "../lib/utils"

/* ── Chrome view label ─────────────────────────────────────────
 * The header names the current view so it is informative, but it is NOT the
 * page title — the in-page `PageHeader`/`PageShell` owns that. Labels are
 * sourced verbatim from the sidebar's own `NAV_GROUPS` so the shell and the
 * nav can never disagree about what a view is called.
 *
 * `attck-fleet` is a member of the `View` union but has no sidebar entry (the
 * ATT&CK fleet view was dropped from the nav), so its label is the only one
 * that does not come from `NAV_GROUPS` — leaving it out would break the
 * `Record<View, string>` exhaustiveness check. */
const VIEW_LABELS: Record<View, string> = {
  dashboard: "Dashboard",
  query: "Query",
  patterns: "Patterns",
  findings: "Findings",
  blacklist: "Blacklist",
  jaillist: "Jaillist",
  redirects: "Redirects",
  logs: "Logs",
  host: "Host Investigation",
  url: "URL Investigation",
  analytics: "Analytics",
  "attck-fleet": "ATT&CK Fleet",
}

export function AppShell({
  currentView,
  onNavigate,
  onLogout,
  userName,
  actions,
  children,
  className,
}: {
  currentView: View
  onNavigate: (view: View) => void
  onLogout?: () => void
  userName?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    document.title = `uNetWatch — ${VIEW_LABELS[currentView]}`
  }, [currentView])

  const handleNavigate = (view: View) => {
    onNavigate(view)
    setMobileOpen(false)
  }

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:border focus:border-border focus:bg-secondary focus:px-4 focus:py-2 focus:text-xs focus:font-medium focus:text-foreground"
      >
        Skip to content
      </a>

      <Sidebar
        current={currentView}
        onNavigate={handleNavigate}
        theme={theme}
        onToggleTheme={toggle}
        onLogout={onLogout}
        userName={userName}
      />

      <MobileSidebar
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        current={currentView}
        onNavigate={handleNavigate}
        theme={theme}
        onToggleTheme={toggle}
        onLogout={onLogout}
        userName={userName}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-[64px] items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
          <MobileMenuButton onClick={() => setMobileOpen(true)} />
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            </div>
            <span className="truncate text-sm font-semibold tracking-tight">{VIEW_LABELS[currentView]}</span>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <main
          id="main-content"
          ref={mainRef as React.RefObject<HTMLElement>}
          className={cn("relative flex-1 px-4 py-6 sm:px-6 lg:px-8", className)}
        >
          <div className="mx-auto w-full max-w-[1440px]">
            <div className="w-full fade-in cv-auto">{children}</div>
          </div>
        </main>
      </div>
    </div>
  )
}
