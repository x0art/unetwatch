/* ────────────────────────────────────────────────────────────────
 * Progress — the maths behind the determinate track, extracted so it can
 * be reasoned about (and unit-tested) without a DOM.
 *
 * Honesty rule: a percentage is only rendered when BOTH parts are known.
 * `loaded` alone is a count, not a fraction — it renders as a count with an
 * indeterminate track, never as a fabricated bar. A determinate bar exists
 * only when a real `total` is supplied, and even then it is clamped to a
 * 2%→100% visible range so a 0-row start is still perceivable without
 * pretending real progress that hasn't happened yet.
 * ──────────────────────────────────────────────────────────────── */

export interface LoadingProgress {
  /** Rows/items received so far. */
  loaded: number
  /** Total expected, when the parent can supply it. Enables the real bar. */
  total?: number
}

export type ProgressKind = "determinate" | "indeterminate"

export interface ProgressFraction {
  kind: ProgressKind
  /** 0–100, only meaningful when `kind === "determinate"`. */
  percent: number
  /** True while more is still owed — drives the "loaded x of y" wording. */
  incomplete: boolean
}

/** A determinate bar never renders below this width: a hairline at 0% reads
 * as "broken", not "just started". */
export const MIN_TRACK_PERCENT = 2

/**
 * Decide what the progress track may truthfully show.
 *  - no total, or a nonsense total ⇒ indeterminate
 *  - loaded past total (a chattier server than expected) ⇒ pinned at 100%,
 *    marked incomplete so the copy still says work is outstanding
 */
export function progressFraction(progress?: LoadingProgress): ProgressFraction | null {
  if (!progress) return null
  const loaded = Math.max(0, progress.loaded || 0)
  const total = progress.total
  if (total === undefined || !Number.isFinite(total) || total <= 0) {
    return { kind: "indeterminate", percent: 0, incomplete: true }
  }
  const raw = (loaded / total) * 100
  const percent = Math.min(100, Math.max(MIN_TRACK_PERCENT, raw))
  return { kind: "determinate", percent, incomplete: loaded < total }
}

/** Human count line for the determinate case: "loaded 50 of 320 rows". */
export function progressLabel(progress: LoadingProgress, noun = "rows"): string {
  if (progress.total === undefined || !Number.isFinite(progress.total) || progress.total <= 0) {
    return `loaded ${Math.max(0, progress.loaded)} ${noun}`
  }
  return `loaded ${Math.max(0, progress.loaded)} of ${progress.total} ${noun}`
}
