import { useState, type ReactNode, useRef } from "react"
import { MobileSidebar, MobileMenuButton, Sidebar, useTheme, type View } from "./Sidebar"
import { useFilter, type TimeRange } from "../contexts/FilterContext"
import { Input, Select } from "./ui"
import { cn } from "../lib/utils"

const TIME_RANGE_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
]

export function AppShell({
  currentView,
  onNavigate,
  onLogout,
  userName,
  title,
  description,
  actions,
  children,
  className,
}: {
  currentView: View
  onNavigate: (view: View) => void
  onLogout?: () => void
  userName?: string
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const { globalFilter, setGlobalFilter, timeRange, setTimeRange } = useFilter()
  const mainRef = useRef<HTMLElement>(null)

  const handleNavigate = (view: View) => {
    onNavigate(view)
    setMobileOpen(false)
  }

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      {/* grid paper under main — blueprint */}
      <div className="grid-paper pointer-events-none fixed inset-0 opacity-[0.45] dark:opacity-[0.15]" aria-hidden="true" />

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:border-[2.5px] focus:border-[#0A0A0A] focus:bg-secondary focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:font-extrabold focus:uppercase focus:tracking-widest focus:text-[#0A0A0A]"
      >
        SKIP TO CONTENT
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
        <header className="sticky top-0 z-40 flex h-[64px] items-center gap-3 border-b-[3px] border-[#0A0A0A] bg-card px-4 sm:px-6 dark:border-[#F6F2E8] dark:bg-[#0A0A0A]">
          <div className="hazard-bar absolute inset-x-0 top-0" aria-hidden="true" />
          <MobileMenuButton onClick={() => setMobileOpen(true)} />
          <div className="min-w-0 flex-1">
            <h1 className="font-display truncate text-[15px] sm:text-[16px]">{title}</h1>
            {description && (
              <p className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Global Search: src_ip, domain, url..."
              className="w-64"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              aria-label="Global Search"
            />
            <Select
              value={timeRange}
              onChange={(v) => setTimeRange(v as TimeRange)}
              options={TIME_RANGE_OPTIONS}
              className="w-24"
              aria-label="Time range"
            />
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
