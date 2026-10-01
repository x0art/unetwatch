/* ════════════════════════════════════════════════════════════════
 * loading/ — honest, flicker-free waiting feedback.
 *
 * WHY: this console is left open on wall displays during Elasticsearch
 * polls that can run for many seconds. Silence reads as "broken", and a
 * fake progress bar is worse than silence — it lies. So every surface
 * here obeys three rules:
 *
 *   1. HONESTY. No percentage is ever synthesised. A determinate bar
 *      renders only when the parent supplies a real `total`; otherwise the
 *      track is indeterminate and the copy is a count ("loaded 50 rows"),
 *      never a fraction we cannot compute.
 *   2. ANTI-FLICKER. Nothing appears for the first 250ms, and once shown it
 *      stays for at least 400ms. An 80ms spinner is a glitch, not feedback.
 *   3. ELAPSED, NOT CLOCK. The figure counts real time since the read
 *      started. While the tab is hidden the interval is cleared; on return
 *      we re-anchor to wall-clock so the number stays truthful rather than
 *      pretending the wait paused.
 *
 * STATE TABLE (state → threshold → copy)
 *
 *   state    | threshold        | what the user sees
 *   ---------|------------------|------------------------------------------
 *   hidden   | t < 250ms        | nothing at all (anti-flicker delay)
 *   working  | 250ms ≤ t < 10s  | label + mono elapsed + "Still working…"
 *   slow     | 10s ≤ t < 45s    | same chrome + "This is taking longer
 *            |                  |  than usual — the query is still running."
 *   stalled  | t ≥ 45s          | warning icon + "...The Elasticsearch
 *            |                  |  cluster may be under load or slow..."
 *
 *   Determinate vs indeterminate is orthogonal: `progress.total` present ⇒
 *   real bar + "loaded x of y"; absent ⇒ shimmer + "loaded x". The shimmer
 *   also backs the copy off to a 500ms tick past 10s and, in the DataTable,
 *   leaves the previous rows on screen instead of blanking them.
 *
 * ACCESSIBILITY. Elapsed seconds are `aria-hidden` (a per-second aria-live
 * stream is hostile to screen readers). Only the phase SENTENCES are
 * announced, once per transition, through a single `role="status"
 * aria-live="polite"` node. A fast read announces nothing.
 *
 * REDUCED MOTION / PAUSED TAB — which rule covers which animation:
 *   • `.skeleton-shimmer` (indeterminate track; ProgressHint) — the keyframe
 *     is killed by `@media (prefers-reduced-motion: reduce)` (index.css:173)
 *     and frozen by `html[data-paused] *` (index.css:170).
 *   • `.animate-in` (LoadingIndicator entry) — same two rules; a
 *     reduced-motion user gets the element already in place.
 *   • determinate width fill (ProgressHint) — a CSS `transition`, so
 *     index.css:174 collapses it to 0.01ms; each new width lands instantly
 *     and the INFORMATION (the number) is unaffected.
 *   • No framer-motion is used here, so `MotionGate` has nothing to gate —
 *     everything is CSS and therefore already covered by the two global
 *     rules above.
 * ════════════════════════════════════════════════════════════════ */

export { LoadingIndicator } from "./LoadingIndicator"
export type { LoadingIndicatorProps } from "./LoadingIndicator"
export { ProgressHint } from "./ProgressHint"
export { useElapsed, formatElapsed } from "./useElapsed"
export type { ElapsedState } from "./useElapsed"
export { useDelayedVisible, LOADER_DELAY_MS, LOADER_MIN_VISIBLE_MS } from "./useDelayedVisible"
export { progressFraction, progressLabel, MIN_TRACK_PERCENT } from "./progress"
export type { LoadingProgress, ProgressFraction, ProgressKind } from "./progress"
