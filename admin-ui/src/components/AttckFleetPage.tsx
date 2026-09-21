import { useCallback, useEffect, useMemo, useState } from "react"
import {
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react"
import { type FleetMapping, getFleetAttckMapping } from "../api"
import { useFilter } from "../contexts/FilterContext"
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatCard,
} from "./ui"

/** Window options mirror the per-entity pages' time-range vocabulary. */
const RANGE_OPTIONS = [
  { value: "1h", label: "Last 1 hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
]

function severityVariant(c: string): "destructive" | "warning" | "secondary" {
  switch (c) {
    case "HIGH":
      return "destructive"
    case "MEDIUM":
      return "warning"
    default:
      return "secondary"
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || "—"
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

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

  const fetchFleet = useCallback(() => {
    setLoading(true)
    setError(null)
    getFleetAttckMapping({ timeRange })
      .then((data) => setMapping(data))
      .catch((e: unknown) => {
        setMapping(null)
        setError(e instanceof Error ? e.message : "Request failed")
      })
      .finally(() => setLoading(false))
  }, [timeRange])

  useEffect(() => {
    fetchFleet()
  }, [fetchFleet])

  const suppressed = useMemo(
    () => (mapping?.suppressed ?? []).filter((s) => !!s?.id && !!s?.reason),
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
    <div className="space-y-6">
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
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            className="self-start text-[11px]"
            onClick={fetchFleet}
          >
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && mapping && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="pb-2 pr-4 font-medium">Technique ID</th>
                      <th scope="col" className="pb-2 pr-4 font-medium">Name</th>
                      <th scope="col" className="pb-2 pr-4 font-medium">Severity</th>
                      <th scope="col" className="pb-2 pr-4 font-medium">Hosts</th>
                      <th scope="col" className="pb-2 font-medium">Example hosts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {mapping.techniques.map((tech) => (
                      <tr key={tech.technique_id} className="group">
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground align-top">
                          {tech.technique_id}
                        </td>
                        <td className="py-2 pr-4 font-medium align-top">
                          <span title={tech.description}>{tech.name}</span>
                        </td>
                        <td className="py-2 pr-4 align-top">
                          <Badge variant={severityVariant(tech.severity)}>
                            {tech.severity}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 align-top font-mono text-xs">
                          {tech.host_count}
                        </td>
                        <td className="py-2 align-top">
                          <div className="flex flex-wrap gap-1">
                            {tech.example_hosts.map((ip) => (
                              <button
                                key={ip}
                                type="button"
                                className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                                onClick={() => openHost(ip)}
                                title={`Investigate ${ip}`}
                              >
                                {ip}
                              </button>
                            ))}
                            {tech.host_count > tech.example_hosts.length && (
                              <span className="px-1 py-0.5 text-[11px] text-muted-foreground/60">
                                +{tech.host_count - tech.example_hosts.length} more
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {mapping.host_summaries.some((h) => h.techniques.length > 0) && (
            <Panel title="Hosts with techniques" icon={ShieldQuestion}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="pb-2 pr-4 font-medium">Host</th>
                      <th scope="col" className="pb-2 pr-4 font-medium">Requests</th>
                      <th scope="col" className="pb-2 pr-4 font-medium">Risk share</th>
                      <th scope="col" className="pb-2 font-medium">Techniques</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {mapping.host_summaries
                      .filter((h) => h.techniques.length > 0)
                      .map((host) => (
                        <tr key={host.client_ip} className="group">
                          <td className="py-2 pr-4 align-top">
                            <button
                              type="button"
                              className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                              onClick={() => openHost(host.client_ip)}
                            >
                              {host.client_ip}
                            </button>
                          </td>
                          <td className="py-2 pr-4 align-top font-mono text-xs">
                            {host.total_requests}
                          </td>
                          <td className="py-2 pr-4 align-top font-mono text-xs">
                            {(host.risk_share * 100).toFixed(1)}%
                          </td>
                          <td className="py-2 align-top">
                            <div className="flex flex-wrap gap-1">
                              {host.techniques.map((tid) => (
                                <Badge key={tid} variant="outline">
                                  {tid}
                                </Badge>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
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
