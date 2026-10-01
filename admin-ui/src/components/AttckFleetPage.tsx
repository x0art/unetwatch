import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react"
import {
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react"
import {
  type FleetHostSummary,
  type FleetMapping,
  type FleetTechnique,
  getFleetAttckMapping,
} from "../api"
import { useAbortable, useGeneration } from "../lib/utils"
import { useFilter } from "../contexts/FilterContext"
import { DataTable, type DataTableColumn } from "./DataTable"
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Panel,
  PageHeader,
  Select,
  SkeletonShape,
  StatCard,
  StatusBadge,
  type StatusTone,
} from "./ui"

/** Window options mirror the per-entity pages' time-range vocabulary. */
const RANGE_OPTIONS = [
  { value: "1h", label: "Last 1 hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
]

/** Severity → `StatusBadge` tone (HIGH/MEDIUM match the canon's map). */
function severityTone(c: string): StatusTone {
  switch (c) {
    case "HIGH":
      return "danger"
    case "MEDIUM":
      return "warning"
    default:
      return "neutral"
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || "—"
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/* ── Techniques fleet-wide (§3.3.8) ──────────────────────────────── *
 * Module-scope so the array identity is referentially stable; the
 * `example_hosts` cell reads `openHost` through a shared handle that is
 * refreshed after commit (the codebase's `*_UI` pattern). */
const TECHNIQUES_UI: { openHost: (ip: string) => void } = { openHost: () => {} }

const TECHNIQUE_COLUMNS: DataTableColumn<FleetTechnique>[] = [
  {
    id: "technique_id",
    header: "Technique ID",
    slot: "identity",
    filterType: "text",
    accessor: (t) => t.technique_id,
    cell: (t) => (
      <span className="font-mono text-xs text-muted-foreground">{t.technique_id}</span>
    ),
    exportValue: (t) => t.technique_id,
  },
  {
    id: "name",
    header: "Name",
    slot: "object",
    filterType: "text",
    accessor: (t) => t.name,
    cell: (t) => <span title={t.description}>{t.name}</span>,
    exportValue: (t) => t.name,
  },
  {
    id: "severity",
    header: "Severity",
    slot: "verdict",
    filterType: "enum",
    accessor: (t) => t.severity,
    cell: (t) => <StatusBadge tone={severityTone(t.severity)}>{t.severity}</StatusBadge>,
    exportValue: (t) => t.severity,
  },
  {
    id: "example_hosts",
    header: "Example hosts",
    slot: "evidence",
    filterType: "text",
    accessor: (t) => t.example_hosts,
    cell: (t) => (
      <div className="flex flex-wrap gap-1">
        {t.example_hosts.map((ip) => (
          <button
            key={ip}
            type="button"
            className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
            onClick={() => TECHNIQUES_UI.openHost(ip)}
            title={`Investigate ${ip}`}
          >
            {ip}
          </button>
        ))}
        {t.host_count > t.example_hosts.length && (
          <span className="px-1 py-0.5 text-[11px] text-muted-foreground/60">
            +{t.host_count - t.example_hosts.length} more
          </span>
        )}
      </div>
    ),
  },
  {
    id: "host_count",
    header: "Hosts",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs",
    accessor: (t) => t.host_count,
    exportValue: (t) => t.host_count,
  },
]

/* ── Hosts with techniques (§3.3.8) ───────────────────────────────── */
const HOSTS_UI: { openHost: (ip: string) => void } = { openHost: () => {} }

const FLEET_HOST_COLUMNS: DataTableColumn<FleetHostSummary>[] = [
  {
    id: "client_ip",
    header: "Host",
    slot: "identity",
    filterType: "text",
    accessor: (h) => h.client_ip,
    cell: (h) => (
      <button
        type="button"
        className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => HOSTS_UI.openHost(h.client_ip)}
      >
        {h.client_ip}
      </button>
    ),
    exportValue: (h) => h.client_ip,
  },
  {
    id: "techniques",
    header: "Techniques",
    slot: "evidence",
    filterType: "text",
    accessor: (h) => h.techniques,
    cell: (h) => (
      <div className="flex flex-wrap gap-1">
        {h.techniques.map((tid) => (
          <Badge key={tid} variant="outline">
            {tid}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: "risk_share",
    header: "Risk share",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs",
    accessor: (h) => h.risk_share,
    cell: (h) => `${(h.risk_share * 100).toFixed(1)}%`,
    exportValue: (h) => (h.risk_share * 100).toFixed(1),
  },
  {
    id: "total_requests",
    header: "Requests",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs",
    accessor: (h) => h.total_requests,
    exportValue: (h) => h.total_requests,
  },
]

interface Props {
  /** Clicking a host row drills into that host's investigation page. */
  onNavigate?: (view: "host") => void
}

export function AttckFleetPage({ onNavigate }: Props) {
  const { setGlobalFilter } = useFilter()
  const [timeRange, setTimeRange] = useState("24h")
  const [mapping, setMapping] = useState<FleetMapping | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Mirrors the per-entity pages' drill-down: seed the global filter with the
  // host so the investigation page opens on it, then switch the view.
  const openHost = useCallback(
    (ip: string) => {
      setGlobalFilter(ip)
      try {
        window.localStorage.setItem("unetwatch_view", "host")
      } catch {
        /* localStorage may be unavailable */
      }
      onNavigate?.("host")
    },
    [setGlobalFilter, onNavigate],
  )

  // Hand the stable `openHost` to the module-scope column cells after commit
  // (the codebase's `*_UI` pattern; a layout effect avoids the render-phase
  // side effect React Strict Mode double-invokes).
  useLayoutEffect(() => {
    TECHNIQUES_UI.openHost = openHost
    HOSTS_UI.openHost = openHost
  }, [openHost])

  // Time-range-keyed READ: a newer range aborts the previous mapping read and
  // the generation stops a slow earlier range from overwriting a faster newer
  // one. Without this a quick 24h→7d flip could paint the 24h fleet under 7d.
  const runFleet = useAbortable()
  const fleetGen = useGeneration()
  const fetchFleet = useCallback(() => {
    const g = fleetGen.next()
    setLoading(true)
    setError(null)
    return runFleet((signal) => getFleetAttckMapping({ timeRange }, { signal }))
      .then((data) => {
        if (data === undefined || !fleetGen.isCurrent(g)) return
        setMapping(data)
      })
      .catch((e: unknown) => {
        if (!fleetGen.isCurrent(g)) return
        if ((e as Error).name === "AbortError") return
        setMapping(null)
        setError(e instanceof Error ? e.message : "Request failed")
      })
      .finally(() => {
        if (fleetGen.isCurrent(g)) setLoading(false)
      })
  }, [runFleet, fleetGen, timeRange])

  useEffect(() => {
    fetchFleet()
  }, [fetchFleet])

  const suppressed = useMemo(
    () => (mapping?.suppressed ?? []).filter((s) => !!s?.id && !!s?.reason),
    [mapping],
  )

  // Host rows for the fleet grid: only hosts that matched at least one
  // technique. Memoized so `DataTable`'s filter/sort memos see a stable array
  // identity across unrelated re-renders.
  const hostRows = useMemo(
    () => (mapping?.host_summaries ?? []).filter((h) => h.techniques.length > 0),
    [mapping],
  )

  // Icon reads the real state: an offline/empty mapping must not show the
  // green "all clear" shield a clean result would show.
  const hasTechniques = !!mapping && mapping.techniques.length > 0
  const hasHighSeverity =
    !!mapping && mapping.techniques.some((t) => t.severity === "HIGH")
  const HeaderIcon = hasTechniques
    ? hasHighSeverity
      ? ShieldAlert
      : ShieldCheck
    : ShieldQuestion

  return (
    <div className="space-y-5">
      <PageHeader
        title="ATT&CK Coverage"
        description="Fleet-wide MITRE ATT&CK techniques across every host in the persisted findings — the aggregate the per-entity panels cannot show."
      >
        <div className="flex items-center gap-2">
          <Select
            value={timeRange}
            onChange={setTimeRange}
            options={RANGE_OPTIONS}
            className="w-40"
            aria-label="Time range"
          />
          <Button variant="outline" onClick={fetchFleet} disabled={loading}>
            <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </PageHeader>

      {loading && (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading fleet ATT&CK mapping</span>
          {/* The result is a stack of titled panels (heat map, technique
              table, breakdown) — mirror that, not one flat block. */}
          <SkeletonShape variant="panel-stack" />
        </div>
      )}

      {!loading && error && (
        <Callout
          className="flex-col items-start text-xs"
          action={
            <Button
              variant="outline"
              size="sm"
              className="self-start text-[11px]"
              onClick={fetchFleet}
            >
              Retry
            </Button>
          }
        >
          {error}
        </Callout>
      )}

      {!loading && !error && mapping && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={HeaderIcon}
              label="Distinct techniques"
              value={mapping.techniques.length}
              tone={hasHighSeverity ? "danger" : "default"}
            />
            <StatCard
              icon={ShieldAlert}
              label="Hosts affected"
              value={mapping.hosts_with_techniques}
            />
            <StatCard
              icon={ShieldQuestion}
              label="Hosts scanned"
              value={mapping.hosts_scanned}
            />
            <StatCard
              icon={ShieldCheck}
              label="Withheld techniques"
              value={suppressed.length}
              hint="Field-availability gate"
            />
          </div>

          <Panel title="Fleet summary" icon={HeaderIcon}>
            <div className="space-y-3">
              {mapping.es_online === false && (
                <p className="text-xs text-muted-foreground italic">
                  Elasticsearch unavailable — mapping unavailable.
                </p>
              )}
              <p className="text-sm text-muted-foreground">{mapping.summary}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-muted-foreground">
                  Generated at {formatDate(mapping.generated_at)}
                </span>
                {mapping.data_sources.length > 0 && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    {mapping.data_sources.map((src) => (
                      <Badge key={src} variant="default">
                        {src}
                      </Badge>
                    ))}
                  </>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Techniques fleet-wide" icon={ShieldAlert}>
            {mapping.techniques.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No ATT&CK techniques detected fleet-wide"
                description="No host in the window met a technique's predicate. This is not a statement that the traffic is clean."
              />
            ) : (
              <DataTable
                columns={TECHNIQUE_COLUMNS}
                data={mapping.techniques}
                rowId={(t) => t.technique_id}
                defaultSortBy="host_count"
                defaultSortDir="desc"
                viewKey="attck-techniques"
                ariaLabel="Fleet ATT&CK techniques"
                empty={{
                  icon: ShieldCheck,
                  title: "No ATT&CK techniques detected fleet-wide",
                  description:
                    "No host in the window met a technique's predicate. This is not a statement that the traffic is clean.",
                }}
              />
            )}
          </Panel>

          {mapping.host_summaries.some((h) => h.techniques.length > 0) && (
            <Panel title="Hosts with techniques" icon={ShieldQuestion}>
              <DataTable
                columns={FLEET_HOST_COLUMNS}
                data={hostRows}
                rowId={(h) => h.client_ip}
                defaultSortBy="risk_share"
                defaultSortDir="desc"
                viewKey="attck-hosts"
                ariaLabel="Fleet hosts with techniques"
                empty={{
                  icon: ShieldQuestion,
                  title: "No hosts matched a technique",
                  description: "No host in the window met a technique's predicate.",
                }}
              />
            </Panel>
          )}

          {suppressed.length > 0 && (
            <Panel title="Withheld techniques" icon={ShieldQuestion}>
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  {suppressed.length} technique
                  {suppressed.length === 1 ? "" : "s"} withheld — required field
                  {suppressed.length === 1 ? " was" : "s were"} absent:
                </p>
                <ul className="space-y-1">
                  {suppressed.map((s) => (
                    <li key={s.id} className="flex gap-2 text-xs">
                      <span className="font-mono text-muted-foreground">{s.id}</span>
                      <span className="break-words text-muted-foreground/80">
                        {s.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}
