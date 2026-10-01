import { useEffect, useRef } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Columns3, GripVertical, Lock } from "lucide-react"
import { Button } from "../ui"
import { cn } from "../../lib/utils"
import type { ColumnSlot, DataTableColumnLike } from "./types"

/* ════════════════════════════════════════════════════════════════
 * ColumnChooser (§5.7) — checkbox list with drag-reorder.
 *
 * A Radix `Popover` so focus-trap + Escape come free (§7.3): on open the
 * first row checkbox takes focus, Escape closes and returns focus to the
 * trigger. `hideable:false` columns render as locked rows and are excluded
 * from reorder.
 * ================================================================ */

interface ChooserRow<T> {
  col: DataTableColumnLike<T>
  slot?: ColumnSlot
  hideable: boolean
  reorderable: boolean
  visible: boolean
}

export function ColumnChooser<T>({
  rows,
  onToggle,
  onReorder,
  onReset,
  className,
}: {
  rows: ChooserRow<T>[]
  onToggle: (id: string, visible: boolean) => void
  onReorder: (order: string[]) => void
  onReset: () => void
  className?: string
}) {
  const dragId = useRef<string | null>(null)
  const firstRef = useRef<HTMLInputElement>(null)

  // Focus the first checkbox on open without stealing scroll (§7.3).
  useEffect(() => {
    const id = window.setTimeout(() => firstRef.current?.focus({ preventScroll: true }), 0)
    return () => window.clearTimeout(id)
  }, [])

  const handleDrop = (targetId: string) => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const ids = rows.filter((r) => r.reorderable).map((r) => r.col.id)
    const fromIdx = ids.indexOf(from)
    const toIdx = ids.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...ids]
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, from)
    onReorder(next)
  }

  const unslotted = rows.some((r) => !r.slot)

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 px-2.5", className)} aria-label="Choose columns">
          <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Columns</span>
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label="Choose columns"
          className={cn(
            "z-[70] w-64 rounded-md border border-border bg-card p-3 text-left shadow-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
          )}
        >
          <p className="mono-label mb-2">Columns</p>
          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
            {rows.map((row, i) => {
              const locked = !row.hideable
              const draggable = row.reorderable
              return (
                <li
                  key={row.col.id}
                  draggable={draggable}
                  onDragStart={() => {
                    dragId.current = row.col.id
                  }}
                  onDragOver={(e) => {
                    if (draggable) e.preventDefault()
                  }}
                  onDrop={() => handleDrop(row.col.id)}
                  className={cn(
                    "flex items-center gap-2 rounded px-1.5 py-1.5 text-sm",
                    draggable && "cursor-grab active:cursor-grabbing",
                    locked && "opacity-60",
                  )}
                >
                  <GripVertical
                    className={cn("h-3.5 w-3.5 shrink-0", draggable ? "text-muted-foreground" : "text-transparent")}
                    aria-hidden="true"
                  />
                  <input
                    ref={i === 0 ? firstRef : undefined}
                    type="checkbox"
                    className="h-4 w-4 shrink-0 cursor-pointer border border-border bg-card text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                    checked={row.visible}
                    disabled={locked}
                    onChange={(e) => onToggle(row.col.id, e.target.checked)}
                    aria-label={`Show ${String(row.col.header)}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {row.col.header}
                    {!row.slot && <span className="ml-1 text-xs text-muted-foreground">(Unslotted)</span>}
                  </span>
                  {locked && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </li>
              )
            })}
          </ul>
          {unslotted && (
            <p className="mt-2 text-xs text-muted-foreground">
              Columns without a slot keep their declared order and sink to the end.
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onReset}>
              Reset
            </Button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
