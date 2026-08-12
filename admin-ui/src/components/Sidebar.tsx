import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  Activity,
  Ban,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  ListFilter,
  LogOut,
  Menu,
  Moon,
  Network,
  Radar,
  ScrollText,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "./ui"

/* Theme lives in a context provider so the sidebar toggle and the chart
 * palette share one source of truth. Default dark, persisted to
 * localStorage("unetwatch-theme"); legacy "elk-theme" is read as a
 * fallback for existing installs. */

export type Theme = "dark" | "light"

const THEME_KEY = "unetwatch-theme"
const LEGACY_THEME_KEY = "elk-theme"

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
  const stored =
    window.localStorage.getItem(THEME_KEY) ??
    window.localStorage.getItem(LEGACY_THEME_KEY)
  return stored === "light" ? "light" : "dark"
}

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The theme class is applied synchronously — not in an effect — so every
  // render (including components that resolve CSS variables at render time,
  // like the Sankey diagram) sees the active theme's tokens. Applying it a
  // frame later left the Sankey text/colors one theme behind, e.g. light
  // text on a white card when the app loaded in light mode.
  const [theme, setThemeState] = useState<Theme>(() => {
    const initial = readInitialTheme()
    applyTheme(initial)
    return initial
  })

  const applyAndSet = useCallback((next: Theme) => {
    applyTheme(next)
    setThemeState(next)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: applyAndSet,
      toggle: () => applyAndSet(theme === "dark" ? "light" : "dark"),
    }),
    [theme, applyAndSet],
  )

  useEffect(() => {
    // The class is already applied synchronously; persist the preference.
    try {
      window.localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* storage may be unavailable */
    }
  }, [theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>")
  return ctx
}

/* ════════════════════════════════════════════════════════════════
 * Navigation model
 * ════════════════════════════════════════════════════════════════ */

export type View =
  | "dashboard"
  | "query"
  | "patterns"
  | "findings"
  | "graph"
  | "blacklist"
  | "redirects"
  | "logs"

export interface NavItem {
  view: View
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/* Sidebar groups: Monitor (live views), Management (config + data), and
 * System (audit). Ordering here is the display order. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    items: [
      { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { view: "graph", label: "Traffic", icon: Network },
      { view: "query", label: "Query", icon: FileSearch },
    ],
  },
  {
    label: "Management",
    items: [
      { view: "patterns", label: "Patterns", icon: ListFilter },
      { view: "findings", label: "Findings", icon: Radar },
      { view: "redirects", label: "Redirects", icon: GitBranch },
      { view: "blacklist", label: "Blacklist", icon: Ban },
    ],
  },
  {
    label: "System",
    items: [{ view: "logs", label: "Logs", icon: ScrollText }],
  },
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
          <p className="truncate text-sm font-semibold tracking-tight">uNetWatch</p>
          <p className="truncate text-[11px] text-sidebar-muted">Pattern console</p>
        </div>
      </div>

      {/* Nav (grouped) */}
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon
              const active = current === item.view
              return (
                <button
                  key={item.view}
                  type="button"
                  onClick={() => onNavigate(item.view)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-sidebar-active/15 text-sidebar-active before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-sidebar-active before:content-['']"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-hover hover:text-sidebar-foreground",
                  )}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
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
