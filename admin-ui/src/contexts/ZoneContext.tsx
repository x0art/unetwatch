import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { getOperatorZone, type OperatorZone } from "../api"

/**
 * Operator display zone (GET /api/timezone) shared app-wide. The backend
 * buckets and labels every aggregation in this zone (Settings.display_tz),
 * so evidence timestamps must render in it too — otherwise the UI shows one
 * instant as two clock readings. `null` = not loaded yet or the endpoint is
 * absent/failed; consumers then render browser-local (the pre-zone fallback)
 * and the page never breaks.
 */
const ZoneContext = createContext<OperatorZone | null>(null)

export function ZoneProvider({ children }: { children: ReactNode }) {
  const [zone, setZone] = useState<OperatorZone | null>(null)
  useEffect(() => {
    let cancelled = false
    void getOperatorZone().then((z) => { if (!cancelled) setZone(z) })
    return () => { cancelled = true }
  }, [])
  return <ZoneContext.Provider value={zone}>{children}</ZoneContext.Provider>
}

/** The operator zone, or null = render timestamps browser-local. */
export function useZone(): OperatorZone | null {
  return useContext(ZoneContext)
}
