import type { DataTableColumn } from "../DataTable"
import type { ExportPayload, ExportScope } from "./types"

/* ════════════════════════════════════════════════════════════════
 * CSV export (§5.9) — RFC 4180 + a formula-injection guard.
 *
 * The cell value is `exportValue(row)` when given, else the stringified
 * `accessor` — never the ReactNode from `cell`, so badges/menus/chips
 * serialize to their underlying value rather than `[object Object]`.
 * ================================================================ */

/** Four leading characters a spreadsheet treats as a formula. */
const FORMULA_LEAD = /^[=+\-@]/

/**
 * Serialize one CSV field (§5.9).
 *
 * - A value whose first character is `=`, `+`, `-` or `@` is prefixed with
 *   a single quote so spreadsheet apps cannot execute it
 *   (CSV injection / OWASP recommendation) — guard applies **only** to
 *   those four leading characters.
 * - The field is then wrapped in `"` if it contains `,`, `"`, CR or LF,
 *   with any embedded `"` doubled (RFC 4180 §2.7).
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  let s = String(value)
  if (FORMULA_LEAD.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export interface CsvColumn {
  id: string
  header: string
  exportValue?: (row: unknown) => string | number | null
  accessor?: (row: unknown) => unknown
}

/** Export header for a column: `exportHeader ?? String(header)`. */
export function exportHeaderOf(col: DataTableColumn<unknown>): string {
  return col.exportHeader ?? String(col.header)
}

/**
 * Build a CSV document.
 *
 * `\r\n` line endings, UTF-8 with BOM for Excel — the caller prepends the
 * BOM when downloading (kept out of the string so `csvField` round-trips
 * predictably under test).
 */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const lines = [header.map(csvField).join(",")]
  for (const row of rows) lines.push(row.map(csvField).join(","))
  return lines.join("\r\n")
}

/** The `ExportPayload` a page's `onExport("server-all")` returns, as CSV. */
export function payloadToCsv(payload: ExportPayload): string {
  return toCsv(
    payload.columns.map((c) => c.header),
    payload.rows.map((row) => payload.columns.map((c) => row[c.id] ?? null)),
  )
}

/** Value the export uses for one cell: `exportValue` → `accessor` → `""`. */
export function cellExportValue<T>(col: DataTableColumn<T>, row: T): string | number | null {
  if (col.exportValue) return col.exportValue(row)
  const v = col.accessor ? col.accessor(row) : undefined
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) return v.map(String).join(", ")
  if (typeof v === "object") return JSON.stringify(v)
  return v as string | number
}

export function timestampSlug(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** `exportFilename ?? \`${viewKey ?? slug(ariaLabel)}-${yyyyMMdd-HHmmss}.csv\`` */
export function defaultExportFilename(
  viewKey: string | undefined,
  ariaLabel: string | undefined,
  exportFilename: string | undefined,
): string {
  const base = exportFilename ?? `${viewKey ?? slug(ariaLabel ?? "table")}-${timestampSlug()}`
  return base.endsWith(".csv") ? base : `${base}.csv`
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table"
}

/** Trigger a browser download of a CSV string (BOM-prefixed, UTF-8). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next macrotask so the click has committed the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** `boolean` for a scope's availability is the caller's job (§5.9). */
export type { ExportScope }
