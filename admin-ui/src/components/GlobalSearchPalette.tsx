import * as DialogPrimitive from "@radix-ui/react-dialog"
import { useCallback, useEffect, useState } from "react"
import { Globe, ListFilter, Radar, ScrollText, Search, Users } from "lucide-react"
import { cn } from "../lib/utils"
import { useFilter } from "../contexts/FilterContext"
import { Input } from "./ui"
import type { View } from "./Sidebar"

export type PaletteTarget = "host" | "url" | "patterns" | "findings" | "logs"

const TARGETS: { key: PaletteTarget; label: string; hint: string; icon: typeof Users }[] = [
  { key: "host", label: "Host", hint: "client IP", icon: Users },
  { key: "url", label: "URL", hint: "investigate a URL", icon: Globe },
  { key: "patterns", label: "Patterns", hint: "find patterns", icon: ListFilter },
  { key: "findings", label: "Findings", hint: "risk rows", icon: Radar },
  { key: "logs", label: "Logs", hint: "audit trail", icon: ScrollText },
]

const VIEW_BY_TARGET: Record<PaletteTarget, View> = {
  host: "host",
  url: "url",
  patterns: "patterns",
  findings: "findings",
  logs: "logs",
}

export function GlobalSearchPalette({
  open,
  onOpenChange,
  onNavigate,
  onFindingsSearch,
  onPatternSearch,
  onLogsSearch,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onNavigate: (view: View) => void
  onFindingsSearch: (q: string) => void
  onPatternSearch: (q: string) => void
  onLogsSearch: (q: string) => void
}) {
  const { setGlobalFilter } = useFilter()
  const [query, setQuery] = useState("")
  const [target, setTarget] = useState<PaletteTarget>("host")

  // Reset the query on open.
  useEffect(() => {
    if (open) {
      setQuery("")
      setTarget("host")
    }
  }, [open])

  const submit = useCallback(() => {
    const q = query.trim()
    const view = VIEW_BY_TARGET[target]
    // Navigate first, then apply the target search. handleNavigate resets the
    // findings filter on navigation, so the search must land AFTER it (React
    // batches both, so the final state is correct).
    onNavigate(view)
    // Host / URL apply the query through the shared global filter so those
    // pages react; the others get their own external-search sync.
    if (target === "host" || target === "url") {
      setGlobalFilter(q)
    } else if (target === "findings") {
      onFindingsSearch(q)
    } else if (target === "patterns") {
      onPatternSearch(q)
    } else if (target === "logs") {
      onLogsSearch(q)
    }
    onOpenChange(false)
  }, [query, target, setGlobalFilter, onNavigate, onFindingsSearch, onPatternSearch, onLogsSearch, onOpenChange])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      submit()
    }
    // Arrow keys cycle the target chips.
    if (e.key === "ArrowRight") {
      e.preventDefault()
      setTarget((t) => TARGETS[(TARGETS.findIndex((x) => x.key === t) + 1) % TARGETS.length].key)
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      setTarget((t) => TARGETS[(TARGETS.findIndex((x) => x.key === t) - 1 + TARGETS.length) % TARGETS.length].key)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#0A0A0A]/60 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[22vh] z-50 w-[min(92vw,560px)] -translate-x-1/2">
          <div className="brutal-card overflow-hidden bg-card shadow-xl">
            <div className="flex items-center gap-2 border-b-[2.5px] border-border px-4 py-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search: client IP, URL, pattern, finding…  (⏎ to go)"
                className="flex-1 border-0 bg-transparent font-mono text-sm focus-visible:ring-0"
                aria-label="Global search"
                autoFocus
              />
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="shrink-0 rounded border border-border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:bg-muted"
              >
                esc
              </button>
            </div>

            <div className="p-3">
              <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Search as
              </p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Search destination">
                {TARGETS.map((t) => {
                  const Icon = t.icon
                  const active = target === t.key
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTarget(t.key)}
                      aria-pressed={active}
                      className={cn(
                        "inline-flex items-center gap-1.5 border-[2px] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors",
                        active
                          ? "border-[#0A0A0A] bg-primary text-primary-foreground dark:border-[#F6F2E8]"
                          : "border-border bg-card text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <Icon className="h-3 w-3" aria-hidden="true" />
                      {t.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                {TARGETS.find((t) => t.key === target)?.hint}
              </p>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
