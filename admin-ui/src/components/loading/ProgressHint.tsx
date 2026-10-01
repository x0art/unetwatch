import { cn } from "../../lib/utils"
import { MIN_TRACK_PERCENT, progressFraction, progressLabel, type LoadingProgress } from "./progress"

/**
 * The inline progress track shared by <LoadingIndicator> and the DataTable
 * toolbar hint. Deliberately the same hairline language as <Skeleton>:
 * `h-1`, `rounded-full`, `bg-muted`, a `bg-primary` fill. No new palette.
 *
 * Motion is opacity + width only:
 *  - the indeterminate track uses the CSS `skeleton-shimmer` keyframe, so the
 *    global `html[data-paused]` rule and the `prefers-reduced-motion` block in
 *    index.css both neuter it for free;
 *  - the determinate fill animates `width` via a plain CSS transition that
 *    respects `--default-transition-timing-function`; a reduced-motion user
 *    simply sees each new width already settled.
 */
export function ProgressHint({
  progress,
  noun = "rows",
  className,
}: {
  progress?: LoadingProgress
  noun?: string
  className?: string
}) {
  const fraction = progressFraction(progress)
  if (!progress || !fraction) return null

  const determinate = fraction.kind === "determinate"
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className="relative block h-1 w-24 overflow-hidden rounded-full bg-muted"
        role={determinate ? "progressbar" : undefined}
        aria-hidden={determinate ? undefined : true}
        aria-label={determinate ? progressLabel(progress, noun) : undefined}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? Math.round(fraction.percent) : undefined}
      >
        {determinate ? (
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.max(MIN_TRACK_PERCENT, fraction.percent)}%` }}
          />
        ) : (
          // Indeterminate: a 40%-wide shimmer travelling left→right. Width is
          // static; only transform animates inside the fixed track.
          <span className="absolute inset-y-0 left-0 w-2/5">
            <span className="skeleton-shimmer block h-full w-full rounded-full bg-primary/40" />
          </span>
        )}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
        {progressLabel(progress, noun)}
      </span>
    </span>
  )
}
