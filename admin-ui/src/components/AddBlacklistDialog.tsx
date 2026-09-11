import { useEffect, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { addBaseUrlToBlacklist } from "../api"
import { Button, Dialog, Input, Label, useToast } from "./ui"

/**
 * Reusable "Add Blacklist" dialog. Used from the global header so a blacklist
 * entry can be added from anywhere; mirrors AddPatternDialog.
 */
export function AddBlacklistDialog({
  open,
  onClose,
  onCreated,
  initialValue = "",
}: {
  open: boolean
  onClose: () => void
  /** Called after an entry is successfully added. */
  onCreated?: () => void
  /** Pre-fill the value (e.g. a host from a table row). */
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
      const res = await addBaseUrlToBlacklist(value.trim())
      toast({ title: "Added to blacklist", description: res.added.join(", "), variant: "success" })
      setValue("")
      onClose()
      onCreated?.()
    } catch (e) {
      toast({ title: "Create failed", description: (e as Error).message, variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add blacklist entry">
      <div className="space-y-4">
        <div>
          <Label>URL or IP</Label>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="example.com or 1.2.3.4 — saved as bare host"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate()
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Saved as a bare host, like the Blacklist page add box.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!value.trim() || saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Trigger button that opens the Add Blacklist dialog. */
export function AddBlacklistButton({
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
      Add Blacklist
    </Button>
  )
}
