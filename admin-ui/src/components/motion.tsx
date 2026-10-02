import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import {
  MotionConfig,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
  type Variants,
} from "framer-motion"

/* ════════════════════════════════════════════════════════════════
 * Motion primitives — the app's cinematic layer.
 *
 * Discipline (matches the global constraints in index.css):
 *  - transform / opacity only — zero layout/paint cost from animation
 *  - tween only, expo-out `cubic-bezier(0.16, 1, 0.3, 1)` everywhere
 *  - no `layout` prop (FLIP measurement is the expensive path)
 *  - reduced motion is honored once at the root via <MotionGate>
 * ════════════════════════════════════════════════════════════════ */

export const EASE = [0.16, 1, 0.3, 1] as const

/** Root motion gate — honors the OS reduced-motion preference so framer and
 * the existing CSS `@media (prefers-reduced-motion)` block agree. Mount once
 * at the app root (App.tsx). */
export function MotionGate({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

/** Fade + 12px rise + slight scale when scrolled into view (plays once). */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.99 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.5, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

export const staggerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } },
}

export const staggerItemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
}

/** Row/item budget for the per-child entrance stagger.
 *
 * The stagger is a first-paint *enhancement*, never a tax on a long table.
 * At `staggerChildren: 0.05` (staggerVariants) the tail of an N-item list
 * settles at roughly `N * 0.05s`: 40 items ≈ 2s worst case, which is the most
 * we ever want the opening beat to cost. Past the cap the table must paint
 * instantly — 200 rows would otherwise animate for ~10s and 1000 for ~50s,
 * saturating the main thread and freezing the page (the Patterns-page hang).
 * 40 also clears every pager page size up to the 25/50 that `Pagination`
 * offers near the boundary without a cliff. */
export const STAGGER_MAX_ITEMS = 40

/** Whether the nearest <Stagger> child budget allows animating this child.
 * Module-private (a plain `export` would add a `react(only-export-components)`
 * warning): `Stagger` is the only writer, so the cap is decided in exactly one
 * place and cannot drift between DataTable and SimpleTable. */
const StaggerBudgetContext = createContext(true)

type StaggerTag = "div" | "tbody" | "tr" | "ul"

/** Parent that staggers its <StaggerItem> children into view.
 *
 * `as` defaults to a div; pass `"tbody"` (with `StaggerItem as="tr"`) for
 * table bodies, since a div cannot wrap `<tr>` elements in valid HTML. */
export function Stagger({
  children,
  as = "div",
  className,
  count,
}: {
  children: ReactNode
  as?: StaggerTag
  className?: string
  /** Number of children that will animate. Omit when unknown (e.g. an async
   *  list) — only an explicit overflow over the cap disables the animation,
   *  so a table that has not yet learned its length keeps its entrance. */
  count?: number
}) {
  // The single decision point for the row-count cap. Past budget the plain
  // branch below passes ONLY `className` — handing motion props to a plain
  // intrinsic tag would leak `initial="hidden"`, `animate="show"` and
  // `variants="[object Object]"` onto the DOM and make React warn.
  const animated = count === undefined || count <= STAGGER_MAX_ITEMS
  const AnimatedTag = motion[as]
  const PlainTag = as as keyof React.JSX.IntrinsicElements
  return (
    <StaggerBudgetContext.Provider value={animated}>
      {animated ? (
        // `initial`/`animate`/`variants` on the parent drive the children:
        // framer propagates variants through React context, so the <tr>
        // children animate without a DOM wrapper (an extra <span> inside
        // <tbody> would be foster-parented out of the table anyway).
        <AnimatedTag className={className} initial="hidden" animate="show" variants={staggerVariants}>
          {children}
        </AnimatedTag>
      ) : (
        // Plain, un-animated element: same class/children, no motion props, so
        // the rows are simply visible immediately and never left at opacity 0.
        <PlainTag className={className}>{children}</PlainTag>
      )}
    </StaggerBudgetContext.Provider>
  )
}

/** Child of <Stagger> — fades/slides in when its parent animates to "show". */
export function StaggerItem({
  children,
  as = "div",
  className,
  onClick,
  onKeyDown,
  onDoubleClick,
  onContextMenu,
  tabIndex,
  role,
  title,
}: {
  children: ReactNode
  as?: StaggerTag
  className?: string
  onClick?: () => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  tabIndex?: number
  role?: string
  title?: string
}) {
  // Past the parent's cap this is a plain, immediately-visible element: no
  // `initial`/`animate`/`variants` at all, so it cannot get stuck at
  // `opacity: 0` waiting for an animation that will never run. Every DOM
  // attribute and className is identical to the animated branch — only the
  // motion wrapper differs.
  const animated = useContext(StaggerBudgetContext)
  if (!animated) {
    const Tag = as as keyof React.JSX.IntrinsicElements
    return (
      <Tag
        className={className}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        tabIndex={tabIndex}
        role={role}
        title={title}
      >
        {children}
      </Tag>
    )
  }
  const MotionTag = motion[as]
  return (
    <MotionTag
      className={className}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      tabIndex={tabIndex}
      role={role}
      title={title}
      variants={staggerItemVariants}
    >
      {children}
    </MotionTag>
  )
}

/** Count-up display for a numeric value (expo-out over ~600ms by default). */
export function AnimatedNumber({
  value,
  durationMs = 600,
}: {
  value: number
  durationMs?: number
}) {
  const mv = useMotionValue(0)
  const rounded = useTransform(mv, (v) => Math.round(v))
  const [display, setDisplay] = useState(0)
  useMotionValueEvent(rounded, "change", (v) => setDisplay(v))
  useEffect(() => {
    const controls = animate(mv, value, { duration: durationMs / 1000, ease: EASE })
    return controls.stop
  }, [value, durationMs, mv])
  return <span className="tabular-nums">{display.toLocaleString()}</span>
}

/** Route-transition wrapper — fade + 8px rise on enter, fade out on exit.
 * Used with <AnimatePresence mode="wait"> in App.tsx. */
export function MotionPage({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}
