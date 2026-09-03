import { useEffect, useState } from "react"
import { Loader2, Play, Save } from "lucide-react"
import {
  type PatternSimulationResult,
  createPattern,
  simulatePattern,
} from "../api"
import {
  Badge,
  Button,
  Dialog,
  Input,
  Label,
  Select,
  Textarea,
  useToast,
} from "./ui"
import { actionVariant } from "../lib/logRow"
import { cn } from "../lib/utils"

/* ── Rule Definition options (spec §3.3) ─────────────────────────── */

const ACTIONS = [
  { value: "DENY", label: "DENY" },
  { value: "FLAG", label: "FLAG" },
  { value: "ALLOW", label: "ALLOW" },
]

const CATEGORIES = [
  { value: "Security Threat", label: "Security Threat" },
  { value: "Malware", label: "Malware" },
  { value: "Phishing", label: "Phishing" },
  { value: "C2", label: "C2" },
  { value: "Suspicious", label: "Suspicious" },
  { value: "Exploit", label: "Exploit" },
]

const TIME_RANGES = [
  { value: "1h", label: "Last 1h" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
]

/** Registry action mapping (mirrors PatternTable): ALLOW → whitelist, DENY/FLAG → block. */
function mapAction(action: string): "block" | "whitelist" {
  return action === "ALLOW" ? "whitelist" : "block"
}

type PreviewRow = PatternSimulationResult["preview"][number]

function previewTime(row: PreviewRow): string {
  const raw = row["@timestamp"] ?? row.timestamp ?? ""
  if (!raw) return "—"
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString()
}

/**
 * Live Kibana-style pattern sandbox (spec §3.3).
 *
 * Rule Definition (Name, wildcard/regex Syntax, Target Action, Category Tag) →
 * [Run Pattern Test] simulates the pattern over the last `timeRange` of proxy
 * logs and renders a Match Preview table (Timestamp, Src IP, Matched Log URL) →
 * [Save & Deploy] persists the pattern through the registry.
 */
export function PatternSimulationDrawer({
  open,
  onClose,
  onCreated,
  initialUrl,
}: {
  open: boolean
  onClose: () => void
  /** Called after a pattern is successfully saved & deployed. */
  onCreated?: () => void
  /** Pre-fill the pattern syntax (e.g. a URL from a log row). */
  initialUrl?: string
}) {
  const { toast } = useToast()
  const [name, setName] = useState("")
  const [pattern, setPattern] = useState("*://*executable-share.net/download/*.exe")
  const [action, setAction] = useState("DENY")
  const [category, setCategory] = useState("Security Threat")
  const [timeRange, setTimeRange] = useState("24h")
  const [notes, setNotes] = useState("")
  const [result, setResult] = useState<PatternSimulationResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  // Reset transient state each time the drawer opens.
  useEffect(() => {
    if (open) {
      setResult(null)
      if (initialUrl !== undefined) setPattern(initialUrl)
    }
  }, [open, initialUrl])

  const runTest = async () => {
    if (!pattern.trim()) return
    setTesting(true)
    setResult(null)
    try {
      const res = await simulatePattern({ pattern, timeRange })
      setResult(res)
    } catch (e) {
      toast({ title: "Simulation failed", description: (e as Error).message, variant: "error" })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!pattern.trim()) return
    setSaving(true)
    try {
      await createPattern({
        pattern,
        pattern_type: mapAction(action),
        // Category + notes are Rule Definition metadata (spec §3.3). The
        // registry schema persists pattern + pattern_type today; the extras
        // are sent for forward-compat with the Task 10 pattern editor.
        category,
        notes,
      })
      toast({ title: "Pattern saved & deployed", variant: "success" })
      onCreated?.()
      onClose()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create New URL Pattern" className="max-w-2xl">
      <div className="space-y-5">
        {/* ── Rule Definition ── */}
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="mono-label">[ RULE DEFINITION ]</span>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="sim-pattern-name">Pattern Name</Label>
              <Input
                id="sim-pattern-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Executable-Share Download"
              />
            </div>
            <div>
              <Label htmlFor="sim-pattern">Pattern Syntax (Supports Wildcards * and Regex)</Label>
              <Input
                id="sim-pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="*://*.domain.com/*"
                className="font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") runTest()
                }}
              />
              <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                Wildcards: * = any run, ? = any char · or drop in a regex
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="flex items-center justify-between">
                  <Label>Target Action</Label>
                  <Badge variant={actionVariant(action)}>{action}</Badge>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {ACTIONS.map((a) => (
                    <button
                      key={a.value}
                      type="button"
                      aria-pressed={action === a.value}
                      className={cn(
                        "h-9 rounded-md border font-mono text-[11px] font-bold uppercase tracking-widest transition-colors",
                        action === a.value
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-card text-muted-foreground hover:bg-muted",
                      )}
                      onClick={() => setAction(a.value)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Category Tag</Label>
                <Select value={category} onChange={setCategory} options={CATEGORIES} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Run Pattern Test ── */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runTest} disabled={!pattern.trim() || testing}>
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {testing ? "Testing…" : "Run Pattern Test"}
          </Button>
          <Select value={timeRange} onChange={setTimeRange} options={TIME_RANGES} className="w-36" aria-label="Time range" />
        </div>

        {/* ── Match Preview ── */}
        {result && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {result.matchCount > 0 ? (
                <Badge variant="success">{result.matchCount.toLocaleString()} matching logs</Badge>
              ) : (
                <Badge variant="warning">0 matching logs</Badge>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">
                {result.matchCount > 10 ? `showing first 10 of ${result.matchCount.toLocaleString()}` : `within last ${timeRange}`}
              </span>
            </div>
            {result.preview.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                      <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">Timestamp</th>
                      <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">Src IP</th>
                      <th className="px-3 py-2 text-left font-mono text-[11px] font-bold uppercase tracking-widest">Matched Log URL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {result.preview.map((row, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-muted-foreground">
                          {previewTime(row)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] font-semibold">
                          {row.client_ip || "—"}
                        </td>
                        <td className="max-w-[320px] px-3 py-2">
                          <span className="block truncate font-mono text-[11px]" title={row.url}>
                            {row.url || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-3 text-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                No matching logs in window — adjust the pattern or range
              </p>
            )}
          </div>
        )}

        {/* ── Notes ── */}
        <div>
          <Label htmlFor="sim-notes">Notes</Label>
          <Textarea
            id="sim-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Context for this rule (who requested it, reason, ticket…)"
          />
        </div>

        {/* ── Footer ── */}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!pattern.trim() || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save &amp; Deploy
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
