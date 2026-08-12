import { useEffect, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { createPattern } from "../api"
import { Button, Dialog, Input, Label, Select, useToast } from "./ui"

const TYPE_OPTIONS = [
  { value: "block", label: "Block" },
  { value: "whitelist", label: "Whitelist" },
]

/**
 * Reusable "Add Pattern" dialog. Used both from the Patterns page toolbar and
 * from the global header so a pattern can be added from anywhere.
 */
export function AddPatternDialog({
  open,
  onClose,
  onCreated,
  initialPattern = "",
  initialPatternType,
}: {
  open: boolean
  onClose: () => void
  /** Called after a pattern is successfully created. */
  onCreated?: () => void
  /** Pre-fill the pattern value (e.g. a host from a URL table row). */
  initialPattern?: string
  /** Pre-select the pattern type. Defaults to "block" when omitted. */
  initialPatternType?: "block" | "whitelist"
}) {
  const { toast } = useToast()
  const [value, setValue] = useState("")
  const [type, setType] = useState(initialPatternType ?? "block")
  const [saving, setSaving] = useState(false)

  // Reset fields each time the dialog opens so initial values are applied.
  useEffect(() => {
    if (open) {
      setValue(initialPattern)
      setType(initialPatternType ?? "block")
    }
  }, [open, initialPattern, initialPatternType])

  const handleCreate = async () => {
    if (!value.trim()) return
    setSaving(true)
    try {
      await createPattern({ pattern: value, pattern_type: type })
      toast({ title: "Pattern created", variant: "success" })
      setValue("")
      setType("block")
      onClose()
      onCreated?.()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add Pattern">
      <div className="space-y-4">
        <div>
          <Label>Pattern</Label>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="*porn*"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate()
            }}
          />
        </div>
        <div>
          <Label>Type</Label>
          <Select value={type} onChange={(v) => setType(v as "block" | "whitelist")} options={TYPE_OPTIONS} />
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

/** Trigger button that opens the Add Pattern dialog. */
export function AddPatternButton({
  onOpen,
  variant = "default",
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
      Add Pattern
    </Button>
  )
}
