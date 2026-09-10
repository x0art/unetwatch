import { useState, type ReactNode, useRef, useEffect } from "react"
import { MobileSidebar, MobileMenuButton, Sidebar, useTheme, type View } from "./Sidebar"
import { cn } from "../lib/utils"

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
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    document.title = title ? `uNetWatch — ${title}` : "uNetWatch"
  }, [title])

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
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold tracking-tight sm:text-[16px]">{title}</h1>
            {description && (
              <p className="truncate text-xs font-medium text-muted-foreground">{description}</p>
            )}
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
