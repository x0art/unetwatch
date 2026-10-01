import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { useCallback, useEffect, useRef, useState } from "react"
import type { OperatorZone } from "../api"

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
 * Run an abortable READ and get its typed result.
 *
 * Generalizes the one good cancellation implementation in the app
 * (`QueryPage.tsx:633-676`) so every reader can share it. Each call aborts the
 * previous in-flight call BEFORE installing a FRESH `AbortController`, so a
 * superseded request stops and a new one proceeds on its own signal.
 *
 * `AbortError` is swallowed — it resolves to `undefined` instead of rejecting.
 * An abort is a normal consequence of the user changing input, not a failure,
 * so it must never flash an error banner; non-abort errors still reject.
 *
 * Unmount aborts the current call: the effect owns and clears its own
 * controller, so React 19 Strict Mode's double-invoke is safe (the first
 * mount's cleanup aborts its controller; the second mount's call makes its own).
 *
 * Only READ (GET-style) functions may be run through this — aborting a
 * half-sent write leaves unknown server state (Audit §4.5 / spec §5).
 */
export function useAbortable(): <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined> {
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  return useCallback(<T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    return fn(controller.signal).catch((e: unknown) => {
      if ((e as Error).name === "AbortError") return undefined
      throw e
    })
  }, [])
}

/**
 * A monotonically increasing generation counter.
 *
 * `next()` claims and returns a new generation id; `isCurrent(g)` is true only
 * while `g` is still the newest claimed one. Use this where a request may be
 * allowed to *finish* but its result must not *win* — the discarded-cleanup
 * paths (`useAutoRefresh` poll ticks, `QueryPage.tsx:685`) whose returned
 * cleanup is thrown away, so an abort could never run there.
 *
 * Rule of thumb: `useAbortable` when the superseded work is worthless and
 * should stop; `useGeneration` when it may finish but must not overwrite state.
 */
export function useGeneration(): { next: () => number; isCurrent: (g: number) => boolean } {
  const genRef = useRef(0)
  const next = useCallback(() => ++genRef.current, [])
  const isCurrent = useCallback((g: number) => g === genRef.current, [])
  return { next, isCurrent }
}

/**
 * Periodically re-run `refresh` every `seconds` (0 = off). The interval is
 * persisted per `key` in localStorage and ticks are skipped while the tab is
 * hidden, so background tabs never hammer the API.
 *
 * `refresh` may return a promise. While one is pending the next tick is
 * SKIPPED (not queued and never aborted): a slow backend tick must not overlap
 * the next, but aborting every tick would defeat a periodic refresh against
 * that same slow backend (the wall-display scenario this module exists for).
 */
export function useAutoRefresh(
  // `unknown` (not `void | Promise<unknown>`) so the legacy callbacks that
  // return their own `cancelled` cleanup keep compiling unchanged: only a
  // thenable return is tracked as in-flight.
  refresh: () => unknown,
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

  // Whether a tick's returned promise is still pending. A ref (not state) so
  // setting it never re-renders or restarts the interval.
  const inFlightRef = useRef(false)

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
      if (document.visibilityState === "hidden") return
      if (inFlightRef.current) return
      const out = refresh()
      if (out && typeof (out as Promise<unknown>).then === "function") {
        inFlightRef.current = true
        void Promise.resolve(out).finally(() => {
          inFlightRef.current = false
        })
      }
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
 * Render an instant in the operator's display zone: the backend buckets and
 * labels every aggregation in that zone (Settings.display_tz), so evidence
 * timestamps must render in the same zone or the UI shows one instant as two
 * clock readings. `zone === null` (endpoint absent/failed) falls back to
 * browser-local rendering — the pre-zone behavior. Unparseable input is
 * returned unchanged. Never throws.
 */
export function formatInstant(input: string | number, zone: OperatorZone | null): string {
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return String(input)
  if (!zone) return d.toLocaleString()
  try {
    // IANA labels ("Asia/Bangkok", "UTC") are valid Intl timeZone identifiers
    // and DST-aware per instant. Fixed-offset labels ("+07:00") are rejected
    // by some engines — the fallback below covers those.
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone.label,
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(d)
  } catch {
    // Fixed-offset zones have no DST, so shifting the instant by the zone's
    // offset and reading it back as UTC wall-clock is exact for any instant.
    const shifted = new Date(d.getTime() + zone.offsetMinutes * 60_000)
    return new Intl.DateTimeFormat(undefined, {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(shifted)
  }
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
