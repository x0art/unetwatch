import { type ReactNode } from "react"

export function Button({
  className = "",
  variant = "default",
  size = "default",
  disabled,
  onClick,
  children,
  type = "button",
}: {
  className?: string
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost"
  size?: "default" | "sm" | "lg" | "icon"
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  type?: "button" | "submit"
}) {
  const base = "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer"
  const variants: Record<string, string> = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    ghost: "hover:bg-accent hover:text-accent-foreground",
  }
  const sizes: Record<string, string> = {
    default: "h-10 px-4 py-2 text-sm",
    sm: "h-9 rounded-md px-3 text-xs",
    lg: "h-11 rounded-md px-8 text-base",
    icon: "h-10 w-10",
  }
  return (
    <button
      type={type}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function Input({
  className = "",
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
}: {
  className?: string
  value?: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  autoFocus?: boolean
}) {
  return (
    <input
      type={type}
      autoFocus={autoFocus}
      className={`flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}

export function Badge({
  children,
  variant = "default",
}: {
  children: ReactNode
  variant?: "default" | "secondary" | "destructive" | "outline"
}) {
  const variants: Record<string, string> = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    destructive: "bg-destructive text-destructive-foreground",
    outline: "border border-input text-foreground",
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors ${variants[variant]}`}>
      {children}
    </span>
  )
}

export function Card({
  className = "",
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`rounded-lg border border-border bg-card text-card-foreground shadow-sm ${className}`}>
      {children}
    </div>
  )
}

export function CardHeader({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`flex flex-col space-y-1.5 p-6 ${className}`}>{children}</div>
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h3 className={`text-2xl font-semibold leading-none tracking-tight ${className}`}>{children}</h3>
}

export function CardContent({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`p-6 pt-0 ${className}`}>{children}</div>
}

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Select({
  value,
  onChange,
  options,
  className = "",
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <select
      className={`flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      value={value}
      onChange={onChange}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="text-sm font-medium leading-none mb-2 block">{children}</label>
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />
}

export function Toaster({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm shadow-lg animate-in slide-in-from-bottom-2">
      {message}
    </div>
  )
}