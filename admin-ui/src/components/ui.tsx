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
  Search,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn, copyText } from "../lib/utils"
import { AnimatedNumber, Stagger, StaggerItem } from "./motion"

/* ────────────────────────────────────────────────────────────────
 * Button — brutal: 2.5px ink border, hard offset shadow, 0 radius,
 * mono caps, press slams 2px. No soft shadows, no blur.
 * ──────────────────────────────────────────────────────────────── */

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost"
type ButtonSize = "default" | "sm" | "lg" | "icon"

const buttonBase =
  "inline-flex items-center justify-center gap-2 border-[2.5px] border-border font-mono text-xs font-extrabold uppercase tracking-widest brutal-shadow-sm brutal-press transition-[transform,box-shadow,background,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer whitespace-nowrap [&_svg]:shrink-0"

const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-primary text-white hover:brightness-[1.06] border-[#0A0A0A] dark:border-[#F6F2E8]",
  destructive: "bg-danger text-white hover:brightness-[1.06] border-[#0A0A0A] dark:border-[#F6F2E8]",
  outline: "bg-card text-foreground hover:bg-muted border-border shadow-none",
  secondary: "bg-secondary text-[#0A0A0A] hover:brightness-[0.97] border-[#0A0A0A] dark:border-[#F6F2E8]",
  ghost: "bg-transparent border-transparent shadow-none hover:bg-muted hover:border-border hover:brutal-shadow-sm",
}

const buttonSizes: Record<ButtonSize, string> = {
  default: "h-10 px-4 py-2 text-xs",
  sm: "h-8 px-3 text-[11px]",
  lg: "h-11 px-6 text-xs",
  icon: "h-10 w-10",
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
    if (ok) toast({ title: "COPIED", description: value, variant: "success" })
    else toast({ title: "COPY FAILED", variant: "error" })
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

/* ── Input — ink frame, 0 radius, mono when needed ─────────── */

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
        "flex h-10 w-full border-[2.5px] border-border bg-card px-3 py-2 text-sm font-medium",
        "placeholder:text-muted-foreground placeholder:font-normal",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        "flex min-h-[120px] w-full border-[2.5px] border-border bg-card px-3 py-2 text-sm font-mono",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:opacity-50",
        className,
      )}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}

/* ── Badge — STAMP pill, ink border, flat color ─────────────── */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning"

const badgeVariants: Record<BadgeVariant, string> = {
  default: "bg-[#0A0A0A] text-white border-[#0A0A0A] dark:bg-[#F6F2E8] dark:text-[#0A0A0A] dark:border-[#F6F2E8]",
  secondary: "bg-secondary text-[#0A0A0A] border-[#0A0A0A]",
  destructive: "bg-danger text-white border-[#0A0A0A]",
  outline: "bg-card text-foreground border-border",
  success: "bg-[#0A0A0A] text-[#FFD60A] border-[#0A0A0A] dark:bg-[#FFD60A] dark:text-[#0A0A0A] dark:border-[#FFD60A]",
  warning: "bg-secondary text-[#0A0A0A] border-[#0A0A0A]",
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
        "inline-flex items-center border-[2px] px-2 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-widest",
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
        "inline-flex shrink-0 items-center gap-1 border-[2px] border-[#0A0A0A] px-2 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-widest dark:border-[#F6F2E8]",
        tone === "warning" && "bg-secondary text-[#0A0A0A]",
        tone === "success" && "bg-[#0A0A0A] text-[#FFD60A] dark:bg-[#F6F2E8] dark:text-[#0A0A0A]",
        tone === "danger" && "bg-danger text-white",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {children}
    </span>
  )
}

/* ── Card — brutal slab ─────────────────────────────────────── */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("brutal-card", className)}>{children}</div>
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col gap-1.5 p-5 border-b-[2.5px] border-border", className)}>{children}</div>
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("font-display text-sm tracking-tight", className)}>{children}</h3>
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

/* ── Skeleton — hatched ─────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden border-[2px] border-border bg-muted", className)} aria-hidden="true">
      <div className="skeleton-shimmer absolute inset-0" />
    </div>
  )
}

/* ── Dialog — brutal slab + hazard bar ──────────────────────── */

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
        <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-[#0A0A0A]/60 backdrop-blur-[1px]", "data-[state=open]:animate-in data-[state=closed]:animate-out")} />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border-[3px] border-[#0A0A0A] bg-card text-card-foreground brutal-shadow-lg dark:border-[#F6F2E8]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            className,
          )}
        >
          <div className="hazard-bar shrink-0" aria-hidden="true" />
          <div className="p-6">
            <DialogPrimitive.Title className="font-display text-base">{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>}
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{children}</div>
          </div>
          <DialogPrimitive.Close
            aria-label="Close dialog"
            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center border-[2px] border-transparent hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ── Select — brutal trigger + popover ──────────────────────── */

export interface SelectOption { value: string; label: string }

export function Select({
  value,
  onChange,
  options,
  className,
  placeholder,
  id,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  className?: string
  placeholder?: string
  id?: string
  "aria-label"?: string
}) {
  const current = options.find((o) => o.value === value)
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 border-[2.5px] border-border bg-card px-3 py-2 text-sm font-medium brutal-shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:opacity-50 [&>span]:line-clamp-1",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder ?? "Select..."}>
          {current?.label ?? placeholder}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-4 w-4 opacity-70" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={cn(
            "relative z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[8rem] w-[var(--radix-select-trigger-width)] overflow-hidden border-[2.5px] border-[#0A0A0A] bg-card text-card-foreground brutal-shadow dark:border-[#F6F2E8]",
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
                className="relative flex w-full cursor-pointer select-none items-center py-2 pl-8 pr-2 text-sm font-medium outline-none hover:bg-secondary hover:text-[#0A0A0A] data-[state=checked]:bg-[#0A0A0A] data-[state=checked]:text-white dark:data-[state=checked]:bg-[#F6F2E8] dark:data-[state=checked]:text-[#0A0A0A]"
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
  { value: "0", label: "AUTO: OFF" },
  { value: "30", label: "AUTO: 30S" },
  { value: "60", label: "AUTO: 1M" },
  { value: "300", label: "AUTO: 5M" },
]

export function RefreshIntervalSelect({ value, onChange, className }: { value: number; onChange: (seconds: number) => void; className?: string }) {
  return <Select value={String(value)} onChange={(v) => onChange(Number(v))} options={REFRESH_INTERVAL_OPTIONS} className={cn("w-40", className)} aria-label="Auto-refresh interval" />
}

/* ── Toast — brutal slab + stamp color ──────────────────────── */

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
  default: { icon: Info, className: "bg-card text-foreground border-[#0A0A0A] brutal-shadow dark:border-[#F6F2E8]" },
  success: { icon: CheckCircle2, className: "bg-secondary text-[#0A0A0A] border-[#0A0A0A] brutal-shadow" },
  error: { icon: AlertTriangle, className: "bg-danger text-white border-[#0A0A0A] brutal-shadow" },
  info: { icon: Info, className: "bg-info text-white border-[#0A0A0A] brutal-shadow" },
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
              className={cn("group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden border-[2.5px] p-4", "data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out", className)}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="flex-1 space-y-0.5">
                <ToastPrimitive.Title className="font-mono text-xs font-extrabold uppercase tracking-widest">{t.title}</ToastPrimitive.Title>
                {t.description && <ToastPrimitive.Description className="text-xs opacity-80">{t.description}</ToastPrimitive.Description>}
              </div>
              <ToastPrimitive.Close aria-label="Dismiss" className="opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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

export function Toaster(_props: { toasts?: ToastRecord[]; onDismiss?: (id: string) => void }) {
  return null
}

/* ── ConfirmDialog ──────────────────────────────────────────── */

export function ConfirmDialog({
  open, title, description, confirmLabel = "CONFIRM", cancelLabel = "CANCEL", variant = "default", onConfirm, onCancel,
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

/* ── EmptyState — brutal dashed slab + halftone ─────────────── */

export function EmptyState({ icon: Icon, title, description, action, className }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("relative flex flex-col items-center justify-center border-[2.5px] border-dashed border-border bg-card px-6 py-14 text-center overflow-hidden", className)}>
      <div className="halftone absolute inset-0 pointer-events-none" aria-hidden="true" />
      <div className="relative flex h-12 w-12 items-center justify-center border-[2.5px] border-[#0A0A0A] bg-secondary text-[#0A0A0A] brutal-shadow-sm dark:border-[#F6F2E8]">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <h3 className="relative mt-4 font-display text-sm">{title}</h3>
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

/* ── PageHeader — brutal display + mono rule ────────────────── */

export function PageHeader({ title, description, children, className }: { title: string; description?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("border-[2.5px] border-[#0A0A0A] bg-card brutal-shadow p-4 sm:p-5 dark:border-[#F6F2E8]", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 bg-danger border border-[#0A0A0A]" aria-hidden="true" />
            <span className="mono-label">[ {title.toUpperCase()} ]</span>
          </div>
          <h2 className="font-display mt-1 text-[26px] sm:text-[30px]">{title}</h2>
          {description && <p className="mt-1.5 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  )
}

/* ── Panel — brutal slab with mono header + thick rule ──────── */

export function Panel({
  title, description, icon: Icon, className, children, action,
}: {
  title?: string; description?: string; icon?: LucideIcon; className?: string; children: ReactNode; action?: ReactNode
}) {
  return (
    <div className={cn("brutal-card overflow-hidden", className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-center gap-2 border-b-[2.5px] border-border bg-muted/40 px-4 py-3">
          {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
          {title && <h3 className="font-mono text-xs font-extrabold uppercase tracking-widest">{title}</h3>}
          {description && <span className="ml-auto font-mono text-[11px] text-muted-foreground">{description}</span>}
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  )
}

/* ── RankedTable — brutal grid, mono, hazard bar on top row ── */

export function RankedTable({ rows, className, onRowClick }: { rows: { label: string; count: number }[]; className?: string; onRowClick?: (label: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  if (rows.length === 0) return <p className="py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">NO DATA IN WINDOW</p>
  return (
    <div className={cn("overflow-hidden border-[2.5px] border-border bg-card", className)}>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b-[2.5px] border-border bg-[#0A0A0A] text-[#F6F2E8] dark:bg-[#F6F2E8] dark:text-[#0A0A0A]">
            <th className="w-9 px-3 py-2 font-mono text-[11px] font-extrabold uppercase tracking-widest">#</th>
            <th className="px-3 py-2 font-mono text-[11px] font-extrabold uppercase tracking-widest">Label</th>
            <th className="w-20 px-3 py-2 text-right font-mono text-[11px] font-extrabold uppercase tracking-widest">Count</th>
          </tr>
        </thead>
        <Stagger as="tbody" className="divide-y divide-border">
          {rows.map((r, i) => (
            <StaggerItem
              as="tr"
              key={r.label}
              className={cn("transition-colors", onRowClick ? "cursor-pointer hover:bg-secondary/30" : "hover:bg-muted/40")}
              title={`${r.label} — ${r.count.toLocaleString()}`}
              onClick={onRowClick ? () => onRowClick(r.label) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r.label) } } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? "button" : undefined}
            >
              <td className={cn("px-3 py-2 font-mono font-extrabold", i < 3 ? "text-foreground" : "text-muted-foreground")}>{String(i + 1).padStart(2, "0")}</td>
              <td className="px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="block max-w-[240px] truncate font-mono text-xs font-bold">{r.label}</span>
                  <div className="h-2 min-w-[32px] flex-1 overflow-hidden border border-border bg-muted" aria-hidden="true">
                    <div className="h-full bg-[#0A0A0A] dark:bg-[#FFD60A]" style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }} />
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono font-extrabold tabular-nums">{r.count.toLocaleString()}</td>
            </StaggerItem>
          ))}
        </Stagger>
      </table>
    </div>
  )
}

/* ── StatCard — brutal slab, top hazard/ink bar, mono label ─── */

export type StatTone = "default" | "success" | "warning" | "danger" | "info"

const statToneBar: Record<StatTone, string> = {
  default: "bg-[#0A0A0A] dark:bg-[#F6F2E8]",
  success: "bg-[#0A0A0A] dark:bg-[#F6F2E8]",
  warning: "bg-secondary",
  danger: "bg-danger",
  info: "bg-info",
}

export function StatCard({
  icon: Icon, label, value, tone = "default", hint, className, action, onClick,
}: {
  icon: LucideIcon; label: string; value: ReactNode; tone?: StatTone; hint?: string; className?: string; action?: ReactNode; onClick?: () => void
}) {
  const animated = typeof value === "number"
  return (
    <div
      className={cn("brutal-card overflow-hidden", onClick && "cursor-pointer brutal-press", className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick() } } : undefined}
    >
      <div className={cn("h-1.5 w-full border-b-[2.5px] border-border", statToneBar[tone])} aria-hidden="true" />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mono-label truncate">[ {label.toUpperCase()} ]</p>
            <div className="mt-2 font-display text-[30px] leading-none">{animated ? <AnimatedNumber value={value} /> : value}</div>
            {hint && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{hint}</p>}
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center border-[2.5px] border-[#0A0A0A] bg-card brutal-shadow-sm dark:border-[#F6F2E8]">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>
        {action && <div className="mt-3 border-t-[2px] border-border pt-3">{action}</div>}
      </div>
    </div>
  )
}

/* ── Pagination — brutal prev/next + page stamps ────────────── */

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
    <div className={cn("flex flex-wrap items-center justify-between gap-3 border-t-[2.5px] border-border bg-card px-3 py-3", className)} role="navigation" aria-label="Pagination">
      <p className="font-mono text-xs font-bold uppercase tracking-widest">
        {hasTotal ? (
          <>SHOWING <span className="bg-[#0A0A0A] px-1.5 py-0.5 text-white dark:bg-[#F6F2E8] dark:text-[#0A0A0A]">{rangeStart}</span>–<span className="bg-[#0A0A0A] px-1.5 py-0.5 text-white dark:bg-[#F6F2E8] dark:text-[#0A0A0A]">{Math.min(rangeEnd, total!)}</span> OF <span className="bg-secondary px-1.5 py-0.5 text-[#0A0A0A] border border-[#0A0A0A]">{total}</span></>
        ) : (
          <>SHOWING <span className="bg-[#0A0A0A] px-1.5 py-0.5 text-white dark:bg-[#F6F2E8] dark:text-[#0A0A0A]">{rangeStart}</span>–<span className="bg-[#0A0A0A] px-1.5 py-0.5 text-white dark:bg-[#F6F2E8] dark:text-[#0A0A0A]">{rangeEnd}</span></>
        )}
        {onPageSizeChange && (
          <span className="ml-3">
            <select className="h-7 border-[2px] border-border bg-card px-1.5 font-mono text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} aria-label="Items per page">
              {(pageSizeOptions ?? [25, 50, 100, 200]).map((n) => <option key={n} value={n}>{n} / PAGE</option>)}
            </select>
          </span>
        )}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canPrev} onClick={() => go(0)} aria-label="First page"><ChevronsLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="icon" className="h-8 w-8" disabled={!canPrev} onClick={() => go(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        {hasTotal && pageButtons.map((p, i) => p === "…" ? <span key={`ellipsis-${i}`} className="px-2 font-mono text-xs" aria-hidden>…</span> : (
          <Button key={p} variant={p === page ? "default" : "outline"} size="icon" className="h-8 w-8 font-mono text-xs" onClick={() => go(p)} aria-label={`Page ${p + 1}`} aria-current={p === page ? "page" : undefined}>{p + 1}</Button>
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
