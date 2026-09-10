import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import * as SelectPrimitive from "@radix-ui/react-select"
import * as ToastPrimitive from "@radix-ui/react-toast"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Info,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Search,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn, copyText } from "../lib/utils"
import { AnimatedNumber, Stagger, StaggerItem } from "./motion"

/* ────────────────────────────────────────────────────────────────
 * Button — soft: hairline border, rounded corners, subtle shadow,
 * gentle scale on press.
 * ──────────────────────────────────────────────────────────────── */

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost"
type ButtonSize = "default" | "sm" | "lg" | "icon"

const buttonBase =
  "inline-flex items-center justify-center gap-2 border rounded-md text-sm font-medium shadow-sm active:scale-[0.98] transition-[transform,box-shadow,background-color,color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer whitespace-nowrap [&_svg]:shrink-0"

const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-primary text-white hover:bg-primary/90 border-transparent",
  destructive: "bg-danger text-white hover:bg-danger/90 border-transparent",
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

export function Button({
  className,
  variant = "default",
  size = "default",
  disabled,
  onClick,
  children,
  type = "button",
  "aria-label": ariaLabel,
}: {
  className?: string
  variant?: ButtonVariant
  size?: ButtonSize
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  type?: "button" | "submit"
  "aria-label"?: string
}) {
  return (
    <button
      type={type}
      className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )
}

/** Shared spinner for "processing" button states. */
export function LoadingIcon({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} aria-hidden="true" />
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

export function Textarea({
  className,
  value,
  onChange,
  placeholder,
  id,
  "aria-label": ariaLabel,
}: {
  className?: string
  value?: string
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  id?: string
  "aria-label"?: string
}) {
  return (
    <textarea
      id={id}
      aria-label={ariaLabel}
      className={cn(
        "flex min-h-[120px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring",
        "disabled:opacity-50",
        className,
      )}
      value={value}
      onChange={onChange}
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

export type ListBadgeTone = "warning" | "success" | "danger"

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
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        tone === "warning" && "bg-warning/10 text-warning border-warning/20",
        tone === "success" && "bg-success/10 text-success border-success/20",
        tone === "danger" && "bg-danger/10 text-danger border-danger/20",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {children}
    </span>
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
              className={cn("group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border p-4", "data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out", className)}
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
    <div className={cn("relative flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-14 text-center overflow-hidden", className)}>
      <div className="relative flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
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

/* ── Panel — soft slab with quiet header ─────────────────────── */

export function Panel({
  title, description, icon: Icon, className, children, action,
}: {
  title?: string; description?: string; icon?: LucideIcon; className?: string; children: ReactNode; action?: ReactNode
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card shadow-sm", className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          {title && <h3 className="text-sm font-semibold">{title}</h3>}
          {description && <span className="ml-auto text-xs text-muted-foreground">{description}</span>}
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  )
}

/* ── RankedTable — clean grid ─────────────────────────────────── */

export function RankedTable({ rows, className, onRowClick }: { rows: { label: string; count: number }[]; className?: string; onRowClick?: (label: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No data in window</p>
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="w-9 px-3 py-2 text-left text-xs font-medium text-muted-foreground">#</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Label</th>
            <th className="w-20 px-3 py-2 text-right text-xs font-medium text-muted-foreground">Count</th>
          </tr>
        </thead>
        <Stagger as="tbody" className="divide-y divide-border">
          {rows.map((r, i) => (
            <StaggerItem
              as="tr"
              key={r.label}
              className={cn("transition-colors", onRowClick ? "cursor-pointer hover:bg-muted/60" : "hover:bg-muted/40")}
              title={`${r.label} — ${r.count.toLocaleString()}`}
              onClick={onRowClick ? () => onRowClick(r.label) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r.label) } } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? "button" : undefined}
            >
              <td className={cn("px-3 py-2 text-muted-foreground", i < 3 ? "text-foreground" : "")}>{String(i + 1).padStart(2, "0")}</td>
              <td className="px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="block max-w-[240px] truncate font-medium">{r.label}</span>
                  <div className="h-1.5 min-w-[32px] flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }} />
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{r.count.toLocaleString()}</td>
            </StaggerItem>
          ))}
        </Stagger>
      </table>
    </div>
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
          <>Showing <span className="font-medium text-foreground">{rangeStart}</span>–<span className="font-medium text-foreground">{Math.min(rangeEnd, total!)}</span> of <span className="font-medium text-foreground">{total}</span></>
        ) : (
          <>Showing <span className="font-medium text-foreground">{rangeStart}</span>–<span className="font-medium text-foreground">{rangeEnd}</span></>
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
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canNext} onClick={() => go(totalPages - 1)} aria-label="Last page"><ChevronsRight className="h-4 w-4" /></Button>
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
