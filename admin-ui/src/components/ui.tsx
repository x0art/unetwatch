import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ComponentType,
  type ReactNode,
} from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import * as SelectPrimitive from "@radix-ui/react-select"
import * as ToastPrimitive from "@radix-ui/react-toast"
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  AlertTriangle,
  Info,
  Inbox,
  CheckCircle2,
  Loader2,
  Search,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn, copyText, formatInstant, formatRelativeTime } from "../lib/utils"
import { AnimatedNumber, Stagger, StaggerItem } from "./motion"
import { useZone } from "../contexts/ZoneContext"

/* ────────────────────────────────────────────────────────────────
 * Button — soft: hairline border, rounded corners, subtle shadow,
 * gentle scale on press.
 * ──────────────────────────────────────────────────────────────── */

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost"
type ButtonSize = "default" | "sm" | "lg" | "icon"

const buttonBase =
  "inline-flex items-center justify-center gap-2 border rounded-md text-sm font-medium shadow-sm active:scale-[0.98] transition-[transform,box-shadow,background-color,color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer whitespace-nowrap [&_svg]:shrink-0"

const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90 border-transparent",
  destructive: "bg-danger text-danger-foreground hover:bg-danger/90 border-transparent",
  outline: "bg-card text-foreground hover:bg-muted border-border shadow-none",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70 border-border",
  ghost: "bg-transparent border-transparent shadow-none hover:bg-muted",
}

const buttonSizes: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-8 px-3 text-sm",
  lg: "h-10 px-6 text-sm",
  icon: "h-9 w-9",
}

/**
 * Button — soft: hairline border, rounded corners, subtle shadow,
 * gentle scale on press.
 *
 * Wraps a native `<button>`, so it is Radix-compatible: it spreads every
 * remaining DOM prop and forwards `ref` to the element. That matters for
 * `asChild` triggers (`DropdownMenu`/`Popover`/`Dialog`), which clone this
 * element and inject `ref`, `onPointerDown`, `aria-*` and `data-*` props —
 * all of which are dropped if the component only enumerates a fixed prop set.
 * React 19 treats `ref` as an ordinary prop, so no `forwardRef` wrapper is
 * needed.
 */
export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ref,
  ...props
}: ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant
  size?: ButtonSize
}) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)}
      {...props}
    />
  )
}

/** Shared spinner for "processing" button states. */
export function LoadingIcon({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} aria-hidden="true" />
}
/* ── HeaderStatus — the always-mounted header status slot ───────
 * WHY: mounting a status cue only while a request is in flight inserts a
 * flex item into `PageHeader`'s `flex-wrap` action row, re-wrapping it and
 * shoving the buttons sideways — the reported CLS. The slot below is always
 * rendered and always occupies the same box, so a request coming or going
 * cannot move the controls; only its children change. On narrow viewports it
 * takes a fixed-height line under the controls; at `lg` it joins the control
 * row at a reserved width. The className is one constant string and must
 * NEVER depend on `active` (a conditional class would re-wrap the row).
 * Decorative mirror: the caller owns the announced sentence elsewhere. */
export function HeaderStatus({
  active,
  icon: Icon,
  children,
}: {
  active: boolean
  /** Any icon component that takes a `className` — `LucideIcon` covers the
   *  lucide set; `LoadingIcon` is accepted too so the slot can spin. */
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <span
      className="order-last flex h-5 basis-full items-center gap-1.5 text-xs font-medium text-muted-foreground lg:order-none lg:h-auto lg:basis-auto lg:w-52 lg:min-w-52"
      aria-hidden="true"
    >
      {active && (
        <>
          <Icon className="h-3.5 w-3.5 animate-spin" />
          {children}
        </>
      )}
    </span>
  )
}

/** Notion-style timestamp cell: relative time on top, absolute below.
 * Pass the RAW timestamp (ISO string or epoch-ms) — the component derives
 * both lines, so relative time never parses a lossy locale string. */
export function TimestampCell({ value, className }: { value: string | number; className?: string }) {
  const zone = useZone()
  const ms = typeof value === "number" ? value : Date.parse(value)
  const absolute = Number.isNaN(ms) ? String(value) : formatInstant(value, zone)
  return (
    <span className={cn("block whitespace-nowrap", className)} title={absolute}>
      <span className="block text-foreground">{formatRelativeTime(value)}</span>
      <span className="block font-mono text-xs text-muted-foreground">{absolute}</span>
    </span>
  )
}

export function CopyUrlButton({
  value,
  label,
  className,
  size = "sm",
}: {
  value: string
  label?: string
  className?: string
  size?: "sm" | "icon"
}) {
  const { toast } = useToast()
  const handleCopy = async () => {
    const ok = await copyText(value)
    if (ok) toast({ title: "Copied", description: value, variant: "success" })
    else toast({ title: "Copy failed", variant: "error" })
  }
  return (
    <Button
      variant="ghost"
      size={size}
      onClick={handleCopy}
      className={cn("h-6 w-6 px-0 text-muted-foreground hover:text-foreground", className)}
      aria-label={label ? `Copy ${label}` : "Copy"}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  )
}

/* ── IconButton — the one icon-only control ─────────────────────
 * Absorbs ~14 byte-identical raw `<button>`s (`inline-flex h-6 w-6 … rounded
 * border border-transparent …`) scattered across the pages, plus their
 * `h-7 w-7`/`h-8 w-8` near-misses. Those copies drifted on radius (`rounded`
 * vs `rounded-md`), hover (`bg-muted` vs `bg-secondary`) and focus ring
 * (present on some, absent on others). One primitive makes that impossible.
 *
 * `label` is required and lands on BOTH `aria-label` and `title`, so an
 * icon-only control is never unlabelled and always gets a native tooltip. */
export function IconButton({
  icon: Icon,
  label,
  size = "sm",
  variant = "ghost",
  className,
  type = "button",
  ref,
  ...props
}: Omit<ComponentPropsWithRef<"button">, "children"> & {
  icon: LucideIcon
  label: string
  size?: "sm" | "md" | "lg"
  variant?: "ghost" | "outline" | "danger"
}) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        // `rounded-md` (not the bare `rounded`/4px the raw copies used) per Rule R1.
        "inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
        // Sizes are the control box ONLY; the glyph size comes from the
        // `[&>svg]` rules so callers never hand-pick an icon size.
        size === "sm" && "h-6 w-6 [&>svg]:h-3 [&>svg]:w-3",
        size === "md" && "h-7 w-7 [&>svg]:h-3.5 [&>svg]:w-3.5",
        size === "lg" && "h-8 w-8 [&>svg]:h-4 [&>svg]:w-4",
        variant === "outline" && "border-border bg-card hover:bg-muted",
        variant === "danger" && "hover:bg-danger/10 hover:text-danger",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}

/* ── Input — hairline frame, soft radius ─────────────────────── */

export function Input({
  className,
  value,
  onChange,
  onKeyDown,
  placeholder,
  type = "text",
  autoFocus,
  id,
  name,
  autoComplete,
  "aria-label": ariaLabel,
}: {
  className?: string
  value?: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  autoFocus?: boolean
  id?: string
  name?: string
  autoComplete?: string
  "aria-label"?: string
}) {
  return (
    <input
      type={type}
      autoFocus={autoFocus}
      id={id}
      name={name}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring",
        "disabled:opacity-50",
        className,
      )}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
    />
  )
}

/* ── Badge — soft tint pill, hairline border ─────────────────── */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning"

const badgeVariants: Record<BadgeVariant, string> = {
  default: "bg-muted text-foreground border-border",
  secondary: "bg-secondary text-secondary-foreground border-border",
  destructive: "bg-danger/10 text-danger border-danger/20",
  outline: "bg-card text-foreground border-border",
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/10 text-warning border-warning/20",
}

export function Badge({
  children,
  variant = "default",
  className,
}: {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        badgeVariants[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}
/* ── StatusBadge — the one status pill ──────────────────────────
 * Absorbs every hand-written "coloured pill with a state meaning" plus the
 * six divergent domain→variant mappers. Square-cornered (`rounded-md`, the
 * deliberate exception it shares with `ListBadge`) so it reads as a status
 * chip, not the pill-shaped categorical `Badge`. */

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

/** Per-tone tint. `neutral` falls back to the muted surface so a
 *  "no signal yet" chip still reads as one of the family. */
const statusToneStyles: Record<StatusTone, string> = {
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  danger: "bg-danger/10 text-danger border-danger/20",
  info: "bg-info/10 text-info border-info/20",
  neutral: "bg-muted text-muted-foreground border-border",
}

export function StatusBadge({
  children,
  tone = "neutral",
  dot = false,
  icon: Icon,
  title,
  className,
}: {
  children: ReactNode
  tone?: StatusTone
  dot?: boolean
  icon?: LucideIcon
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        statusToneStyles[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  )
}

export type ListBadgeTone = "warning" | "success" | "danger"

/* `ListBadge` is the icon-first spelling of `StatusBadge` (only three tones).
 * Delegating keeps one className source of truth so the two cannot drift;
 * the public API is unchanged for its existing call sites. */
export function ListBadge({
  tone,
  title,
  icon: Icon,
  children,
}: {
  tone: ListBadgeTone
  title?: string
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <StatusBadge tone={tone} title={title} icon={Icon}>
      {children}
    </StatusBadge>
  )
}

/* ── Card — soft slab ───────────────────────────────────────── */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("overflow-hidden rounded-md border border-border bg-card shadow-sm", className)}>{children}</div>
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col gap-1.5 p-5 border-b border-border", className)}>{children}</div>
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-sm font-semibold tracking-tight", className)}>{children}</h3>
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("p-5", className)}>{children}</div>
}

/* ── Callout — inline error / notice banner ─────────────────────
 * The one row grammar for "something went wrong (or is worth noting)" that
 * sits inline in a page: hairline tinted frame, a flex-1 message and an
 * optional trailing action. Absorbs ~12 hand-rolled banners that had drifted
 * on padding, border opacity (`/20`–`/40`) and colour token (`text-danger`
 * vs `text-destructive`). `danger` keeps `text-destructive` because that is
 * the alias the existing banners used — it resolves to the same token, so
 * the rendered colour is identical. */

export type CalloutTone = "danger" | "warning" | "info" | "success"

/** Per-tone tint. The border is a hairline `/40` and the fill a quiet `/10`
 *  so the banner reads as a tinted surface, not a solid alert slab. */
const calloutToneStyles: Record<CalloutTone, string> = {
  danger: "border-danger/40 bg-danger/10 text-destructive",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-info/40 bg-info/10 text-info",
  success: "border-success/40 bg-success/10 text-success",
}

export function Callout({
  tone = "danger",
  icon: Icon,
  title,
  action,
  children,
  className,
}: {
  tone?: CalloutTone
  icon?: LucideIcon
  title?: ReactNode
  action?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border px-4 py-3 text-xs font-medium",
        calloutToneStyles[tone],
        className,
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {/* `min-w-0` lets a long message truncate/wrap instead of pushing the
          action out of the frame; the flex-1 child is what right-aligns it. */}
      <span className="min-w-0 flex-1">
        {title}
        {children}
      </span>
      {action}
    </div>
  )
}

/* ── Label — mono caps ──────────────────────────────────────── */

export function Label({ children, className, htmlFor }: { children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("mono-label mb-2 block", className)}>
      {children}
    </label>
  )
}

/* ── Skeleton — shimmer ─────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md border border-border bg-muted", className)} aria-hidden="true">
      <div className="skeleton-shimmer absolute inset-0" />
    </div>
  )
}
/* ── TableSkeleton — the grid mirror ─────────────────────────────
 * One entry per RENDERED column (`width` is a Tailwind width class such as
 * "w-28" or "w-[320px]"). The cell is always emitted — `w-24` is the fallback
 * when a column declares no width — because a widthless column used to vanish
 * silently from the skeleton (Analytics identity columns), so the placeholder
 * advertised a narrower table than the real one.
 *
 * The padding values below are a deliberate byte-for-byte mirror of
 * `DENSITY_PAD` in `DataTable.tsx`, which stays module-private (exporting it
 * would add a `react(only-export-components)` warning there and the spec
 * forbids new lint warnings). The two MUST move together — if a density's
 * padding changes in one, change it in the other, or the placeholder stops
 * occupying the real grid's cells. */
const DENSITY_PAD: Record<"comfortable" | "compact", { th: string; td: string }> = {
  comfortable: { th: "px-4 py-3", td: "px-4 py-3" },
  compact: { th: "px-3 py-2", td: "px-3 py-1.5" },
}
export interface TableSkeletonProps {
  /** One entry per rendered column. `width` is a Tailwind width class
   *  (e.g. "w-28", "w-[320px]"); absent ⇒ the primitive picks a stable
   *  default so the cell NEVER vanishes (fixes the Analytics dropped column). */
  columns: Array<{ width?: string }>
  /** Row count. Default: the surface's page size, never the fixed 8. */
  rows?: number
  /** Leading 48px checkbox cell, matching DataTable's select slot. */
  selectable?: boolean
  /** Render a skeleton header row too. Default true. */
  header?: boolean
  /** Density padding; default "comfortable". */
  density?: "comfortable" | "compact"
  className?: string
}

export function TableSkeleton({
  columns,
  rows = 8,
  selectable = false,
  header = true,
  density = "comfortable",
  className,
}: TableSkeletonProps) {
  const pad = DENSITY_PAD[density]
  return (
    <div
      className={cn("overflow-x-auto rounded-md border border-border bg-card shadow-none", className)}
      aria-hidden="true"
    >
      <table className="w-full text-sm" aria-hidden="true">
        {header && (
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {selectable && <th scope="col" className={cn(pad.th, "w-12")} aria-hidden="true" />}
              {columns.map((_, i) => (
                <th key={i} scope="col" className={pad.th} aria-hidden="true">
                  <Skeleton className="h-3.5 w-16" />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} className="border-b border-border last:border-b-0">
              {selectable && (
                <td className={pad.td}>
                  <Skeleton className="h-4 w-4" />
                </td>
              )}
              {columns.map((col, c) => (
                <td key={c} className={pad.td}>
                  <Skeleton className={cn("h-4", col.width ?? "w-24")} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── SkeletonShape — the layout mirror ───────────────────────────
 * A first-load placeholder must occupy the SAME boxes as the content that
 * replaces it; a flat block standing in for a multi-panel surface is the
 * layout jump the user perceives. Each variant therefore mirrors a real
 * component's container + grid + padding, quoting its classNames. Every
 * variant reuses `Skeleton` (so the shimmer, reduced-motion and paused-tab
 * behaviour are inherited), and the whole subtree is `aria-hidden`. */
export type SkeletonVariant =
  | "stat-grid"
  | "chart"
  | "panel-stack"
  | "feed-list"
  | "dag"
  | "edge-list"

export interface SkeletonShapeProps {
  variant: SkeletonVariant
  /** Cards / rows / panels depending on the variant. Default per variant. */
  count?: number
  /** Plot/diagram body height in px for `chart`/`dag`; ignored elsewhere. */
  height?: number
  className?: string
}

export function SkeletonShape({ variant, count, height, className }: SkeletonShapeProps) {
  // Mirrors a `StatCard` row: the `AnalyticsPage` / `HostInspectorPage`
  // wrapper grids. `h-28` ≈ the measured card height at the 5-up breakpoint.
  if (variant === "stat-grid") {
    return (
      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5", className)} aria-hidden="true">
        {Array.from({ length: count ?? 5 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    )
  }

  // Mirrors `TrendCharts`: the plot area plus the axis/legend chrome, not one
  // flat rectangle — `height` is the same ECharts host height (default 260).
  if (variant === "chart") {
    return (
      <div className={cn("relative w-full", className)} style={{ height: height ?? 260 }} aria-hidden="true">
        <div className="mb-3 flex items-center gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-[calc(100%-2.5rem)] w-full" />
        <div className="mt-2 flex items-center justify-between">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-2.5 w-10" />
          ))}
        </div>
      </div>
    )
  }

  // Mirrors a stacked column of titled `Panel`s: each block is a panel frame
  // (header `border-b border-border px-4 py-3`, body `p-4 sm:p-5`) with
  // skeleton lines in place of content. `space-y-5` is the canonical rhythm.
  if (variant === "panel-stack") {
    return (
      <div className={cn("space-y-5", className)} aria-hidden="true">
        {Array.from({ length: count ?? 3 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-3 p-4 sm:p-5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Mirrors the `FeedCard` scrolling list: a `max-h-80` bordered container of
  // one-line `px-3 py-1.5` rows, so the placeholder is the list it becomes.
  if (variant === "feed-list") {
    return (
      <div
        className={cn(
          "divide-y divide-border overflow-hidden rounded-md border border-border bg-muted/30 shadow-sm",
          "max-h-80",
          className,
        )}
        aria-hidden="true"
      >
        {Array.from({ length: count ?? 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5">
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-4 w-4 shrink-0" />
          </div>
        ))}
      </div>
    )
  }

  // Mirrors `NetworkGraphDiagram`: the node/edge silhouette plus the absolute
  // bottom-right zoom-control overlay, inside the same ECharts host height.
  if (variant === "dag") {
    return (
      <div className={cn("relative w-full", className)} style={{ height: height ?? 360 }} aria-hidden="true">
        <div className="flex h-full items-center justify-center gap-6 px-6">
          {Array.from({ length: count ?? 3 }).map((_, col) => (
            <div key={col} className="flex flex-col items-center gap-4">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          ))}
        </div>
        <div className="absolute bottom-3 right-3 flex flex-col gap-1" aria-hidden="true">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
        </div>
      </div>
    )
  }

  // Mirrors the redirect-history drawer: a stack of VARIABLE-height bordered
  // edge cards, not one flat block (the alternating width keeps the list from
  // looking like a grid).
  return (
    <div className={cn("space-y-3", className)} aria-hidden="true">
      {Array.from({ length: count ?? 4 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-md border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
          <div className="mt-3 space-y-2">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className={cn("h-3.5", i % 2 === 0 ? "w-5/6" : "w-2/3")} />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── LoadingIndicator — honest elapsed-time feedback ─────────────
 * Re-exported here so every consumer can reach it from the same module as
 * the rest of the primitives. Additive only: no existing export moves or
 * changes shape. See `components/loading/index.tsx` for the state table. */
export { LoadingIndicator } from "./loading"
export type { LoadingIndicatorProps, LoadingProgress } from "./loading"

/* ── Dialog — soft slab ───────────────────────────────────────── */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-black/40", "data-[state=open]:animate-in data-[state=closed]:animate-out")} />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            className,
          )}
        >
          <div className="p-6">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>}
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{children}</div>
          </div>
          <DialogPrimitive.Close
            aria-label="Close dialog"
            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ── Select — soft trigger + popover ────────────────────────── */

export interface SelectOption { value: string; label: string }

export function Select({
  value,
  onChange,
  options,
  className,
  placeholder,
  id,
  size = "default",
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  className?: string
  placeholder?: string
  id?: string
  size?: "default" | "sm"
  "aria-label"?: string
}) {
  const current = options.find((o) => o.value === value)
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          size === "default"
            ? "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium shadow-sm"
            : "flex h-7 w-full items-center justify-between gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:opacity-50 [&>span]:line-clamp-1",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder ?? "Select..."}>
          {current?.label ?? placeholder}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className={size === "default" ? "h-4 w-4 opacity-70" : "h-3 w-3 opacity-70"} aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={cn(
            "relative z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[8rem] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
          )}
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center">
            <ChevronDown className="h-4 w-4 rotate-180 opacity-60" aria-hidden="true" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none hover:bg-muted focus:bg-muted data-[state=checked]:bg-muted data-[state=checked]:font-medium"
              >
                <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center">
            <ChevronDown className="h-4 w-4 opacity-60" aria-hidden="true" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

const REFRESH_INTERVAL_OPTIONS: SelectOption[] = [
  { value: "0", label: "Auto: off" },
  { value: "30", label: "Auto: 30s" },
  { value: "60", label: "Auto: 1m" },
  { value: "300", label: "Auto: 5m" },
]

export function RefreshIntervalSelect({ value, onChange, className }: { value: number; onChange: (seconds: number) => void; className?: string }) {
  return <Select value={String(value)} onChange={(v) => onChange(Number(v))} options={REFRESH_INTERVAL_OPTIONS} className={cn("w-40", className)} aria-label="Auto-refresh interval" />
}

/* ── Toast — soft slab ────────────────────────────────────────── */

export type ToastVariant = "default" | "success" | "error" | "info"

export interface ToastInput {
  title?: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

interface ToastRecord extends Required<Omit<ToastInput, "description" | "title">> {
  id: string
  title: string
  description?: string
}

interface ToastContextValue {
  toast: (input: ToastInput | string) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const toastVariantStyles: Record<ToastVariant, { icon: LucideIcon; className: string }> = {
  default: { icon: Info, className: "bg-card text-foreground border-border shadow-lg" },
  success: { icon: CheckCircle2, className: "bg-card text-foreground border-success/20 shadow-lg" },
  error: { icon: AlertTriangle, className: "bg-card text-foreground border-danger/20 shadow-lg" },
  info: { icon: Info, className: "bg-card text-foreground border-info/20 shadow-lg" },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())
  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id)
    if (t !== undefined) { window.clearTimeout(t); timersRef.current.delete(id) }
  }, [])
  const dismiss = useCallback((id: string) => { clearTimer(id); setToasts((prev) => prev.filter((t) => t.id !== id)) }, [clearTimer])
  const toast = useCallback((input: ToastInput | string) => {
    const rec: ToastRecord =
      typeof input === "string"
        ? { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: input, variant: "default", duration: 4000 }
        : { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: input.title ?? input.description ?? "NOTICE", description: input.description, variant: input.variant ?? "default", duration: input.duration ?? 4000 }
    clearTimer(rec.id)
    timersRef.current.set(rec.id, window.setTimeout(() => dismiss(rec.id), rec.duration))
    setToasts((prev) => [...prev, rec])
  }, [clearTimer, dismiss])
  useEffect(() => { const timers = timersRef.current; return () => { timers.forEach((t) => window.clearTimeout(t)); timers.clear() } }, [])
  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
        {children}
        {toasts.map((t) => {
          const { icon: Icon, className } = toastVariantStyles[t.variant]
          return (
            <ToastPrimitive.Root
              key={t.id}
              duration={t.duration}
              onOpenChange={(open) => !open && dismiss(t.id)}
              className={cn("group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-md border p-4", "data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out", className)}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="flex-1 space-y-0.5">
                <ToastPrimitive.Title className="text-sm font-medium">{t.title}</ToastPrimitive.Title>
                {t.description && <ToastPrimitive.Description className="text-xs text-muted-foreground">{t.description}</ToastPrimitive.Description>}
              </div>
              <ToastPrimitive.Close aria-label="Dismiss" className="rounded-md p-1 text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <X className="h-4 w-4" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          )
        })}
        <ToastPrimitive.Viewport className="fixed top-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-3 p-4 sm:max-w-sm" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>")
  return ctx
}

/* ── ConfirmDialog ──────────────────────────────────────────── */

export function ConfirmDialog({
  open, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", variant = "default", onConfirm, onCancel,
}: {
  open: boolean; title: string; description?: string; confirmLabel?: string; cancelLabel?: string; variant?: "default" | "destructive"; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description}>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={variant === "destructive" ? "destructive" : "default"} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  )
}

/* ── EmptyState — soft dashed slab ────────────────────────────── */

export function EmptyState({ icon: Icon, title, description, action, className }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("relative flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-card px-6 py-14 text-center overflow-hidden", className)}>
      <div className="relative flex h-12 w-12 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <h3 className="relative mt-4 text-sm font-medium">{title}</h3>
      {description && <p className="relative mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="relative mt-5">{action}</div>}
    </div>
  )
}

/* ── SearchInput ────────────────────────────────────────────── */

export function SearchInput({
  value, onChange, placeholder, className, id, "aria-label": ariaLabel, autoFocus,
}: {
  value: string; onChange: (value: string) => void; placeholder?: string; className?: string; id?: string; "aria-label"?: string; autoFocus?: boolean
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel} autoFocus={autoFocus} className="pl-9 pr-8" />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 border border-transparent p-1 text-muted-foreground hover:text-foreground hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

/* ── PageHeader — clean title + description ──────────────────── */

export function PageHeader({ title, description, children, className }: { title: string; description?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("border-b border-border pb-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
          {description && <p className="mt-1.5 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  )
}

/* ── Toolbar — the one control row ──────────────────────────────
 * One row grammar for the `DataTable` toolbar, `Panel` headers, page-level
 * control rows and the bulk bar. The wrapper class is exactly the string
 * `DataTable` used to inline; the right cluster now lives in the primitive
 * so its gap (`gap-2`, Rule R3) can never drift again. */

export function Toolbar({
  left,
  right,
  className,
  children,
  role = "toolbar",
  "aria-label": ariaLabel,
}: {
  left?: ReactNode
  right?: ReactNode
  className?: string
  children?: ReactNode
  /** `toolbar` by default — the ARIA role for a row of controls. `Panel`
   *  sets `undefined` because its header also carries a heading, and a
   *  heading inside a `toolbar` would be mis-announced. */
  role?: string
  "aria-label"?: string
}) {
  return (
    <div role={role} aria-label={ariaLabel} className={cn("flex flex-wrap items-center gap-2", className)}>
      {left}
      {children}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
}

/* ── Section — a titled section, or a bare stack ────────────────
 * Exists so section spacing is canonical: with a title it is a `Panel`
 * (px-4 py-3 header, p-4 sm:p-5 body); without one it is a `space-y-3`
 * stack. Pages stop inventing their own `space-y-3`/`space-y-4` wrapper. */

export function Section({
  title,
  description,
  icon,
  action,
  children,
  className,
}: {
  title?: string
  description?: string
  icon?: LucideIcon
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  if (!title) return <div className={cn("space-y-3", className)}>{children}</div>
  return (
    <Panel title={title} description={description} icon={icon} action={action} className={className}>
      {children}
    </Panel>
  )
}

/* ── PageShell — PageHeader + the canonical page root ───────────
 * Pairs the two so the root wrapper (`space-y-5`, Rule R3) and the header
 * cannot drift apart. The AppShell already centers at max-w-[1440px], so
 * there is no mx-auto / max-w-* here. */

export function PageShell({
  title,
  description,
  actions,
  toolbar,
  children,
  className,
}: {
  title: string
  description?: string
  actions?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-5", className)}>
      <PageHeader title={title} description={description}>
        {actions}
      </PageHeader>
      {toolbar}
      {children}
    </div>
  )
}

/* ── Panel — soft slab with quiet header ─────────────────────── */

export function Panel({
  title, description, icon: Icon, className, children, action,
}: {
  title?: string; description?: string; icon?: LucideIcon; className?: string; children: ReactNode; action?: ReactNode
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card shadow-sm", className)}>
      {(title || action) && (
        /* The header row is the shared `Toolbar` so its wrapper class
         *  (`flex flex-wrap items-center gap-2`) and right-cluster gap
         *  (`gap-2`) come from one source. `border-b border-border px-4 py-3`
         *  is the Panel-only frame that stays here. `role={undefined}` keeps
         *  the heading out of a `toolbar` landmark — the header is a title
         *  row, not a control cluster. */
        <Toolbar
          role={undefined}
          className="border-b border-border px-4 py-3"
          left={
            <>
              {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
              {title && <h3 className="text-sm font-semibold">{title}</h3>}
            </>
          }
          right={
            description || action ? (
              <>
                {description && <span className="text-xs text-muted-foreground">{description}</span>}
                {action}
              </>
            ) : undefined
          }
        />
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  )
}

/* ── Table chrome — TableFrame / TableHeadRow / TableHeadCell ───
 * The ONE static table chrome. Small (non-grid) tables render inside this
 * so border, radius, background, header tint and density are byte-identical
 * to `DataTable`, which differs only in `shadow-none` + `overflow-x-auto`
 * (Rule R2) because the grid sits inside a `Panel` that already lifts. */

export function TableFrame({
  children,
  className,
  ariaLabel,
  dense = false,
}: {
  children: ReactNode
  className?: string
  ariaLabel?: string
  dense?: boolean
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card shadow-sm", className)}>
      <table className={cn("w-full", dense ? "text-xs" : "text-sm")} aria-label={ariaLabel}>
        {children}
      </table>
    </div>
  )
}

/** Header row helper so no page writes the `<thead>`/tint by hand. */
export function TableHeadRow({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-border bg-muted/50">{children}</tr>
    </thead>
  )
}

export function TableHeadCell({
  children,
  align = "left",
  width,
  dense,
  className,
}: {
  children: ReactNode
  align?: "left" | "right" | "center"
  width?: string
  dense?: boolean
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        "mono-label",
        dense ? "px-3 py-2" : "px-4 py-3",
        align === "right" && "text-right",
        align === "center" && "text-center",
        width,
        className,
      )}
    >
      {children}
    </th>
  )
}

/* ── SimpleTable — the lightweight table ────────────────────────
 * For surfaces too small for the full grid (ranked / indicator / backup):
 * still typed, still framed, but no toolbar, no selection, no pagination.
 * Reuses `Stagger as="tbody"` / `StaggerItem as="tr"` so its row entrance
 * animation is the same one `RankedTable` has always used (and so reduced
 * motion keeps being honored by `MotionGate`). */

export interface SimpleTableColumn<T> {
  id: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  align?: "left" | "center" | "right"
  width?: string
  /** Optional bar cell (rank tables) — a 0..1 fraction rendered as a
   *  `bg-primary/60` progress bar next to the cell content. */
  bar?: (row: T) => number
  className?: string
  /** Optional per-row native tooltip for the `<tr>` (rank lists show the
   *  full label + count here so the truncated cell text stays readable). */
  rowTitle?: (row: T, index: number) => string
}

export function SimpleTable<T>({
  columns,
  data,
  rowKey,
  empty,
  dense = true,
  headDense,
  onRowClick,
  rowTitle,
  ariaLabel,
  className,
}: {
  columns: SimpleTableColumn<T>[]
  data: T[]
  rowKey: (row: T, index: number) => string | number
  empty?: ReactNode
  dense?: boolean
  /** Header padding override, independent of body `dense`. Defaults to
   *  `dense`; `RankedTable` sets `dense={false} headDense` so it keeps
   *  `text-sm` body cells at `px-3 py-2` without inheriting the roomier
   *  `px-4 py-3` header that would inflate its rows (§4.4 / R-4). */
  headDense?: boolean
  rowTitle?: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  ariaLabel?: string
  className?: string
}) {
  const clickable = Boolean(onRowClick)
  return (
    <TableFrame className={className} ariaLabel={ariaLabel} dense={dense}>
      <TableHeadRow>
        {columns.map((col) => (
          <TableHeadCell key={col.id} align={col.align} width={col.width} dense={headDense ?? dense}>
            {col.header}
          </TableHeadCell>
        ))}
      </TableHeadRow>
      {data.length === 0 ? (
        <tbody>
          <tr>
            <td colSpan={columns.length}>
              {/* `border-0` because the frame already draws the border (§4.7). */}
              {empty ?? <EmptyState icon={Inbox} title="No data in window" className="border-0" />}
            </td>
          </tr>
        </tbody>
      ) : (
        <Stagger as="tbody" count={data.length}>
          {data.map((row, index) => {
            const activate = onRowClick ? () => onRowClick(row) : undefined
            return (
              <StaggerItem
                as="tr"
                key={rowKey(row, index)}
                className={cn(
                  // Per-row `border-b` is the canonical body border model
                  // (`divide-y` is the retired loser, §4.1).
                  "border-b border-border transition-colors last:border-b-0",
                  clickable
                    ? "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    : "hover:bg-muted/50",
                )}
                title={rowTitle?.(row, index)}
                onClick={activate}
                // Keyboard parity for the row-as-button idiom.
                onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row) } } : undefined}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
              >
                {columns.map((col) => {
                  const barValue = col.bar?.(row)
                  return (
                    <td
                      key={col.id}
                      className={cn(
                        "px-3 py-2",
                        col.align === "right" && "text-right",
                        col.align === "center" && "text-center",
                        col.className,
                      )}
                    >
                      {barValue === undefined ? (
                        col.cell(row, index)
                      ) : (
                        <div className="flex min-w-0 items-center gap-2">
                          {col.cell(row, index)}
                          <div className="h-1.5 min-w-[32px] flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, Math.max(2, barValue * 100))}%` }} />
                          </div>
                        </div>
                      )}
                    </td>
                  )
                })}
              </StaggerItem>
            )
          })}
        </Stagger>
      )}
    </TableFrame>
  )
}

/* ── RankedTable — clean grid ─────────────────────────────────── */

/** Compact ranked list. Now a thin wrapper over `SimpleTable` so it shares
 *  the frame/header/empty-state chrome; the public API is unchanged. */
export function RankedTable({ rows, className, onRowClick }: { rows: { label: string; count: number }[]; className?: string; onRowClick?: (label: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <SimpleTable
      // `dense={false}` keeps RankedTable's historical `text-sm` body, and
      // `headDense` keeps the header at `px-3 py-2` — the exact `px-3 py-2
      // text-sm` geometry it had before being recomputed on SimpleTable (§4.4 / R-4).
      dense={false}
      headDense
      ariaLabel="Ranked list"
      className={className}
      data={rows}
      // Index+label — a duplicate label alone used to collide React keys.
      rowKey={(r, i) => `${i}-${r.label}`}
      onRowClick={onRowClick ? (r) => onRowClick(r.label) : undefined}
      rowTitle={(r) => `${r.label} — ${r.count.toLocaleString()}`}
      empty={<EmptyState icon={ArrowUpDown} title="No data in window" className="border-0" />}
      columns={[
        {
          id: "rank",
          header: "#",
          width: "w-9",
          cell: (_r, i) => (
            <span className={cn("tabular-nums", i < 3 ? "text-foreground" : "text-muted-foreground")}>
              {String(i + 1).padStart(2, "0")}
            </span>
          ),
        },
        {
          id: "label",
          header: "Label",
          // The bar is a 0..1 fraction of the max; `SimpleTable` renders it.
          bar: (r) => r.count / max,
          cell: (r) => <span className="block max-w-[240px] truncate font-medium">{r.label}</span>,
        },
        {
          id: "count",
          header: "Count",
          align: "right",
          width: "w-20",
          cell: (r) => <span className="font-medium tabular-nums">{r.count.toLocaleString()}</span>,
        },
      ]}
    />
  )
}

/* ── StatCard — soft slab ─────────────────────────────────────── */

export type StatTone = "default" | "success" | "warning" | "danger" | "info"

const statIconTone: Record<StatTone, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  info: "bg-info/10 text-info",
}

export function StatCard({
  icon: Icon, label, value, tone = "default", hint, className, action, onClick,
}: {
  icon: LucideIcon; label: string; value: ReactNode; tone?: StatTone; hint?: string; className?: string; action?: ReactNode; onClick?: () => void
}) {
  const animated = typeof value === "number"
  return (
    <div
      className={cn("overflow-hidden rounded-md border border-border bg-card p-5 shadow-sm", onClick && "cursor-pointer", className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } } : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <div className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{animated ? <AnimatedNumber value={value} /> : value}</div>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", statIconTone[tone])}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>
      {action && <div className="mt-3 border-t border-border pt-3">{action}</div>}
    </div>
  )
}

/* ── Pagination — soft prev/next ─────────────────────────────── */

export function Pagination({
  page, pageSize, total, onPageChange, hasNext, className, onPageSizeChange, pageSizeOptions,
}: {
  page: number; pageSize: number; total?: number; onPageChange: (page: number) => void; hasNext?: boolean; className?: string; onPageSizeChange?: (size: number) => void; pageSizeOptions?: number[]
}) {
  const hasTotal = typeof total === "number"
  const totalPages = hasTotal ? Math.max(1, Math.ceil(total! / pageSize)) : 0
  const rangeStart = page * pageSize + 1
  const rangeEnd = page * pageSize + pageSize
  const pageButtons = computePageList(page, totalPages, 5)
  const canPrev = page > 0
  const canNext = hasTotal ? page < totalPages - 1 : !!hasNext
  const go = (p: number) => { if (p < 0) return; if (hasTotal && p > totalPages - 1) return; onPageChange(p) }
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-3 py-3", className)} role="navigation" aria-label="Pagination">
      <p className="text-sm text-muted-foreground">
        {hasTotal ? (
          <>Showing <span className="font-medium text-foreground tabular-nums">{rangeStart}</span>–<span className="font-medium text-foreground tabular-nums">{Math.min(rangeEnd, total!)}</span> of <span className="font-medium text-foreground tabular-nums">{total}</span></>
        ) : (
          <>Showing <span className="font-medium text-foreground tabular-nums">{rangeStart}</span>–<span className="font-medium text-foreground tabular-nums">{rangeEnd}</span></>
        )}
        {onPageSizeChange && (
          <span className="ml-3">
            <select className="h-7 rounded-md border border-border bg-card px-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} aria-label="Items per page">
              {(pageSizeOptions ?? [25, 50, 100, 200]).map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </span>
        )}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canPrev} onClick={() => go(0)} aria-label="First page"><ChevronsLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canPrev} onClick={() => go(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        {hasTotal && pageButtons.map((p, i) => p === "…" ? <span key={`ellipsis-${i}`} className="px-2 text-xs text-muted-foreground" aria-hidden>…</span> : (
          <Button key={p} variant={p === page ? "default" : "outline"} size="icon" className="h-8 w-8 text-xs" onClick={() => go(p)} aria-label={`Page ${p + 1}`} aria-current={p === page ? "page" : undefined}>{p + 1}</Button>
        ))}
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canNext} onClick={() => go(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
        {hasTotal && <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canNext} onClick={() => go(totalPages - 1)} aria-label="Last page"><ChevronsRight className="h-4 w-4" /></Button>}
      </div>
    </div>
  )
}

function computePageList(current: number, total: number, window: number): (number | "…")[] {
  if (total <= 1) return total === 1 ? [0] : []
  const pages: (number | "…")[] = []
  const half = Math.floor(window / 2)
  let start = Math.max(0, current - half)
  const end = Math.min(total - 1, start + window - 1)
  start = Math.max(0, end - window + 1)
  if (start > 0) { pages.push(0); if (start > 1) pages.push("…") }
  for (let i = start; i <= end; i++) pages.push(i)
  if (end < total - 1) { if (end < total - 2) pages.push("…"); pages.push(total - 1) }
  return pages
}
