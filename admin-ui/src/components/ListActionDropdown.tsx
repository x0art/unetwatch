import { useCallback, useEffect, useRef, useState, type ComponentType } from "react"
import { createPortal } from "react-dom"
import { Ban, ChevronDown, ShieldCheck } from "lucide-react"
import { addBaseUrlToBlacklist } from "../api"
import { Button, useToast } from "./ui"
import { AddPatternDialog } from "./AddPatternDialog"

/**
 * Strip a URL down to its bare host (FQDN), matching the backend's
 * `normalize_blacklist_value` behaviour.
 */
function hostOf(url: string): string {
  const afterScheme = url.split("://").pop() ?? url
  return afterScheme.split(/[/?#]/)[0] || url
}

/* ── Generic row-actions dropdown ─────────────────────────────────────── */

export interface RowAction {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  /** Colour hint: "destructive" tints the icon red, "success" green. */
  variant?: "default" | "destructive" | "success"
  onClick: () => void
  disabled?: boolean
  /** Draw a divider line above this item (e.g. before Delete). */
  separator?: boolean
}

/**
 * Generic row-level actions dropdown.
 *
 * Each page passes its own set of `RowAction` items — the component handles
 * open/close, backdrop, and keyboard dismissal.
 *
 * @example
 * <RowActionsDropdown actions={[
 *   ...listActions,          // from useListActions(baseUrl)
 *   { key: "check", label: "Check now", icon: Zap, onClick: handleCheck },
 *   { key: "delete", label: "Delete", icon: Trash2, variant: "destructive",
 *     separator: true, onClick: handleDelete },
 * ]} />
 */
export function RowActionsDropdown({ actions }: { actions: RowAction[] }) {
  const [open, setOpen] = useState(false)
  const anyPending = actions.some((a) => a.disabled)
  const anchorRef = useRef<HTMLDivElement>(null)

  return (
    <div className="relative inline-block" ref={anchorRef}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-muted-foreground hover:text-foreground"
        disabled={anyPending}
        onClick={() => setOpen((v) => !v)}
        aria-label="Row actions"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>

      {open && <RowActionsMenu actions={actions} anchorRef={anchorRef} onClose={() => setOpen(false)} />}
    </div>
  )
}

/**
 * Dropdown menu rendered via a React portal to escape any overflow-
 * clipping ancestor (e.g. the DataTable's overflow-x-auto wrapper).
 * Positioned relative to the anchor button using getBoundingClientRect.
 */
function RowActionsMenu({
  actions,
  anchorRef,
  onClose,
}: {
  actions: RowAction[]
  anchorRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [placed, setPlaced] = useState(false)

  // Position the menu below the anchor button, clamped to the viewport.
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const menuW = 208 // w-52 = 13rem = 208px
    const menuH = actions.length * 36 + 8 // approximate height
    let left = rect.right - menuW
    if (left < 4) left = 4
    if (left + menuW > window.innerWidth - 4) left = window.innerWidth - menuW - 4
    // If the menu would overflow the viewport bottom, show it above the anchor.
    let top = rect.bottom + 4
    if (top + menuH > window.innerHeight - 4) {
      top = rect.top - menuH - 4
    }
    // Clamp top so it never goes above the viewport.
    if (top < 4) top = 4
    setPos({ top, left })
    setPlaced(true)
  }, [anchorRef, actions.length])

  // Close on click outside or Escape.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [onClose, anchorRef])

  // Create a container element appended to document.body for the portal.
  const containerRef = useRef<HTMLDivElement | null>(null)
  if (!containerRef.current) {
    const el = document.createElement("div")
    document.body.appendChild(el)
    containerRef.current = el
  }
  useEffect(() => {
    return () => {
      containerRef.current?.remove()
      containerRef.current = null
    }
  }, [])

  if (!containerRef.current || !placed) return null
  return createPortal(
    <div
      ref={menuRef}
      className="pointer-events-auto w-52 rounded-md border border-border bg-popover p-1 shadow-lg"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 100 }}
    >
      {actions.map((action) => {
        const Icon = action.icon
        const colorClass =
          action.variant === "destructive"
            ? "text-destructive"
            : action.variant === "success"
              ? "text-success"
              : "text-muted-foreground"
        return (
          <div key={action.key}>
            {action.separator && <div className="my-1 border-t border-border" />}
            <button
              type="button"
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted ${
                action.variant === "destructive" ? "hover:text-destructive" : ""
              }`}
              onClick={() => {
                onClose()
                action.onClick()
              }}
              disabled={action.disabled}
            >
              <Icon className={`h-3.5 w-3.5 ${colorClass}`} />
              {action.label}
            </button>
          </div>
        )
      })}
    </div>,
    containerRef.current,
  )
}

/* ── Blacklist / Whitelist action factory ──────────────────────────────── */

/**
 * Drop-in cell component: renders a `RowActionsDropdown` with blacklist/
 * whitelist actions plus any page-specific extras.
 *
 * @example
 * // In a column definition:
 * cell: (f) => <ListActionCell baseUrl={f.base_url} extra={[
 *   { key: "delete", label: "Delete", icon: Trash2, variant: "destructive",
 *     separator: true, onClick: () => handleDelete(f) },
 * ]} />
 */
export function ListActionCell({
  baseUrl,
  extra = [],
  onBlacklisted,
}: {
  baseUrl: string
  extra?: RowAction[]
  /** Called after a host is successfully added to the blacklist. */
  onBlacklisted?: (host: string) => void
}) {
  const { actions, dialog } = useListActions(baseUrl, onBlacklisted)
  return (
    <>
      {dialog}
      <RowActionsDropdown actions={[...actions, ...extra]} />
    </>
  )
}

/**
 * Returns pre-built `RowAction` items for blacklist and whitelist,
 * plus an optional dialog node to render (for the whitelist pattern editor).
 *
 * @example
 * const { actions: listActions, dialog } = useListActions(f.base_url)
 * // In JSX:
 * <>{dialog}</>
 * <RowActionsDropdown actions={[...listActions, ...otherActions]} />
 */
export function useListActions(baseUrl: string, onBlacklisted?: (host: string) => void): {
  actions: RowAction[]
  dialog: React.ReactNode
} {
  const { toast } = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const host = hostOf(baseUrl)

  const handleBlacklist = useCallback(async () => {
    setPending(true)
    try {
      const res = await addBaseUrlToBlacklist(baseUrl)
      if (res.added.length > 0) {
        toast({ title: "Added to blacklist", description: host, variant: "success" })
        onBlacklisted?.(host)
      } else {
        toast({ title: "Already on blacklist", description: host, variant: "info" })
      }
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    } finally {
      setPending(false)
    }
  }, [baseUrl, host, toast, onBlacklisted])

  const actions: RowAction[] = [
    {
      key: "blacklist",
      label: "Add to Blacklist",
      icon: Ban,
      variant: "destructive",
      onClick: handleBlacklist,
      disabled: pending,
    },
    {
      key: "whitelist",
      label: "Add to Whitelist",
      icon: ShieldCheck,
      variant: "success",
      onClick: () => setDialogOpen(true),
    },
  ]

  const dialog = (
    <AddPatternDialog
      open={dialogOpen}
      onClose={() => setDialogOpen(false)}
      initialPattern={host}
      initialPatternType="whitelist"
    />
  )

  return { actions, dialog }
}
