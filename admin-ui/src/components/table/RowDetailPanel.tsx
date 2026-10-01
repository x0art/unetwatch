import { useEffect, useRef, useState, type ReactNode } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Copy, X } from "lucide-react"
import { Button, useToast } from "../ui"
import { copyText } from "../../lib/utils"
import { cn } from "../../lib/utils"
import type { ContextMenuItem } from "./types"

/* ════════════════════════════════════════════════════════════════
 * RowDetailPanel (§5.6) — the EventInspectorSidebar idiom, shared.
 *
 * A Radix `Dialog` sheet so focus-trap, Escape and focus-return come
 * free (§7.3): focus moves into the panel on open and returns to the
 * originating row on close. Width is resizable ([360, 720]) and the
 * footer exposes `Copy JSON` plus the row's `rowMenu` items.
 * ================================================================ */

export function RowDetailPanel({
  open,
  onOpenChange,
  title,
  subtitle,
  copyValue,
  items,
  width,
  onWidthChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  subtitle?: ReactNode
  /** Serialized payload for the footer's `Copy JSON` action. */
  copyValue?: string
  items?: ContextMenuItem[]
  width: number
  onWidthChange: (width: number) => void
  children: ReactNode
}) {
  const { toast } = useToast()
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      // The handle is on the LEFT edge, so dragging left grows the panel.
      const next = Math.min(720, Math.max(360, d.startWidth + (d.startX - e.clientX)))
      onWidthChange(Math.round(next))
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(false)
    }
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
    return () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
  }, [dragging, onWidthChange])

  const copyJson = async () => {
    const text = copyValue ?? ""
    const ok = await copyText(text)
    if (ok) toast({ title: "Copied", description: text, variant: "success" })
    else toast({ title: "Copy failed", variant: "error" })
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          style={{ width: `min(100vw, ${width}px)` }}
          className="fixed right-0 top-0 z-[81] flex h-full flex-col border-l border-border bg-card shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out"
        >
          {/* Resize handle — 6px visual, 12px hit strip (§7.5). */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize details panel"
            onPointerDown={(e) => {
              dragRef.current = { startX: e.clientX, startWidth: width }
              setDragging(true)
            }}
            className={cn(
              "absolute -left-1.5 top-0 h-full w-3 cursor-col-resize",
              dragging && "bg-primary/20",
            )}
          />
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Close details">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </header>
          {subtitle && <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{subtitle}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
          <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <Button variant="outline" size="sm" onClick={copyJson}>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy JSON
            </Button>
            {(items ?? []).map((item) => {
              const Icon = item.icon
              return (
                <Button
                  key={item.key}
                  variant={item.variant === "destructive" ? "destructive" : "outline"}
                  size="sm"
                  disabled={item.disabled}
                  onClick={item.onClick}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
                  {item.label}
                </Button>
              )
            })}
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
