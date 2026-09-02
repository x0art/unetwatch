import { useState, type ReactNode, useEffect, useRef } from "react"
import { MobileSidebar, MobileMenuButton, Sidebar, useTheme, type View } from "./Sidebar"
import { cn } from "../lib/utils"

function useSpotlight(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const cards = el.querySelectorAll<HTMLElement>(".spotlight-card")
      for (const card of cards) {
        const rect = card.getBoundingClientRect()
        card.style.setProperty("--mx", `${e.clientX - rect.left}px`)
        card.style.setProperty("--my", `${e.clientY - rect.top}px`)
      }
    }
    el.addEventListener("mousemove", onMove)
    return () => el.removeEventListener("mousemove", onMove)
  }, [ref])
}

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
  useSpotlight(mainRef)

  const handleNavigate = (view: View) => {
    onNavigate(view)
    setMobileOpen(false)
  }

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      {/* Grain texture — fixed, behind content */}
      <div className="grain-overlay" aria-hidden="true" />

      {/* Skip link for keyboard users — first focusable element */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-md focus:bg-popover focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-popover-foreground focus:shadow-lg"
      >
        Skip to content
      </a>

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
            <h1 className="font-display truncate text-base font-bold tracking-tight sm:text-lg">
              {title}
            </h1>
            {description && (
              <p className="truncate text-xs text-muted-foreground sm:text-sm">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <main
          id="main-content"
          ref={mainRef as React.RefObject<HTMLElement>}
          className={cn("relative flex-1 px-4 py-6 sm:px-6 lg:px-8", className)}
        >
          {/* Contained width — prevents stretch on ultrawide */}
          <div className="mx-auto w-full max-w-[1440px]">
            {/* cv-auto: skip layout/paint for the below-the-fold part of every
                page until scrolled into view (intrinsic size reserved, so no
                scroll jump). */}
            <div className="w-full fade-in cv-auto">{children}</div>
          </div>
        </main>
      </div>
    </div>
  )
}
