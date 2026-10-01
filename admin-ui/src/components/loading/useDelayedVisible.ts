import { useEffect, useRef, useState } from "react"
import { usePageVisible } from "../../lib/utils"

/** Wait this long before admitting a loader exists. A fast read then never
 * flashes anything — an 80ms spinner is worse than a spinner that never
 * appeared. 250ms is under the ~300ms "instant" perceptual budget. */
export const LOADER_DELAY_MS = 250

/** Once shown, keep the loader up at least this long. A loader that appears
 * for two frames then vanishes reads as a glitch; the eye is drawn to the
 * movement, not the result. 400ms is short enough not to feel sluggish but
 * long enough to complete a single motion beat. */
export const LOADER_MIN_VISIBLE_MS = 400

/**
 * Anti-flicker gate for any loading affordance.
 *
 * Timeline (delay 250ms, minVisible 400ms by default):
 *
 *   t=0    active=true            → visible=false   (nothing shown)
 *   t=250  still active           → visible=true    (loader fades in)
 *   t=300  active=false           → stays visible   (min-visible clock armed)
 *   t=650  min-visible elapsed    → visible=false   (loader leaves)
 *
 *   …or, when the work outlives the delay:
 *
 *   t=0    active=true            → visible=false
 *   t=250  still active           → visible=true
 *   t=900  active=false           → visible=false   (already past min-visible)
 *
 * Strict-Mode safe: each effect owns its timers and clears them on cleanup,
 * and the shown/min-visible bookkeeping lives in refs that survive the
 * double-invoke, so a remount neither double-shows nor drops the minimum.
 */
export function useDelayedVisible(
  active: boolean,
  { delayMs = LOADER_DELAY_MS, minVisibleMs = LOADER_MIN_VISIBLE_MS }: { delayMs?: number; minVisibleMs?: number } = {},
): boolean {
  const visible = usePageVisible()
  const [shown, setShown] = useState(false)
  const shownAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    // Hidden tab: no timers, and the loader is irrelevant off-screen. When the
    // tab returns the effect re-runs and re-decides from the CURRENT `active`.
    if (!visible) {
      clearTimer()
      return
    }
    if (active) {
      if (shown) return
      // Arm the delay only if we haven't already been shown. Re-renders while
      // waiting must not restart the clock.
      if (timerRef.current === null && shownAtRef.current === 0) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          shownAtRef.current = Date.now()
          setShown(true)
        }, delayMs)
      }
      return
    }
    // Work ended.
    clearTimer()
    if (!shown) return
    const since = Date.now() - shownAtRef.current
    const remaining = Math.max(0, minVisibleMs - since)
    if (remaining === 0) {
      shownAtRef.current = 0
      setShown(false)
      return
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      shownAtRef.current = 0
      setShown(false)
    }, remaining)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible, delayMs, minVisibleMs, shown])

  // A loader must never outlive its tab-hidden period as a stale "visible".
  useEffect(() => () => clearTimer(), [])

  return shown
}
