import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Clock } from "lucide-react"
import { cn } from "../../lib/utils"
import { ProgressHint } from "./ProgressHint"
import { LOADER_DELAY_MS, LOADER_MIN_VISIBLE_MS, useDelayedVisible } from "./useDelayedVisible"
import { formatElapsed, useElapsed } from "./useElapsed"
import { progressFraction, type LoadingProgress } from "./progress"

/** Past this the read is no longer "quick" and we name the wait honestly. */
const SLOW_MS = 10_000
/** Past this we stop implying patience helps and point at the backend. */
const STALLED_MS = 45_000
/** Body copy is not announced every second — but a state CHANGE is worth a
 * sentence, so these thresholds double as aria-live transition points. */
type Phase = "working" | "slow" | "stalled"

function phaseOf(elapsedMs: number): Phase {
  if (elapsedMs >= STALLED_MS) return "stalled"
  if (elapsedMs >= SLOW_MS) return "slow"
  return "working"
}

/** Copy per phase. Truthful by construction: no percentage is ever invented,
 * and the reassurance line grows more specific (and more apologetic) as the
 * wait deepens, without ever promising a completion time we cannot know. */
const PHASE_COPY: Record<Phase, string> = {
  working: "Still working…",
  slow: "This is taking longer than usual — the query is still running.",
  stalled: "Still running after 45s. The Elasticsearch cluster may be under load or slow to respond.",
}

export interface LoadingIndicatorProps {
  /** What we're waiting on, e.g. "Querying Elasticsearch". */
  label: string
  /** Epoch-ms anchor for the read (see `useElapsed`). Optional. */
  startedAt?: number
  /** When set, the indicator is driven by it; otherwise it stays active.
   * Callers that gate on their own fetch pass `active={loading}`. */
  active?: boolean
  /** Real fraction, only when the parent can compute one. Never invented. */
  progress?: LoadingProgress
  /** Noun for the progress line, e.g. "rows" / "events" / "findings". */
  progressNoun?: string
  /** Force-show without the anti-flicker delay (e.g. an already-cold view). */
  immediate?: boolean
  /** Override the delay used when `immediate` is false. */
  delayMs?: number
  /** Override the minimum on-screen time once shown. */
  minVisibleMs?: number
  className?: string
}

/**
 * <LoadingIndicator> — the app's honest "we are still working" surface.
 *
 * Renders NOTHING until it has been active for `delayMs` (default 250ms), so
 * a fast read never flashes a loader. Once shown it:
 *  - shows the label and a mono elapsed figure (aria-hidden — never announce
 *    a per-second number);
 *  - transitions the reassurance line at 10s (slow) and 45s (stalled), and
 *    ONLY those transitions are announced, via a single `role="status"`
 *    `aria-live="polite"` region;
 *  - renders a determinate bar when, and only when, the parent supplied a real
 *    total (`progress.total`); otherwise an indeterminate shimmer.
 *
 * Verification of reduced-motion / data-paused coverage is in `./index.tsx`.
 */
export function LoadingIndicator({
  label,
  startedAt,
  active = true,
  progress,
  progressNoun = "rows",
  immediate = false,
  delayMs = LOADER_DELAY_MS,
  minVisibleMs = LOADER_MIN_VISIBLE_MS,
  className,
}: LoadingIndicatorProps) {
  const show = useDelayedVisible(active, { delayMs: immediate ? 0 : delayMs, minVisibleMs })
  const { elapsedMs, elapsed } = useElapsed(active, startedAt)

  // While the anti-flicker delay is running (active but not yet shown) the
  // hook has no valid anchor, so `elapsed` stays "0.0s" and is not rendered.
  const phase = phaseOf(elapsedMs)
  const fraction = progressFraction(progress)

  // Announce only phase CHANGES. The first mount is not a change — the live
  // region is empty until a threshold trips, so a quick read announces nothing.
  const [announced, setAnnounced] = useState("")
  const prevPhaseRef = useRef<Phase | null>(null)
  useEffect(() => {
    if (!show) return
    if (prevPhaseRef.current === null) {
      prevPhaseRef.current = phase
      return
    }
    if (prevPhaseRef.current !== phase) {
      prevPhaseRef.current = phase
      setAnnounced(PHASE_COPY[phase])
    }
  }, [phase, show])

  // Keep the live text tied to the mount: on unmount the region disappears
  // with the component, so no explicit clear is needed — but resetting when we
  // hide keeps a remount from replaying a stale sentence.
  useEffect(() => {
    if (!show) {
      prevPhaseRef.current = null
      setAnnounced("")
    }
  }, [show])

  const stalled = phase === "stalled"
  const determinate = fraction?.kind === "determinate"

  // The label carries its own ellipsis only in the sub-second "starting"
  // beat, when we genuinely don't know how long this will take.
  const labelText = elapsedMs < 1000 ? `${label}…` : label

  if (!show) return null

  return (
    <div
      className={cn(
        "animate-in flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 shadow-sm",
        className,
      )}
      data-state={phase}
    >
      {/* The announced sentence. Deliberately NOT containing the ticking
          figure — that lives in the aria-hidden row below. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announced}
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        {stalled ? (
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
        ) : (
          <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="font-medium">{labelText}</span>
        {/* Elapsed figure: mono, tabular, aria-hidden. A screen reader hears
            the phase sentence above, never a 1Hz stream of seconds. */}
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
          {elapsed}
        </span>
        {progress && <ProgressHint progress={progress} noun={progressNoun} className="ml-auto" />}
      </div>

      {/* Hairline track. The determinate fill doubles as a visual that the read
          really is progressing; the indeterminate variant is a quiet sweep. */}
      {progress && !determinate && (
        <span className="relative block h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 w-1/3">
            <span className="skeleton-shimmer block h-full w-full rounded-full bg-primary/40" />
          </span>
        </span>
      )}

      <p className={cn("text-xs leading-relaxed", stalled ? "text-warning" : "text-muted-foreground")}>
        {PHASE_COPY[phase]}
      </p>
    </div>
  )
}

/** Re-exported so parents can coordinate their own skeletons with the same
 * anti-flicker budget without importing the hook module directly. */
export { LOADER_DELAY_MS, LOADER_MIN_VISIBLE_MS, formatElapsed }
