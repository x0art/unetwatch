import { useEffect, useRef, useState } from "react"
import { usePageVisible } from "../../lib/utils"

/** Tick cadence while the tab is visible. Slow reads stay cheap at 100ms —
 * the figure only changes once a second, so 100ms is plenty smooth for the
 * 1-in-10 boundary crossing without burning frames on a wall display left
 * open for hours. */
const TICK_MS = 100

/** Cadence while the tab is VISIBLE but the read has been running a while.
 * Long polls (10s+) don't need 10Hz repaint of a number that changes each
 * second, and backing off here keeps a wall display cool. */
const SLOW_TICK_MS = 500

/** Escalate to `SLOW_TICK_MS` once elapsed exceeds this. */
const SLOW_AFTER_MS = 10_000

/**
 * Format an elapsed duration as a compact, honest figure.
 *
 *   < 1s   → "0.4s"   (one decimal — the "is it stuck?" range must be legible)
 *   < 60s  → "48s"    (whole seconds once a decimal no longer adds signal)
 *   >= 60s → "2m 05s" (zero-padded seconds so the figure doesn't jitter width)
 *
 * Pure and total: negatives/NaN clamp to "0.0s", so a missing or stale start
 * timestamp can never render a broken figure. Callers format ONLY from the
 * now-and-then elapsed value (see `useElapsed`), never from a wall clock —
 * see the module note in `./index.tsx` on why.
 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (safe < 1000) return `${(safe / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(safe / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

export interface ElapsedState {
  /** Milliseconds since `startedAt`, recomputed on the last tick. */
  elapsedMs: number
  /** The same value through `formatElapsed`, e.g. "1.2s" / "48s" / "2m 05s". */
  elapsed: string
}

/**
 * Track how long an active operation has been running and return it as both
 * raw milliseconds and a formatted string.
 *
 * Contract:
 *  - `active` gates the timer. When it flips false the effect cleans up and
 *    the returned value resets to 0 so a finished read leaves no stale figure.
 *  - `startedAt` is an optional epoch-ms anchor. Omit it and the hook records
 *    its own start the first time it goes active. Passing it lets a parent
 *    that knows when the request actually left (vs. when this rendered) get a
 *    more honest number.
 *  - The timer counts ELAPSED, not wall-clock. While the tab is hidden the
 *    interval is cleared outright, so a backgrounded wall display can neither
 *    accumulate ticks nor drift: on return we re-anchor the display to
 *    (now - startedAt). This is the deliberate behaviour — we keep the
 *    wall-clock reading honest on wake rather than pretending the read paused.
 *  - Strict-Mode safe: every effect invocation owns its interval and clears it
 *    on cleanup, so the double invoke mounts two timers and disposes exactly
 *    one — no leak, no double-count.
 */
export function useElapsed(active: boolean, startedAt?: number): ElapsedState {
  const visible = usePageVisible()
  const [elapsedMs, setElapsedMs] = useState(0)
  // The anchor this hook actually measures from. Held in a ref so the ticking
  // effect can read it without the anchor landing in its dependency list and
  // restarting the interval on every parent render.
  const anchorRef = useRef(0)

  useEffect(() => {
    if (!active) {
      setElapsedMs(0)
      return
    }
    // First active effect invocation wins: a parent-provided `startedAt` is
    // adopted once, otherwise we stamp our own. Later renders (or the
    // Strict-Mode remount) leave an existing anchor alone so the figure never
    // snaps backwards mid-read.
    if (anchorRef.current === 0) {
      anchorRef.current = startedAt ?? Date.now()
    }
    const anchor = anchorRef.current
    setElapsedMs(Math.max(0, Date.now() - anchor))

    // Hidden tab ⇒ no interval at all. Nothing to clear, nothing accruing.
    if (!visible) return

    const tick = () => {
      const next = Math.max(0, Date.now() - anchor)
      setElapsedMs(next)
    }
    const id = window.setInterval(tick, anchorRef.current && Date.now() - anchor > SLOW_AFTER_MS ? SLOW_TICK_MS : TICK_MS)
    return () => window.clearInterval(id)
  }, [active, startedAt, visible])

  // Reset the anchor whenever the operation goes idle, so the next read
  // measures from its own start rather than a stale past instant.
  if (!active && anchorRef.current !== 0) anchorRef.current = 0

  return { elapsedMs, elapsed: formatElapsed(elapsedMs) }
}
