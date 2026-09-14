import { useEffect, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { addClientIpToJaillist } from "../api"
import { Button, Dialog, Input, Label, useToast } from "./ui"

/**
 * Reusable "Add Jail" dialog. Used from the global header so a jaillist
 * entry can be added from anywhere; mirrors AddBlacklistDialog.
 */
export function AddJaillistDialog({
  open,
  onClose,
  onCreated,
  initialValue = "",
}: {
  open: boolean
  onClose: () => void
  /** Called after an entry is successfully added. */
  onCreated?: () => void
  /** Pre-fill the value (e.g. a client IP from a table row). */
  initialValue?: string
}) {
  const { toast } = useToast()
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  // Reset the field each time the dialog opens so the initial value applies.
  useEffect(() => {
    if (open) {
      setValue(initialValue)
    }
  }, [open, initialValue])

  const handleCreate = async () => {
    if (!value.trim()) return
    setSaving(true)
    try {
      const res = await addClientIpToJaillist(value.trim())
      toast({ title: "Client IP jailed", description: res.added.join(", "), variant: "success" })
      setValue("")
      onClose()
      onCreated?.()
    } catch (e) {
      toast({ title: "Jail failed", description: (e as Error).message, variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Jail client IP">
      <div className="space-y-4">
        <div>
          <Label>Client IP</Label>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="1.2.3.4"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate()
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Jailed as a single IP, like the Jaillist page add box.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!value.trim() || saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Jail
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Trigger button that opens the Add Jail dialog. */
export function AddJaillistButton({
  onOpen,
  variant = "outline",
  size = "default",
  className,
}: {
  onOpen: () => void
  variant?: "default" | "outline" | "ghost"
  size?: "default" | "sm" | "icon"
  className?: string
}) {
  return (
    <Button variant={variant} size={size} onClick={onOpen} className={className}>
      <Plus className="h-4 w-4" />
      Add Jail
    </Button>
  )
}
