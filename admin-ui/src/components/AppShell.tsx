import { useState, type ReactNode } from "react"
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

  const handleNavigate = (view: View) => {
    onNavigate(view)
    setMobileOpen(false)
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <Sidebar
        current={currentView}
        onNavigate={handleNavigate}
        theme={theme}
        onToggleTheme={toggle}
        onLogout={onLogout}
        userName={userName}
      />

      {/* Mobile drawer */}
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

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6">
          <MobileMenuButton onClick={() => setMobileOpen(true)} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
              {title}
            </h1>
            {description && (
              <p className="truncate text-xs text-muted-foreground sm:text-sm">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <main className={cn("flex-1 px-4 py-6 sm:px-6 lg:px-8", className)}>
          <div className="mx-auto w-full max-w-7xl fade-in">{children}</div>
        </main>
      </div>
    </div>
  )
}
