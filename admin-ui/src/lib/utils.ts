import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { useEffect, useState } from "react"

/**
 * Merge Tailwind classes with proper de-duplication.
 * Filters falsy values, then resolves conflicts via tailwind-merge.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Debounce any value by `delayMs`. Returns the latest value after the
 * input settles. Used by Patterns search to avoid per-keystroke fetches.
 *
 *   const debounced = useDebounce(searchTerm, 300)
 *   useEffect(() => { fetch(debounced) }, [debounced])
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

/**
 * Periodically re-run `refresh` every `seconds` (0 = off). The interval is
 * persisted per `key` in localStorage and ticks are skipped while the tab is
 * hidden, so background tabs never hammer the API.
 */
export function useAutoRefresh(
  refresh: () => void,
  key: string,
  defaultSeconds = 0,
): { refreshSeconds: number; setRefreshSeconds: (s: number) => void } {
  const [refreshSeconds, setRefreshSeconds] = useState<number>(() => {
    try {
      const stored = Number(window.localStorage.getItem(`unetwatch_autorefresh_${key}`))
      return Number.isFinite(stored) && stored >= 0 ? stored : defaultSeconds
    } catch {
      return defaultSeconds
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(`unetwatch_autorefresh_${key}`, String(refreshSeconds))
    } catch {
      /* storage may be unavailable */
    }
  }, [refreshSeconds, key])

  useEffect(() => {
    if (!refreshSeconds) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refresh()
    }, refreshSeconds * 1000)
    return () => window.clearInterval(id)
  }, [refreshSeconds, refresh])

  return { refreshSeconds, setRefreshSeconds }
}

/**
 * True while the browser tab is visible (not hidden, minimized, or covered).
 * Used to pause infinite CSS animations (data-paused on <html>) and skip
 * decorative motion work while the tab is in the background.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden")
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])
  return visible
}

/**
 * Relative time for table timestamp cells (Notion-style two-liner: relative
 * on top, absolute below). Accepts ISO strings or epoch-ms. Returns the
 * input unchanged when it cannot be parsed.
 */
export function formatRelativeTime(input: string | number): string {
  const t = typeof input === "number" ? input : Date.parse(input)
  if (Number.isNaN(t)) return String(input)
  const diff = Date.now() - t
  if (diff < 0) return String(input)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 10) return "Just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea +
 * execCommand for older browsers / non-secure contexts. Resolves
 * `false` when neither path works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    document.body.removeChild(ta)
    return true
  } catch {
    return false
  }
}
