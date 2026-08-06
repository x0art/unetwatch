import { useEffect, useState } from "react"
import {
  Activity,
  Ban,
  GitBranch,
  LayoutDashboard,
  ListFilter,
  LogOut,
  Menu,
  Moon,
  Network,
  Radar,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "./ui"

/* ════════════════════════════════════════════════════════════════
 * Theme management
 *
 * Default: dark. Toggle adds/removes `light` class on <html>.
 * Persisted in localStorage("elk-theme"). The <html> element carries
 * `dark` by default; `.light` opts in to light tokens (see index.css).
 * ════════════════════════════════════════════════════════════════ */

export type Theme = "dark" | "light"

const THEME_KEY = "elk-theme"

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === "light") {
    root.classList.add("light")
    root.classList.remove("dark")
  } else {
    root.classList.add("dark")
    root.classList.remove("light")
  }
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark"
  const stored = window.localStorage.getItem(THEME_KEY)
  return stored === "light" ? "light" : "dark"
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme())

  useEffect(() => {
    applyTheme(theme)
    try {
      window.localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* storage may be unavailable */
    }
  }, [theme])

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"))
  return { theme, setTheme, toggle }
}

/* ════════════════════════════════════════════════════════════════
 * Navigation model
 * ════════════════════════════════════════════════════════════════ */

export type View = "dashboard" | "patterns" | "findings" | "graph" | "blacklist" | "redirects"

export interface NavItem {
  view: View
  label: string
  icon: LucideIcon
}

export const DEFAULT_NAV: NavItem[] = [
  { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { view: "patterns", label: "Patterns", icon: ListFilter },
  { view: "findings", label: "Findings", icon: Radar },
  { view: "graph", label: "Graph", icon: Network },
  { view: "blacklist", label: "Blacklist", icon: Ban },
  { view: "redirects", label: "Redirects", icon: GitBranch },
]

/* ════════════════════════════════════════════════════════════════
 * Sidebar content (shared between desktop rail and mobile drawer)
 * ════════════════════════════════════════════════════════════════ */

interface SidebarContentProps {
  current: View
  onNavigate: (view: View) => void
  theme: Theme
  onToggleTheme: () => void
  onLogout?: () => void
  userName?: string
}

function SidebarContent({
  current,
  onNavigate,
  theme,
  onToggleTheme,
  onLogout,
  userName,
}: SidebarContentProps) {
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-active/15">
          <Activity className="h-5 w-5 text-sidebar-active" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">ELK Monitor</p>
          <p className="truncate text-[11px] text-sidebar-muted">Pattern console</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Primary">
        {DEFAULT_NAV.map((item) => {
          const Icon = item.icon
          const active = current === item.view
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onNavigate(item.view)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-sidebar-active/15 text-sidebar-active"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-hover hover:text-sidebar-foreground",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </button>
          )
        })}
      </nav>

      {/* Footer: theme + user */}
      <div className="border-t border-sidebar-border p-3">
        <button
          type="button"
          onClick={onToggleTheme}
          className={cn(
            "mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
            "text-sidebar-foreground/80 hover:bg-sidebar-hover hover:text-sidebar-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? (
            <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
          ) : (
            <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
          )}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>

        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
              "text-sidebar-foreground/80 hover:bg-sidebar-hover hover:text-sidebar-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
            <span>Logout{userName ? ` · ${userName}` : ""}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Sidebar — responsive
 *
 * Desktop (>= md): fixed 260px rail on the left.
 * Mobile (< md): hidden; AppShell toggles `mobileOpen` and renders
 *   an overlay drawer containing this component.
 * ════════════════════════════════════════════════════════════════ */

export function Sidebar(props: SidebarContentProps) {
  return (
    <aside
      className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-[260px] md:shrink-0 md:flex-col"
      aria-label="Sidebar"
    >
      <SidebarContent {...props} />
    </aside>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Mobile drawer (used by AppShell)
 * ════════════════════════════════════════════════════════════════ */

export function MobileSidebar({
  open,
  onClose,
  ...props
}: SidebarContentProps & { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute left-0 top-0 h-full w-[280px] max-w-[85vw] shadow-2xl animate-in">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="absolute right-2 top-2 z-10 h-8 w-8 text-sidebar-foreground hover:bg-sidebar-hover"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </Button>
        <SidebarContent {...props} />
      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Mobile menu trigger (used by AppShell header)
 * ════════════════════════════════════════════════════════════════ */

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className="md:hidden"
      aria-label="Open navigation"
    >
      <Menu className="h-5 w-5" />
    </Button>
  )
}
