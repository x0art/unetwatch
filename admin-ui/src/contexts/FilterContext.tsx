import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type TimeRange = "1h" | "24h" | "7d"

interface FilterContextValue {
  globalFilter: string
  setGlobalFilter: (v: string) => void
  timeRange: TimeRange
  setTimeRange: (v: TimeRange) => void
}

const FilterContext = createContext<FilterContextValue | null>(null)

const GLOBAL_FILTER_QS_KEY = "q"
const TIME_RANGE_KEY = "unetwatch_time_range"

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
    const stored = window.localStorage.getItem(TIME_RANGE_KEY)
    if (stored === "1h" || stored === "24h" || stored === "7d") return stored
  } catch {
    /* ignore */
  }
  try {
    const params = new URLSearchParams(window.location.search)
    const q = params.get("range")
    if (q === "1h" || q === "24h" || q === "7d") return q
  } catch {
    /* ignore */
  }
  return "24h"
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [globalFilter, setGlobalFilterRaw] = useState<string>(() => readInitialFilter())
  const [timeRange, setTimeRangeRaw] = useState<TimeRange>(() => readInitialTimeRange())

  const setGlobalFilter = useCallback((v: string) => {
    setGlobalFilterRaw(v)
    try {
      const url = new URL(window.location.href)
      if (v) url.searchParams.set(GLOBAL_FILTER_QS_KEY, v)
      else url.searchParams.delete(GLOBAL_FILTER_QS_KEY)
      window.history.replaceState(null, "", url.toString())
    } catch {
      /* ignore */
    }
  }, [])

  const setTimeRange = useCallback((v: TimeRange) => {
    setTimeRangeRaw(v)
    try {
      window.localStorage.setItem(TIME_RANGE_KEY, v)
    } catch {
      /* ignore */
    }
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("range", v)
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
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const value = useMemo<FilterContextValue>(
    () => ({ globalFilter, setGlobalFilter, timeRange, setTimeRange }),
    [globalFilter, setGlobalFilter, timeRange, setTimeRange],
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
