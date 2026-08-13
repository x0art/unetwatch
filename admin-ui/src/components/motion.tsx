import { useEffect, useState, type ReactNode } from "react"
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

type StaggerTag = "div" | "tbody" | "tr" | "ul"

/** Parent that staggers its <StaggerItem> children into view.
 *
 * `as` defaults to a div; pass `"tbody"` (with `StaggerItem as="tr"`) for
 * table bodies, since a div cannot wrap `<tr>` elements in valid HTML. */
export function Stagger({
  children,
  as = "div",
  className,
}: {
  children: ReactNode
  as?: StaggerTag
  className?: string
}) {
  const Tag = motion[as]
  return (
    <Tag className={className} initial="hidden" animate="show" variants={staggerVariants}>
      {children}
    </Tag>
  )
}

/** Child of <Stagger> — fades/slides in when its parent animates to "show". */
export function StaggerItem({
  children,
  as = "div",
  className,
  onClick,
  title,
}: {
  children: ReactNode
  as?: StaggerTag
  className?: string
  onClick?: () => void
  title?: string
}) {
  const Tag = motion[as]
  return (
    <Tag className={className} onClick={onClick} title={title} variants={staggerItemVariants}>
      {children}
    </Tag>
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
  return <>{display.toLocaleString()}</>
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
