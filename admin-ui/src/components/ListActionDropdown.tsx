import { useCallback, useState } from "react"
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

/**
 * Compact row-level action dropdown for URL table rows.
 *
 * Offers two actions:
 *   - Add host to Blacklist (fires immediately)
 *   - Whitelist this host… (opens AddPatternDialog prefilled with the host)
 */
export function ListActionDropdown({ baseUrl }: { baseUrl: string }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const host = hostOf(baseUrl)

  const handleBlacklist = useCallback(async () => {
    setOpen(false)
    setPending(true)
    try {
      const res = await addBaseUrlToBlacklist(baseUrl)
      if (res.added.length > 0) {
        toast({ title: "Added to blacklist", description: host, variant: "success" })
      } else {
        toast({ title: "Already on blacklist", description: host, variant: "info" })
      }
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    } finally {
      setPending(false)
    }
  }, [baseUrl, host, toast])

  const handleWhitelist = useCallback(() => {
    setOpen(false)
    setDialogOpen(true)
  }, [])

  return (
    <>
      <div className="relative inline-block">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-1.5 text-muted-foreground hover:text-foreground"
          disabled={pending}
          onClick={() => setOpen((v) => !v)}
          aria-label="List actions"
        >
          <Ban className="h-3.5 w-3.5" />
          <ChevronDown className="h-3 w-3" />
        </Button>

        {open && (
          <>
            {/* Backdrop to close on outside click */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 z-50 mt-1 w-52 rounded-md border border-border bg-popover p-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted"
                onClick={handleBlacklist}
                disabled={pending}
              >
                <Ban className="h-3.5 w-3.5 text-destructive" />
                Add host to Blacklist
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted"
                onClick={handleWhitelist}
              >
                <ShieldCheck className="h-3.5 w-3.5 text-success" />
                Whitelist this host…
              </button>
            </div>
          </>
        )}
      </div>

      <AddPatternDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        initialPattern={host}
        initialPatternType="whitelist"
      />
    </>
  )
}
