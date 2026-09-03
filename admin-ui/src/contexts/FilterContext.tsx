import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

export type TimeRange = "1h" | "24h" | "7d"

/** Global workspace action filter — "All" means no action filter applied. */
export type ActionFilter = "All" | "ALLOW" | "DENY" | "FLAG"

interface FilterContextValue {
  /** Brief-facing name for the global search term (spec §7 click-to-filter). */
  globalSearch: string
  setGlobalSearch: (v: string) => void
  /** Task 2-era name — kept as an alias so existing consumers keep working. */
  globalFilter: string
  setGlobalFilter: (v: string) => void
  timeRange: TimeRange
  setTimeRange: (v: TimeRange) => void
  actionFilter: ActionFilter
  setActionFilter: (v: ActionFilter) => void
}

const FilterContext = createContext<FilterContextValue | null>(null)

const GLOBAL_FILTER_QS_KEY = "q"
const TIME_RANGE_KEY = "unetwatch_time_range"
const ACTION_FILTER_QS_KEY = "action"
const ACTION_FILTER_KEY = "unetwatch_action_filter"

function readInitialFilter(): string {
  if (typeof window === "undefined") return ""
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get(GLOBAL_FILTER_QS_KEY) ?? ""
  } catch {
    return ""
  }
}

function readInitialTimeRange(): TimeRange {
  if (typeof window === "undefined") return "24h"
  try {
    const params = new URLSearchParams(window.location.search)
    const q = params.get("range")
    if (q === "1h" || q === "24h" || q === "7d") return q
  } catch {
    /* ignore */
  }
  try {
    const stored = window.localStorage.getItem(TIME_RANGE_KEY)
    if (stored === "1h" || stored === "24h" || stored === "7d") return stored
  } catch {
    /* ignore */
  }
  return "24h"
}

function readInitialActionFilter(): ActionFilter {
  if (typeof window === "undefined") return "All"
  try {
    const params = new URLSearchParams(window.location.search)
    const q = params.get(ACTION_FILTER_QS_KEY)
    if (q === "All" || q === "ALLOW" || q === "DENY" || q === "FLAG") return q
  } catch {
    /* ignore */
  }
  try {
    const stored = window.localStorage.getItem(ACTION_FILTER_KEY)
    if (stored === "All" || stored === "ALLOW" || stored === "DENY" || stored === "FLAG") return stored as ActionFilter
  } catch {
    /* ignore */
  }
  return "All"
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [globalFilter, setGlobalFilterRaw] = useState<string>(() => readInitialFilter())
  const [timeRange, setTimeRangeRaw] = useState<TimeRange>(() => readInitialTimeRange())
  const [actionFilter, setActionFilterRaw] = useState<ActionFilter>(() => readInitialActionFilter())
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Single source for the global search term — Task 2 alias kept. */
  const setGlobalSearch = useCallback((v: string) => {
    setGlobalFilterRaw(v)
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current)
    filterDebounceRef.current = setTimeout(() => {
      try {
        const url = new URL(window.location.href)
        if (v) url.searchParams.set(GLOBAL_FILTER_QS_KEY, v)
        else url.searchParams.delete(GLOBAL_FILTER_QS_KEY)
        window.history.replaceState(null, "", url.toString())
      } catch {
        /* ignore */
      }
    }, 250)
  }, [])

  /** Back-compat alias — same state and setter as globalSearch. */
  const setGlobalFilter = setGlobalSearch

  const setTimeRange = useCallback((v: TimeRange) => {
    setTimeRangeRaw(v)
    try {
      window.localStorage.setItem(TIME_RANGE_KEY, v)
    } catch {
      /* ignore */
    }
    try {
      const url = new URL(window.location.href)
      if (v !== "24h") url.searchParams.set("range", v)
      else url.searchParams.delete("range")
      window.history.replaceState(null, "", url.toString())
    } catch {
      /* ignore */
    }
  }, [])

  const setActionFilter = useCallback((v: ActionFilter) => {
    setActionFilterRaw(v)
    try {
      window.localStorage.setItem(ACTION_FILTER_KEY, v)
    } catch {
      /* ignore */
    }
    try {
      const url = new URL(window.location.href)
      if (v !== "All") url.searchParams.set(ACTION_FILTER_QS_KEY, v)
      else url.searchParams.delete(ACTION_FILTER_QS_KEY)
      window.history.replaceState(null, "", url.toString())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    // Sync from URL on mount (already done in initializers) - listen for popstate
    const onPop = () => {
      try {
        const params = new URLSearchParams(window.location.search)
        const q = params.get(GLOBAL_FILTER_QS_KEY) ?? ""
        setGlobalFilterRaw(q)
        const r = params.get("range")
        if (r === "1h" || r === "24h" || r === "7d") setTimeRangeRaw(r)
        const a = params.get(ACTION_FILTER_QS_KEY)
        if (a === "All" || a === "ALLOW" || a === "DENY" || a === "FLAG") setActionFilterRaw(a)
        else if (a === null) setActionFilterRaw("All")
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    return () => {
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current)
    }
  }, [])

  const value = useMemo<FilterContextValue>(
    () => ({
      globalSearch: globalFilter,
      setGlobalSearch,
      globalFilter,
      setGlobalFilter,
      timeRange,
      setTimeRange,
      actionFilter,
      setActionFilter,
    }),
    [globalFilter, setGlobalSearch, setGlobalFilter, timeRange, setTimeRange, actionFilter, setActionFilter],
  )

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>
}

export function useFilter(): FilterContextValue {
  const ctx = useContext(FilterContext)
  if (!ctx) throw new Error("useFilter must be used within <FilterProvider>")
  return ctx
}

// Alias for brief naming
export const useFilterContext = useFilter
