import { useCallback } from "react"
import { Braces } from "lucide-react"
import type { FieldMap } from "../api"
import { DataTable, type DataTableColumn } from "./DataTable"
import { Input } from "./ui"

/**
 * Field Mapper (spec §3.5) — maps each app attribute the NOC UI understands
 * (src IP, dest IP, URL, domain, timestamp, action, duration) to the actual
 * Kibana/ES log field name for the configured index pattern. The left and
 * right columns are static; the middle is an editable Input per row so custom
 * index schemas can be remapped without code changes.
 *
 * Controlled component — the parent owns the persisted `FieldMap` and passes
 * it down via `value` / `onChange`, so edits are staged in the page's local
 * state until Save.
 */

interface FieldRow {
  /** FieldMap key — the wire name (snake_case, matches api.ts FieldMap). */
  attr: keyof FieldMap
  /** App Attribute label shown in the table. */
  label: string
  /** Sample log value the field carries (spec §3.5). */
  sample: string
}

const FIELD_ROWS: FieldRow[] = [
  { attr: "src_ip", label: "Source IP", sample: "192.168.1.45" },
  { attr: "dest_ip", label: "Destination IP", sample: "142.250.1.1" },
  { attr: "url", label: "URL", sample: "https://github.com/..." },
  { attr: "domain", label: "Domain", sample: "github.com" },
  { attr: "timestamp", label: "Timestamp", sample: "2026-09-02T10:42:01Z" },
  { attr: "action", label: "Action (allow/deny)", sample: "allow/deny" },
  { attr: "duration", label: "Duration (ms)", sample: "82" },
]

export function FieldMapper({
  value,
  onChange,
}: {
  value: FieldMap
  onChange: (next: FieldMap) => void
}) {
  const updateField = useCallback(
    (attr: keyof FieldMap, field: string) => {
      onChange({ ...value, [attr]: field })
    },
    [value, onChange],
  )

  const columns: DataTableColumn<FieldRow>[] = [
    {
      id: "attr",
      header: "App Attribute",
      accessor: (r) => r.label,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold">{r.label}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {r.attr}
          </span>
        </div>
      ),
    },
    {
      id: "field",
      header: "Target Kibana Log Field Name",
      accessor: (r) => value[r.attr] ?? "",
      cell: (r) => (
        <Input
          className="font-mono text-xs"
          value={value[r.attr] ?? ""}
          onChange={(e) => updateField(r.attr, e.target.value)}
          aria-label={`Target Kibana field for ${r.label}`}
          placeholder="kibana.field.name"
        />
      ),
    },
    {
      id: "sample",
      header: "Sample Log Value",
      accessor: (r) => r.sample,
      cell: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.sample}</span>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      data={FIELD_ROWS}
      rowId={(r) => r.attr}
      empty={{
        icon: Braces,
        title: "No field mappings",
        description: "Configure how app attributes map to Kibana log fields.",
      }}
      ariaLabel="Field Mapper"
    />
  )
}
