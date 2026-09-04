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
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  Link2,
  ListFilter,
  LogOut,
  Menu,
  Moon,
  Radar,
  Users,
  ScrollText,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "./ui"

export type Theme = "dark" | "light"

const THEME_KEY = "unetwatch-theme"
const LEGACY_THEME_KEY = "elk-theme"
const SIDEBAR_COLLAPSED_KEY = "unetwatch-sidebar-collapsed"

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

export type View =
  | "dashboard"
  | "query"
  | "patterns"
  | "findings"
  | "blacklist"
  | "redirects"
  | "logs"
  /* ── Deep Dive pages ── */
  | "host"
  | "url"
  | "analytics"

export interface NavItem {
  view: View
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    items: [
      { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { view: "query", label: "Query", icon: FileSearch },
    ],
  },
  {
    label: "Deep Dive",
    items: [
      { view: "host", label: "Host Inspector", icon: Users },
      { view: "url", label: "URL Investigation", icon: Link2 },
      { view: "analytics", label: "Analytics", icon: BarChart3 },
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
  const { collapsed, toggle } = useSidebarContext()

  return (
    <div className="flex h-full flex-col bg-[#0A0A0A] text-[#F6F2E8]">
      {/* Brand — ink slab + hazard bar */}
      <div className={cn("relative flex h-[64px] shrink-0 items-center border-b-[3px] border-[#1A1A1A]", collapsed ? "justify-center px-0" : "gap-3 px-4")}>
        <div className="hazard-bar absolute inset-x-0 top-0" aria-hidden="true" />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border-[2.5px] border-[#FFD60A] bg-[#FFD60A] text-[#0A0A0A]">
          <Activity className="h-5 w-5" aria-hidden="true" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="font-display truncate text-[13px] leading-none">UNETWATCH</p>
            <p className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#9A9590]">PATTERN CONSOLE</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className={cn("flex-1 overflow-y-auto", collapsed ? "space-y-2 px-2 py-4" : "space-y-5 px-3 py-4")} aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1.5">
            {!collapsed && (
              <p className="px-2 pb-1 font-mono text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#9A9590]">
                [ {group.label.toUpperCase()} ]
              </p>
            )}
            {collapsed && <div className="mx-2 h-px bg-[#1A1A1A]" aria-hidden="true" />}
            {group.items.map((item) => {
              const Icon = item.icon
              const active = current === item.view
              return (
                <button
                  key={item.view}
                  type="button"
                  onClick={() => onNavigate(item.view)}
                  aria-current={active ? "page" : undefined}
                  aria-label={item.label}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "relative flex w-full items-center border-[2.5px] text-left font-mono text-xs font-extrabold uppercase tracking-widest transition-[transform,box-shadow,background,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD60A]",
                    collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5",
                    active
                      ? "bg-[#FFD60A] text-[#0A0A0A] border-[#0A0A0A] brutal-shadow-sm"
                      : "border-transparent text-[#F6F2E8]/80 hover:border-[#2A2A2A] hover:bg-white/[0.06] hover:text-[#F6F2E8]",
                  )}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t-[3px] border-[#1A1A1A] p-3">
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "mb-1 flex w-full items-center border-[2px] border-transparent font-mono text-xs font-bold uppercase tracking-widest text-[#F6F2E8]/70 hover:border-[#2A2A2A] hover:bg-white/[0.06] hover:text-[#F6F2E8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD60A]",
            collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-[18px] w-[18px]" aria-hidden="true" /> : <ChevronLeft className="h-[18px] w-[18px]" aria-hidden="true" />}
          {!collapsed && <span>{collapsed ? "" : "COLLAPSE"}</span>}
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          className={cn(
            "mb-1 flex w-full items-center border-[2px] border-transparent font-mono text-xs font-bold uppercase tracking-widest text-[#F6F2E8]/70 hover:border-[#2A2A2A] hover:bg-white/[0.06] hover:text-[#F6F2E8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD60A]",
            collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5",
          )}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}
        >
          {theme === "dark" ? <Sun className="h-[18px] w-[18px]" aria-hidden="true" /> : <Moon className="h-[18px] w-[18px]" aria-hidden="true" />}
          {!collapsed && <span>{theme === "dark" ? "LIGHT" : "DARK"}</span>}
        </button>

        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className={cn(
              "flex w-full items-center border-[2px] border-transparent font-mono text-xs font-bold uppercase tracking-widest text-[#F6F2E8]/70 hover:border-[#FF3B30]/30 hover:bg-[#FF3B30]/10 hover:text-[#FF3B30] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD60A]",
              collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5",
            )}
            aria-label={collapsed ? `Logout${userName ? ` · ${userName}` : ""}` : undefined}
            title={collapsed ? `Logout${userName ? ` · ${userName}` : ""}` : undefined}
          >
            <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
            {!collapsed && <span>LOGOUT{userName ? ` · ${userName.toUpperCase()}` : ""}</span>}
          </button>
        )}
      </div>
    </div>
  )
}

interface SidebarContextValue {
  collapsed: boolean
  toggle: () => void
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  toggle: () => {},
})

function useSidebarContext() {
  return useContext(SidebarContext)
}

export function Sidebar(props: SidebarContentProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
    } catch {
      return false
    }
  })
  const toggle = useCallback(() => setCollapsed((c) => !c), [])
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    } catch {
      /* storage may be unavailable */
    }
  }, [collapsed])
  const ctx = useMemo(() => ({ collapsed, toggle }), [collapsed, toggle])
  return (
    <SidebarContext.Provider value={ctx}>
      <aside
        className={cn(
          "hidden md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:border-r-[3px] md:border-[#0A0A0A] dark:md:border-[#F6F2E8]",
          "transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
          collapsed ? "md:w-[64px]" : "md:w-[260px]",
        )}
        aria-label="Sidebar"
      >
        <SidebarContent {...props} />
      </aside>
    </SidebarContext.Provider>
  )
}

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
      <div className="absolute inset-0 bg-[#0A0A0A]/70 backdrop-blur-[1px] animate-in" onClick={onClose} aria-hidden="true" />
      <div className="absolute left-0 top-0 h-full w-[280px] max-w-[85vw] border-r-[3px] border-[#0A0A0A] bg-[#0A0A0A] brutal-shadow-lg animate-in">
        <Button variant="ghost" size="icon" onClick={onClose} className="absolute right-2 top-2 z-10 h-8 w-8 border-[#2A2A2A] text-[#F6F2E8] hover:bg-white/10" aria-label="Close navigation">
          <X className="h-4 w-4" />
        </Button>
        <SidebarContent {...props} />
      </div>
    </div>
  )
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="icon" onClick={onClick} className="md:hidden brutal-shadow-sm" aria-label="Open navigation">
      <Menu className="h-5 w-5" />
    </Button>
  )
}
