import { useCallback, useState, type ComponentType } from "react"
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

  return (
    <div className="relative inline-block">
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

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-52 rounded-md border border-border bg-popover p-1 shadow-lg">
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
                      setOpen(false)
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
          </div>
        </>
      )}
    </div>
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
