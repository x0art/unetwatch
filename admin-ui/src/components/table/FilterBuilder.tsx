import { useEffect, useMemo, useState } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Check, Filter, Search, SquareSlash, X } from "lucide-react"
import { Button } from "../ui"
import { cn } from "../../lib/utils"
import type { ColumnFilterValue, DataTableColumn } from "../DataTable"
import { isActiveFilter } from "../DataTable"
import {
  cycleEnumState,
  enumStateOf,
  isDatetimeFilter as isDatetime,
  isEnumFilter,
  isEnumFilterActive,
  isNumberFilter as isNumber,
  setEnumState,
  type EnumFilter,
  type EnumState,
} from "./types"

/* ════════════════════════════════════════════════════════════════
 * FilterBuilder — tri-state enum popover + active-filter chips (§5.2).
 *
 * Every control commits only on **Apply** (the existing HeaderFilter
 * rule). The `enum` control cycles Off → Include → NOT → Off with
 * `role="switch"` (never colour-only) and a `radiogroup` mode toggle for
 * new picks. The chips summarize honestly (`Action ≠ DENY` for a NOT).
 * ================================================================ */

/* ── Tri-state option row (§7.2) ──────────────────────────────── */

function EnumOptionRow({
  option,
  state,
  onCycle,
}: {
  option: string
  state: EnumState
  onCycle: () => void
}) {
  const label =
    state === "include"
      ? `${option}: included`
      : state === "exclude"
        ? `${option}: excluded`
        : `${option}: not filtered`
  return (
    <button
      type="button"
      role="switch"
      aria-checked={state !== "off"}
      aria-label={label}
      onClick={onCycle}
      className={cn(
        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span
        className={cn(
          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border",
          state === "off" ? "border-border bg-card" : "border-primary bg-primary text-white",
        )}
        aria-hidden="true"
      >
        {state === "include" && <Check className="h-3 w-3" />}
        {state === "exclude" && <SquareSlash className="h-3 w-3" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{option}</span>
      {state === "include" && <span className="shrink-0 text-xs text-muted-foreground">Include</span>}
      {state === "exclude" && <span className="shrink-0 text-xs text-muted-foreground">NOT</span>}
    </button>
  )
}

/* ── The popover itself ───────────────────────────────────────── */

/**
 * The filter editor body, shared by the in-header popover and the
 * chip-anchored popover so both paths can never drift. Commits only on
 * Apply (or Clear).
 */
export function FilterEditor<T>({
  col,
  value,
  onApply,
  options,
}: {
  col: DataTableColumn<T>
  value: ColumnFilterValue | undefined
  onApply: (value: ColumnFilterValue) => void
  options: { value: string; label: string }[]
}) {
  const type = col.filterType ?? "enum"
  const [draft, setDraft] = useState<ColumnFilterValue>(value ?? emptyFilterFor(type))
  const [query, setQuery] = useState("")

  // Resync the draft when the committed filter changes from outside
  // (Clear-all, parent-controlled resets).
  const committedKey = JSON.stringify(value ?? null)
  useEffect(() => {
    setDraft(value ?? emptyFilterFor(type))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey])

  const label = String(col.header)

  // Normalize the scalar form into the object form for the enum editor so a
  // legacy `string` exact-match still lights up its option row.
  const draftEnum: EnumFilter = useMemo(() => {
    if (isEnumFilter(draft)) return draft
    if (typeof draft === "string" && draft.trim()) return { include: [draft], exclude: [] }
    return { include: [], exclude: [] }
  }, [draft])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((o) => o.label.toLowerCase().includes(needle))
  }, [options, query])

  const inputClass =
    "h-8 w-full rounded border border-border bg-card px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"

  return (
    <>
      {type === "enum" && (
        <div>
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">No values in loaded rows — broaden the time window</p>
          ) : (
            <>
              {filtered.length > 3 && (
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search values"
                    aria-label={`Search ${label} values`}
                    className={cn(inputClass, "pl-7")}
                  />
                </div>
              )}
              <div className="max-h-64 space-y-0.5 overflow-y-auto" role="listbox" aria-label={`${label} values`}>
                {filtered.map((o) => (
                  <EnumOptionRow
                    key={o.value}
                    option={o.label}
                    state={enumStateOf(o.value, draftEnum)}
                    onCycle={() =>
                      setDraft(setEnumState(draftEnum, o.value, cycleEnumState(enumStateOf(o.value, draftEnum))))
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {type === "text" && (
        <input
          type="search"
          value={typeof draft === "string" ? draft : ""}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Filter"
          aria-label={`Filter by ${label}`}
          className={inputClass}
        />
      )}
      {type === "datetime" && (
        <div className="space-y-2">
          <label className="mono-label block">
            From
            <input
              type="datetime-local"
              value={isDatetime(draft) ? draft.from : ""}
              onChange={(e) => setDraft({ from: e.target.value, to: isDatetime(draft) ? draft.to : "" })}
              aria-label={`Filter by ${label}, from`}
              className={cn(inputClass, "mt-1")}
            />
          </label>
          <label className="mono-label block">
            To
            <input
              type="datetime-local"
              value={isDatetime(draft) ? draft.to : ""}
              onChange={(e) => setDraft({ to: e.target.value, from: isDatetime(draft) ? draft.from : "" })}
              aria-label={`Filter by ${label}, to`}
              className={cn(inputClass, "mt-1")}
            />
          </label>
        </div>
      )}
      {type === "number" && (
        <div className="flex items-center gap-2">
          <label className="mono-label flex-1">
            Min
            <input
              type="number"
              inputMode="numeric"
              value={isNumber(draft) ? draft.min : ""}
              onChange={(e) => setDraft({ min: e.target.value, max: isNumber(draft) ? draft.max : "" })}
              aria-label={`Filter by ${label}, minimum`}
              className={cn(inputClass, "mt-1")}
            />
          </label>
          <label className="mono-label flex-1">
            Max
            <input
              type="number"
              inputMode="numeric"
              value={isNumber(draft) ? draft.max : ""}
              onChange={(e) => setDraft({ max: e.target.value, min: isNumber(draft) ? draft.min : "" })}
              aria-label={`Filter by ${label}, maximum`}
              className={cn(inputClass, "mt-1")}
            />
          </label>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(emptyFilterFor(type))
            setQuery("")
            onApply(emptyFilterFor(type))
          }}
        >
          Clear
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            if (type === "enum") {
              const next: EnumFilter = { include: draftEnum.include, exclude: draftEnum.exclude }
              onApply(isEnumFilterActive(next) ? next : emptyFilterFor("enum"))
            } else onApply(draft)
          }}
        >
          Apply
        </Button>
      </div>
    </>
  )
}

/** The trigger icon + its popover, mounted in each sortable header cell.
 * The chip-anchored popover reuses `FilterEditor` directly. */
export function FilterBuilder<T>({
  col,
  value,
  onApply,
  options,
}: {
  col: DataTableColumn<T>
  value: ColumnFilterValue | undefined
  onApply: (value: ColumnFilterValue) => void
  options: { value: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  const active = isActiveFilter(value)
  const label = String(col.header)

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        aria-label={`Filter by ${label}`}
        aria-pressed={active}
        aria-haspopup="dialog"
        title={`Filter by ${label}`}
        className={cn(
          "relative inline-flex h-6 w-6 items-center justify-center rounded border border-transparent transition-colors hover:border-border hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-primary" : "text-muted-foreground/60 hover:text-muted-foreground",
          open && "border-border bg-muted",
        )}
      >
        <Filter className={cn("h-3 w-3", active && "fill-current")} aria-hidden="true" />
        {active && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          side="bottom"
          sideOffset={4}
          aria-label={`Filter by ${label}`}
          className="z-[70] w-64 rounded-md border border-border bg-card p-3 text-left shadow-md data-[state=open]:animate-in"
        >
          <FilterEditor
            col={col}
            value={value}
            onApply={(v) => {
              onApply(v)
              setOpen(false)
            }}
            options={options}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

/* ── Chips (§5a / §5.2) ───────────────────────────────────────── */

export interface FilterChipModel {
  id: string
  label: string
  summary: string
  negated: boolean
  onOpen: () => void
  onClear: () => void
}

/** Summarize a filter value for a chip: `Action: DENY` / `Action ≠ DENY` /
 * a range like `Detected 12:00–13:00`. */
export function summarizeFilter(value: ColumnFilterValue, type: string): { text: string; negated: boolean } {
  if (typeof value === "string") return { text: value, negated: false }
  if (isEnumFilter(value)) {
    if (value.include.length > 0) return { text: value.include.join(", "), negated: false }
    if (value.exclude.length > 0) return { text: value.exclude.join(", "), negated: true }
    return { text: "", negated: false }
  }
  if (isDatetime(value)) {
    const from = value.from ? value.from.replace("T", " ") : ""
    const to = value.to ? value.to.replace("T", " ") : ""
    return { text: [from, to].filter(Boolean).join(" – "), negated: false }
  }
  if (isNumber(value)) {
    const min = value.min.trim()
    const max = value.max.trim()
    return { text: [min && `≥ ${min}`, max && `≤ ${max}`].filter(Boolean).join(", "), negated: false }
  }
  return { text: String(type), negated: false }
}

export function FilterChips({
  chips,
  onClearAll,
  onChipRef,
  className,
}: {
  chips: FilterChipModel[]
  onClearAll: () => void
  /** Registers each chip's edit button so the table can anchor its filter
   * popover on the chip the operator clicked (§5a). */
  onChipRef?: (id: string, el: HTMLButtonElement | null) => void
  className?: string
}) {
  if (chips.length === 0) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} aria-live="polite">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-xs text-foreground"
        >
          <button
            ref={(el) => onChipRef?.(chip.id, el)}
            type="button"
            onClick={chip.onOpen}
            className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Edit ${chip.label} filter`}
          >
            <span className="font-medium">{chip.label}</span>
            <span className="text-muted-foreground">{chip.negated ? "≠" : ":"}</span>
            <span className="max-w-[12rem] truncate">{chip.summary}</span>
          </button>
          <button
            type="button"
            onClick={chip.onClear}
            className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Clear ${chip.label} filter`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="rounded border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {chips.length} filter{chips.length === 1 ? "" : "s"} active · Clear
      </button>
    </div>
  )
}

function emptyFilterFor(type: string): ColumnFilterValue {
  if (type === "datetime") return { from: "", to: "" }
  if (type === "number") return { min: "", max: "" }
  return ""
}

