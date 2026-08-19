import { useCallback, useMemo, useState } from "react"
import { Ban, CheckCircle2, Loader2, Pencil, Trash2 } from "lucide-react"
import { bulkAddBlacklist } from "../api"
import { Button, Card, CardContent, Input, useToast } from "./ui"

/**
 * Standalone confirmation page for bulk-adding domains / IPs to the blacklist.
 *
 * Access via: /blockDomain?url=domain1.tld,domain2.tld,ip1,ip2
 *
 * The user can review, edit, or delete individual entries before confirming
 * the bulk-add. Must be logged in — handled by App.tsx auth gating.
 */
export function BlockDomainPage() {
  const { toast } = useToast()

  // Parse comma-separated values from the `url` query parameter
  const initialItems = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get("url") ?? ""
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }, [])

  const [items, setItems] = useState<string[]>(initialItems)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editValue, setEditValue] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<{
    added: number
    skipped: number
    errors: number
  } | null>(null)

  /* ── Editing ──────────────────────────────────────────────────── */

  const startEdit = (idx: number) => {
    setEditingIdx(idx)
    setEditValue(items[idx])
  }

  const cancelEdit = () => {
    setEditingIdx(null)
    setEditValue("")
  }

  const saveEdit = () => {
    const trimmed = editValue.trim()
    if (editingIdx === null || !trimmed) return
    setItems((prev) => prev.map((v, i) => (i === editingIdx ? trimmed : v)))
    setEditingIdx(null)
    setEditValue("")
  }

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      saveEdit()
    } else if (e.key === "Escape") {
      cancelEdit()
    }
  }

  /* ── Submit ───────────────────────────────────────────────────── */

  const handleSubmit = useCallback(async () => {
    if (items.length === 0) return
    setSubmitting(true)
    try {
      const res = await bulkAddBlacklist(items)
      setResult({
        added: res.added.length,
        skipped: res.skipped.length,
        errors: res.errors.length,
      })
      setSubmitted(true)
      const parts: string[] = []
      if (res.added.length) parts.push(`${res.added.length} added`)
      if (res.skipped.length) parts.push(`${res.skipped.length} already present`)
      if (res.errors.length) parts.push(`${res.errors.length} invalid`)
      toast({
        title: "Blacklist updated",
        description: parts.join(" · ") || "Nothing to add",
        variant: res.errors.length ? "error" : "success",
      })
    } catch (e) {
      toast({
        title: "Failed to add to blacklist",
        description: (e as Error).message,
        variant: "error",
      })
    } finally {
      setSubmitting(false)
    }
  }, [items, toast])

  /* ── Empty state ──────────────────────────────────────────────── */

  if (initialItems.length === 0) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="space-y-4 py-12">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <Ban className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">No entries provided</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Append a <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">url</code> query
                parameter with comma-separated domains or IPs.
              </p>
            </div>
            <code className="block rounded-lg bg-muted px-4 py-3 text-left text-xs font-mono text-muted-foreground">
              /blockDomain?url=example.com,1.2.3.4
            </code>
          </CardContent>
        </Card>
      </div>
    )
  }

  /* ── Result screen ────────────────────────────────────────────── */

  if (submitted && result) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="space-y-6 py-12">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-7 w-7 text-success" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Blacklist updated</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your entries have been processed.
              </p>
            </div>
            <div className="flex justify-center gap-6 text-sm">
              {result.added > 0 && (
                <div>
                  <p className="text-2xl font-bold text-success">{result.added}</p>
                  <p className="text-muted-foreground">Added</p>
                </div>
              )}
              {result.skipped > 0 && (
                <div>
                  <p className="text-2xl font-bold text-warning">{result.skipped}</p>
                  <p className="text-muted-foreground">Skipped</p>
                </div>
              )}
              {result.errors > 0 && (
                <div>
                  <p className="text-2xl font-bold text-danger">{result.errors}</p>
                  <p className="text-muted-foreground">Errors</p>
                </div>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => {
                window.location.href = "/"
              }}
            >
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  /* ── Main review table ────────────────────────────────────────── */

  return (
    <div className="flex min-h-dvh items-start justify-center bg-background px-4 py-10 sm:py-16">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="space-y-1 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15">
            <Ban className="h-7 w-7 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Confirm Blacklist Add</h1>
          <p className="text-sm text-muted-foreground">
            Review the entries below. Edit or remove any before confirming.
          </p>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                    <th className="w-12 px-4 py-3 text-center text-xs font-medium">#</th>
                    <th className="px-4 py-3 text-xs font-medium">Value</th>
                    <th className="w-24 px-4 py-3 text-right text-xs font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((item, idx) => {
                    const isEditing = editingIdx === idx
                    return (
                      <tr
                        key={`${idx}-${item}`}
                        className="transition-colors hover:bg-muted/20"
                      >
                        <td className="px-4 py-2.5 text-center text-xs tabular-nums text-muted-foreground">
                          {idx + 1}
                        </td>
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <Input
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={handleKeyDown}
                              autoFocus
                              className="h-8 font-mono text-xs"
                            />
                          ) : (
                            <span className="block truncate font-mono text-xs" title={item}>
                              {item}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {isEditing ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={saveEdit}
                                className="h-7 px-2 text-xs"
                              >
                                Save
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={cancelEdit}
                                className="h-7 px-2 text-xs"
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => startEdit(idx)}
                                aria-label={`Edit ${item}`}
                                className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeItem(idx)}
                                aria-label={`Remove ${item}`}
                                className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex flex-col items-center gap-3">
          <Button
            onClick={handleSubmit}
            disabled={items.length === 0 || submitting}
            className="w-full max-w-xs"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Confirm Add ({items.length} {items.length === 1 ? "entry" : "entries"})
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            {items.length} {items.length === 1 ? "entry" : "entries"} will be added to the blacklist
          </p>
        </div>
      </div>
    </div>
  )
}
