import {
  createContext,
  useCallback,
  useContext,
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
  Info,
  AlertTriangle,
  CheckCircle2,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn } from "../lib/utils"

/* ════════════════════════════════════════════════════════════════
 * Button
 * ════════════════════════════════════════════════════════════════ */

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost"
type ButtonSize = "default" | "sm" | "lg" | "icon"

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 cursor-pointer whitespace-nowrap"

const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
  destructive: "bg-danger text-danger-foreground hover:bg-danger/90 shadow-sm",
  outline:
    "border border-input bg-background hover:bg-accent/10 hover:text-accent-foreground",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-secondary hover:text-secondary-foreground",
}

const buttonSizes: Record<ButtonSize, string> = {
  default: "h-10 px-4 py-2 text-sm",
  sm: "h-9 rounded-md px-3 text-xs",
  lg: "h-11 rounded-md px-8 text-base",
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

/* ════════════════════════════════════════════════════════════════
 * Input
 * ════════════════════════════════════════════════════════════════ */

export function Input({
  className,
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
  id,
  "aria-label": ariaLabel,
}: {
  className?: string
  value?: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  autoFocus?: boolean
  id?: string
  "aria-label"?: string
}) {
  return (
    <input
      type={type}
      autoFocus={autoFocus}
      id={id}
      aria-label={ariaLabel}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
        className,
      )}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}

/* ════════════════════════════════════════════════════════════════
 * Textarea (used by bulk import)
 * ════════════════════════════════════════════════════════════════ */

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
        "flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
        className,
      )}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}

/* ════════════════════════════════════════════════════════════════
 * Badge
 * ════════════════════════════════════════════════════════════════ */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning"

const badgeVariants: Record<BadgeVariant, string> = {
  default: "bg-primary/15 text-primary border border-primary/30",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-danger/15 text-danger border border-danger/30",
  outline: "border border-input text-foreground",
  success: "bg-success/15 text-success border border-success/30",
  warning: "bg-warning/15 text-warning border border-warning/30",
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
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
        badgeVariants[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Card
 * ════════════════════════════════════════════════════════════════ */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)}>{children}</div>
}

export function CardTitle({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <h3 className={cn("text-lg font-semibold leading-none tracking-tight", className)}>
      {children}
    </h3>
  )
}

export function CardContent({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return <div className={cn("p-6 pt-0", className)}>{children}</div>
}

/* ════════════════════════════════════════════════════════════════
 * Label
 * ════════════════════════════════════════════════════════════════ */

export function Label({
  children,
  className,
  htmlFor,
}: {
  children: ReactNode
  className?: string
  htmlFor?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("text-sm font-medium leading-none mb-2 block", className)}
    >
      {children}
    </label>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Skeleton
 * ════════════════════════════════════════════════════════════════ */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden="true" />
  )
}

/* ════════════════════════════════════════════════════════════════
 * Dialog  (Radix-backed, a11y: focus trap, escape, restore)
 *
 *   <Dialog open={open} onClose={close} title="Edit" description="...">
 *     {body}
 *   </Dialog>
 * ════════════════════════════════════════════════════════════════ */

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
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            className,
          )}
        >
          <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          {description && (
            <DialogPrimitive.Description className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </DialogPrimitive.Description>
          )}
          <div className="mt-4">{children}</div>
          <DialogPrimitive.Close
            aria-label="Close dialog"
            className={cn(
              "absolute right-4 top-4 rounded-sm opacity-70 transition-opacity",
              "hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "inline-flex h-7 w-7 items-center justify-center",
            )}
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Select  (Radix-backed custom dropdown — NOT native <select>)
 *
 *   <Select
 *     value={filterType}
 *     onChange={(v) => setFilterType(v)}
 *     placeholder="All types"
 *     options={[
 *       { value: "", label: "All types" },
 *       { value: "block", label: "Block" },
 *     ]}
 *   />
 *
 * NOTE: onChange now receives the string value directly (not an event),
 * per the agreed foundation API. Callers using the old event-based
 * signature must update to `onChange={(v) => ...}`.
 * ════════════════════════════════════════════════════════════════ */

export interface SelectOption {
  value: string
  label: string
}

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
          "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
          "[&>span]:line-clamp-1",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder ?? "Select…"}>
          {current?.label ?? placeholder}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-4 w-4 opacity-60" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "relative z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[8rem]",
            "w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg",
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
                className={cn(
                  "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
                  "focus:bg-accent/15 focus:text-accent-foreground",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                )}
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

/* ════════════════════════════════════════════════════════════════
 * Toast system  (Radix Toast + context)
 *
 * Wrap app once:  <ToastProvider> ... </ToastProvider>
 * Render region:  <Toaster />   (place inside provider)
 * Fire a toast:   const { toast } = useToast()
 *                 toast({ title: "Saved", description: "...", variant: "success" })
 *                 // or shorthand: toast("Saved")
 * ════════════════════════════════════════════════════════════════ */

export type ToastVariant = "default" | "success" | "error" | "info"

export interface ToastInput {
  title: string
  description?: string
  variant?: ToastVariant
  /** Override auto-dismiss (ms). Default 4000. */
  duration?: number
}

interface ToastRecord extends Required<Omit<ToastInput, "description">> {
  id: string
  description?: string
}

interface ToastContextValue {
  /** Fire a toast. Accepts a full object or a plain string title. */
  toast: (input: ToastInput | string) => void
  /** Dismiss a specific toast by id. */
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const toastVariantStyles: Record<ToastVariant, { icon: LucideIcon; className: string }> = {
  default: { icon: Info, className: "border-border bg-card text-card-foreground" },
  success: {
    icon: CheckCircle2,
    className: "border-success/40 bg-success/10 text-foreground",
  },
  error: { icon: AlertTriangle, className: "border-danger/40 bg-danger/10 text-foreground" },
  info: { icon: Info, className: "border-info/40 bg-info/10 text-foreground" },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((input: ToastInput | string) => {
    const rec: ToastRecord =
      typeof input === "string"
        ? {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: input,
            variant: "default",
            duration: 4000,
          }
        : {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: input.title,
            description: input.description,
            variant: input.variant ?? "default",
            duration: input.duration ?? 4000,
          }
    setToasts((prev) => [...prev, rec])
  }, [])

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
              className={cn(
                "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-md border p-4 shadow-lg",
                "data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out",
                "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
                "data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
                "transition-transform",
                className,
              )}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="flex-1 space-y-0.5">
                <ToastPrimitive.Title className="text-sm font-semibold">
                  {t.title}
                </ToastPrimitive.Title>
                {t.description && (
                  <ToastPrimitive.Description className="text-xs text-muted-foreground">
                    {t.description}
                  </ToastPrimitive.Description>
                )}
              </div>
              <ToastPrimitive.Close
                aria-label="Dismiss"
                className="rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          )
        })}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-sm" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>")
  }
  return ctx
}

/**
 * Toaster is a no-op component kept for API compatibility.
 * ToastProvider renders the viewport and toast items internally.
 * Mounting <Toaster /> anywhere inside the provider is harmless.
 */
export function Toaster(_props: { toasts?: ToastRecord[]; onDismiss?: (id: string) => void }) {
  return null
}

/* ════════════════════════════════════════════════════════════════
 * ConfirmDialog  (built on Dialog; replaces native confirm())
 *
 *   <ConfirmDialog
 *     open={open}
 *     title="Delete pattern?"
 *     description="This cannot be undone."
 *     confirmLabel="Delete"
 *     variant="destructive"
 *     onConfirm={handleDelete}
 *     onCancel={() => setOpen(false)}
 *   />
 * ════════════════════════════════════════════════════════════════ */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: "default" | "destructive"
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description}>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={variant === "destructive" ? "destructive" : "default"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

/* ════════════════════════════════════════════════════════════════
 * EmptyState
 *
 *   <EmptyState
 *     icon={SearchX}
 *     title="No findings yet"
 *     description="Findings appear here when…"
 *     action={<Button onClick={…}>Refresh</Button>}
 *   />
 * ════════════════════════════════════════════════════════════════ */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-16 text-center",
        className,
      )}
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Icon className="h-7 w-7" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════
 * StatCard
 *
 *   <StatCard
 *     icon={Ban}
 *     label="Block Patterns"
 *     value={counts.block}
 *     tone="danger"
 *     hint="URL patterns to flag"
 *   />
 * ════════════════════════════════════════════════════════════════ */

export type StatTone = "default" | "success" | "warning" | "danger" | "info"

const statToneStyles: Record<StatTone, { iconWrap: string; icon: string }> = {
  default: {
    iconWrap: "bg-secondary text-muted-foreground",
    icon: "text-muted-foreground",
  },
  success: {
    iconWrap: "bg-success/15",
    icon: "text-success",
  },
  warning: {
    iconWrap: "bg-warning/15",
    icon: "text-warning",
  },
  danger: {
    iconWrap: "bg-danger/15",
    icon: "text-danger",
  },
  info: {
    iconWrap: "bg-info/15",
    icon: "text-info",
  },
}

export function StatCard({
  icon: Icon,
  label,
  value,
  tone = "default",
  hint,
  className,
  action,
}: {
  icon: LucideIcon
  label: string
  value: ReactNode
  tone?: StatTone
  hint?: string
  className?: string
  action?: ReactNode
}) {
  const styles = statToneStyles[tone]
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
            <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight">{value}</div>
            {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
          </div>
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
              styles.iconWrap,
            )}
          >
            <Icon className={cn("h-5 w-5", styles.icon)} aria-hidden="true" />
          </div>
        </div>
        {action && <div className="mt-4">{action}</div>}
      </CardContent>
    </Card>
  )
}

/* ════════════════════════════════════════════════════════════════
 * Pagination
 *
 * Full total known:
 *   <Pagination page={0} pageSize={50} total={320} onPageChange={setPage} />
 *
 * Unknown total (graceful degradation — hides page numbers, shows
 * prev/next + range only):
 *   <Pagination page={0} pageSize={50} onPageChange={setPage} hasNext={hasMore} />
 *
 * `page` and `pageSize` are 0-indexed page index and items-per-page.
 * `total` (optional) enables numbered page buttons + jump controls.
 * `hasNext` (optional) enables Next when total is unknown.
 * ════════════════════════════════════════════════════════════════ */

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  hasNext,
  className,
}: {
  /** 0-indexed current page */
  page: number
  /** items per page */
  pageSize: number
  /** optional total item count; when omitted, numbered buttons are hidden */
  total?: number
  onPageChange: (page: number) => void
  /** when total is unknown, Next is enabled iff hasNext is true */
  hasNext?: boolean
  className?: string
}) {
  const hasTotal = typeof total === "number"
  const totalPages = hasTotal ? Math.max(1, Math.ceil(total! / pageSize)) : 0
  const rangeStart = page * pageSize + 1
  const rangeEnd = page * pageSize + pageSize // caller may cap to actual count

  const pageButtons = computePageList(page, totalPages, 5)

  const canPrev = page > 0
  const canNext = hasTotal ? page < totalPages - 1 : !!hasNext

  const go = (p: number) => {
    if (p < 0) return
    if (hasTotal && p > totalPages - 1) return
    onPageChange(p)
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground",
        className,
      )}
      role="navigation"
      aria-label="Pagination"
    >
      <p>
        {hasTotal ? (
          <>
            Showing <span className="font-medium text-foreground">{rangeStart}</span>–
            <span className="font-medium text-foreground">
              {Math.min(rangeEnd, total!)}
            </span>{" "}
            of <span className="font-medium text-foreground">{total}</span>
          </>
        ) : (
          <>
            Showing <span className="font-medium text-foreground">{rangeStart}</span>–
            <span className="font-medium text-foreground">{rangeEnd}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={!canPrev}
          onClick={() => go(0)}
          aria-label="First page"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={!canPrev}
          onClick={() => go(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {hasTotal &&
          pageButtons.map((p, i) =>
            p === "…" ? (
              <span key={`ellipsis-${i}`} className="px-2 text-muted-foreground" aria-hidden>
                …
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="icon"
                className="h-8 w-8 text-xs"
                onClick={() => go(p)}
                aria-label={`Page ${p + 1}`}
                aria-current={p === page ? "page" : undefined}
              >
                {p + 1}
              </Button>
            ),
          )}

        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={!canNext}
          onClick={() => go(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={!canNext}
          onClick={() => go(totalPages - 1)}
          aria-label="Last page"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function computePageList(
  current: number,
  total: number,
  window: number,
): (number | "…")[] {
  if (total <= 1) return total === 1 ? [0] : []
  const pages: (number | "…")[] = []
  const half = Math.floor(window / 2)
  let start = Math.max(0, current - half)
  const end = Math.min(total - 1, start + window - 1)
  start = Math.max(0, end - window + 1)

  if (start > 0) {
    pages.push(0)
    if (start > 1) pages.push("…")
  }
  for (let i = start; i <= end; i++) pages.push(i)
  if (end < total - 1) {
    if (end < total - 2) pages.push("…")
    pages.push(total - 1)
  }
  return pages
}
