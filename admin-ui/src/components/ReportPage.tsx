import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, ArrowLeft, Copy, FileText, Info, ShieldQuestion } from "lucide-react"
import {
  getClientReport,
  getHostEnrichment,
  getHostProfile,
  getUrlBreakdown,
  getUrlEnrichment,
  probeEsHealth,
  type ClientReport,
  type ClientReportTopDomain,
  type ClientReportTopPattern,
  type ClientReportTopUrl,
  type EnrichHost,
  type EnrichUrl,
  type HostProfile,
  type HostRiskExplained,
  type HostRiskUnavailable,
  type UrlBreakdown,
  type UrlClientCount,
} from "../api"
import { copyText, useAbortable, useGeneration } from "../lib/utils"
import { DataTable, type DataTableColumn } from "./DataTable"
import {
  Badge,
  Button,
  PageHeader,
  Panel,
  SkeletonShape,
  StatCard,
  useToast,
} from "./ui"

interface Props {
  kind: "host" | "url"
  value: string
  onBack: () => void
  /** Hidden (previously visited) tabs stay mounted and CSS `hidden` does not
   *  stop JS, so the mount fetch must not fire until the view is shown. When
   *  omitted the page behaves as before (always active). */
  active?: boolean
}

type SectionState<T> = {
  data: T | null
  loading: boolean
  error: string | null
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs break-all text-foreground sm:max-w-[60%] sm:text-right">{value}</dd>
    </div>
  )
}

/** Returns the lookup's failure reason, or null when the lookup did not fail
 * (ok/skipped) or carries no reason. Lets the enrichment rows distinguish
 * "no data" from "the lookup actually failed". */
function lookupError(status: string, error: string | null | undefined): string | null {
  if (status !== "unavailable" && status !== "timeout") return null
  return error?.trim() ? error : "no reason reported"
}


/* ── Indicator grids (§3.3.9) ─────────────────────────────────────── *
 * Module-scope so their array identity is referentially stable — the
 * `DataTable` sort/filter memos key off `columns`. */
const TOP_DOMAIN_COLUMNS: DataTableColumn<ClientReportTopDomain>[] = [
  {
    id: "domain",
    header: "Domain",
    slot: "object",
    filterType: "text",
    accessor: (r) => r.domain,
    cell: (r) => <span className="font-mono text-xs">{r.domain}</span>,
    exportValue: (r) => r.domain,
  },
  {
    id: "count",
    header: "Requests",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs tabular-nums",
    accessor: (r) => r.count,
    cell: (r) => r.count.toLocaleString(),
    exportValue: (r) => r.count,
  },
  {
    id: "pct",
    header: "Share",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs tabular-nums",
    accessor: (r) => r.pct,
    cell: (r) => `${r.pct.toFixed(1)}%`,
    exportValue: (r) => r.pct,
  },
]

const TOP_PATTERN_COLUMNS: DataTableColumn<ClientReportTopPattern>[] = [
  {
    id: "pattern",
    header: "Pattern",
    slot: "object",
    filterType: "text",
    accessor: (r) => r.pattern,
    cell: (r) => <span className="font-mono text-xs">{r.pattern}</span>,
    exportValue: (r) => r.pattern,
  },
  {
    id: "hits",
    header: "Hits",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs tabular-nums",
    accessor: (r) => r.hits,
    cell: (r) => r.hits.toLocaleString(),
    exportValue: (r) => r.hits,
  },
]

const TOP_URL_COLUMNS: DataTableColumn<ClientReportTopUrl>[] = [
  {
    id: "url",
    header: "URL",
    slot: "object",
    filterType: "text",
    accessor: (r) => r.url,
    cell: (r) => (
      <span className="block max-w-[420px] truncate font-mono text-xs" title={r.url}>
        {r.url}
      </span>
    ),
    exportValue: (r) => r.url,
  },
  {
    id: "count",
    header: "Requests",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs tabular-nums",
    accessor: (r) => r.count,
    cell: (r) => r.count.toLocaleString(),
    exportValue: (r) => r.count,
  },
]

const CLIENT_COLUMNS: DataTableColumn<UrlClientCount>[] = [
  {
    id: "client_ip",
    header: "Client IP",
    slot: "identity",
    filterType: "text",
    accessor: (r) => r.client_ip,
    cell: (r) => <span className="font-mono text-xs">{r.client_ip}</span>,
    exportValue: (r) => r.client_ip,
  },
  {
    id: "count",
    header: "Requests",
    slot: "measures",
    filterType: "number",
    defaultSortDir: "desc",
    align: "right",
    className: "font-mono text-xs tabular-nums",
    accessor: (r) => r.count,
    cell: (r) => r.count.toLocaleString(),
    exportValue: (r) => r.count,
  },
  {
    id: "last_seen",
    header: "Last seen",
    slot: "measures",
    filterType: "datetime",
    accessor: (r) => r.last_seen,
    cell: (r) => <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{r.last_seen}</span>,
    exportValue: (r) => r.last_seen,
  },
]

/** Section 02's body — the risk summary, WITH its justification.
 *
 * The operator's complaint was a SPECTRE of a score: `Risk Score: HIGH 92/100`
 * with nothing saying why, and no way to tell a measured 92 from the flat
 * blacklist floor. Three outcomes are rendered distinctly:
 *
 *  - unavailable: the reason carries `state: "unavailable"` (ES unreachable /
 *    field mode UNKNOWN). NO score is shown; an explicit marker says so,
 *    deliberately signalling "this was not measured" rather than "this is
 *    clean". A host that was not measured must never read as a clean one.
 *  - explained: the score is shown with the reason sentence, the rule that
 *    produced it, and the graded inputs (reaches, distinct blacklisted
 *    destinations) it was derived from.
 *  - no reason at all (a profile from an older backend): the score is still
 *    shown, with a notice that no justification was supplied — never a bare
 *    number pretending to explain itself.
 */
function RiskSummaryBody({ profile }: { profile: HostProfile }) {
  const risk = profile.risk
  // Narrowing by a discriminant, not a probe: `state` exists ONLY on the
  // unavailable variant, so this is safe under the isolated-modules build too.
  const reason = risk.riskReason
  const unavailable: HostRiskUnavailable | null =
    reason && "state" in reason && reason.state === "unavailable" ? reason : null
  if (unavailable) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Risk not computed</p>
              <p className="text-xs text-muted-foreground">{unavailable.text}</p>
              <p className="font-mono text-xs text-muted-foreground/70">
                reason: {unavailable.reason}
              </p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={ShieldQuestion}
            label="Risk score"
            value="Unavailable"
            tone="default"
            hint="Not measured — no score"
          />
          <StatCard icon={FileText} label="Total requests" value="Unavailable" hint={profile.hostname || profile.primaryIp} />
          <StatCard icon={FileText} label="Risk requests" value="Unavailable" hint="ALLOW pattern matches" />
          <StatCard icon={FileText} label="Enforcements" value="Unavailable" hint="DENY — proxy handled" />
        </div>
        <p className="text-xs italic text-muted-foreground">
          Source: Elasticsearch — unreachable or field inventory unresolved.
        </p>
      </div>
    )
  }
  const explained: HostRiskExplained | null =
    reason && "rule" in reason ? reason : null
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={FileText}
          label="Risk score"
          value={`${risk.riskScore}/100`}
          tone={risk.riskLevel === "HIGH" ? "danger" : risk.riskLevel === "MEDIUM" ? "warning" : "success"}
          hint={`Level ${risk.riskLevel}`}
        />
        <StatCard icon={FileText} label="Total requests" value={risk.totalRequests.toLocaleString()} hint={profile.hostname || profile.primaryIp} />
        <StatCard icon={FileText} label="Risk requests" value={risk.riskRequests.toLocaleString()} tone="warning" hint="ALLOW pattern matches" />
        <StatCard icon={FileText} label="Enforcements" value={risk.enforcements.toLocaleString()} tone="info" hint={`${risk.enforcementsPct.toFixed(1)}% enforced · DENY handled`} />
      </div>
      {explained ? (
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{explained.text}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary">rule</Badge>
                <span className="font-mono text-muted-foreground">{explained.rule}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className="font-mono text-muted-foreground">
                  {explained.inputs.riskRequests}/{explained.inputs.totalRequests} risk (ALLOW)
                  {(explained.inputs.blacklistedDistinct ?? 0) > 0
                    ? `, ${explained.inputs.blacklistedDistinct} distinct blacklisted destination${explained.inputs.blacklistedDistinct === 1 ? "" : "s"}`
                    : ""}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          No reason supplied with this score — it cannot be justified from the
          response. Re-fetch from the host endpoint to obtain one.
        </p>
      )}
      {risk.sources && (
        <p className="text-xs text-muted-foreground">
          Score source:{" "}
          <span className="font-mono">
            {risk.sources.risk.available ? (risk.sources.risk.source ?? "unreported") : "unavailable"}
          </span>
          {risk.sources.risk.window !== "—" && <> · window <span className="font-mono">{risk.sources.risk.window}</span></>}
          {" · "}
          Detail tables source: <span className="font-mono">{risk.sources.risk.persisted_detail}</span> (all time)
        </p>
      )}
    </div>
  )
}

export function ReportPage({ kind, value, onBack, active = true }: Props) {
  const { toast } = useToast()
  const [generatedAt, setGeneratedAt] = useState(() => new Date().toISOString())

  const [profile, setProfile] = useState<SectionState<HostProfile>>({ data: null, loading: true, error: null })
  const [report, setReport] = useState<SectionState<ClientReport>>({ data: null, loading: true, error: null })
  const [hostEnrich, setHostEnrich] = useState<SectionState<EnrichHost>>({ data: null, loading: true, error: null })
  const [breakdown, setBreakdown] = useState<SectionState<UrlBreakdown>>({ data: null, loading: true, error: null })
  const [urlEnrich, setUrlEnrich] = useState<SectionState<EnrichUrl>>({ data: null, loading: true, error: null })
  // Explicit ES-reachability probe — NEVER inferred from a section payload.
  // /health always answers and reports dependencies.elasticsearch as
  const [health, setHealth] = useState<{ checked: boolean; es: boolean | null }>({ checked: false, es: null })
  // A generation per entity switch: a slow previous entity's response must not
  // paint over the entity the operator just navigated to. Each section gets its
  // OWN abort point — the host branch fires three reads in the same tick, and a
  // single shared controller would have the later calls abort the earlier ones.
  // Destructure the two STABLE useCallback functions rather than keeping the
  // `useGeneration()` object: that object is a fresh literal every render, and
  // it is a DIRECT dep of the effect below, so depending on it would re-run the
  // effect — which calls `setGeneratedAt` — on every render: an infinite loop.
  const { next: sectionNext, isCurrent: sectionCurrent } = useGeneration()
  const runProfile = useAbortable()
  const runReport = useAbortable()
  const runHostEnrich = useAbortable()
  const runBreakdown = useAbortable()
  const runUrlEnrich = useAbortable()
  // The explicit /health probe is user-independent (fixed params, mounts once),
  // so its own `cancelled` cleanup is sufficient — left as-is.
  useEffect(() => {
    let cancelled = false
    void probeEsHealth()
      .then((es) => { if (!cancelled) setHealth({ checked: true, es }) })
      .catch(() => { if (!cancelled) setHealth({ checked: true, es: null }) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    // A hidden parked page performs no work — no fetch, and critically no
    // state write that would feed a re-render loop. Re-runs on arrival.
    if (!active) return
    // Re-stamp on every refetch so the timestamp always belongs to the data
    // currently on screen (report views stay mounted; switching entity only
    // re-runs this effect).
    setGeneratedAt(new Date().toISOString())
    // No entity selected (e.g. a bare reload restoring the view from
    // localStorage with no ?q=) — never issue a fetch with an empty value.
    if (value.trim() === "") return
    // Supersede any in-flight read from the previous entity.
    const g = sectionNext()
    if (kind === "host") {
      setProfile({ data: null, loading: true, error: null })
      setReport({ data: null, loading: true, error: null })
      setHostEnrich({ data: null, loading: true, error: null })
      void runProfile((signal) => getHostProfile(value, "24h", { signal }))
        .then((data) => {
          if (!sectionCurrent(g)) return
          if (data === undefined) {
            setProfile({ data: null, loading: false, error: null })
            return
          }
          setProfile({ data, loading: false, error: null })
        })
        .catch((e: unknown) => {
          if (!sectionCurrent(g)) return
          const aborted = (e as Error).name === "AbortError"
          setProfile({ data: null, loading: false, error: aborted ? null : e instanceof Error ? e.message : "Request failed" })
        })
      void runReport((signal) => getClientReport(value, { signal }))
        .then((data) => {
          if (!sectionCurrent(g)) return
          if (data === undefined) {
            setReport({ data: null, loading: false, error: null })
            return
          }
          setReport({ data, loading: false, error: null })
        })
        .catch((e: unknown) => {
          if (!sectionCurrent(g)) return
          const aborted = (e as Error).name === "AbortError"
          setReport({ data: null, loading: false, error: aborted ? null : e instanceof Error ? e.message : "Request failed" })
        })
      void runHostEnrich((signal) => getHostEnrichment(value, 3, { signal }))
        .then((data) => {
          if (!sectionCurrent(g)) return
          if (data === undefined) {
            setHostEnrich({ data: null, loading: false, error: null })
            return
          }
          setHostEnrich({ data, loading: false, error: null })
        })
        .catch((e: unknown) => {
          if (!sectionCurrent(g)) return
          const aborted = (e as Error).name === "AbortError"
          setHostEnrich({ data: null, loading: false, error: aborted ? null : e instanceof Error ? e.message : "Request failed" })
        })
    } else {
      setBreakdown({ data: null, loading: true, error: null })
      setUrlEnrich({ data: null, loading: true, error: null })
      void runBreakdown((signal) => getUrlBreakdown(value, { limit: 100, source: "findings" }, { signal }))
        .then((data) => {
          if (!sectionCurrent(g)) return
          if (data === undefined) {
            setBreakdown({ data: null, loading: false, error: null })
            return
          }
          setBreakdown({ data, loading: false, error: null })
        })
        .catch((e: unknown) => {
          if (!sectionCurrent(g)) return
          const aborted = (e as Error).name === "AbortError"
          setBreakdown({ data: null, loading: false, error: aborted ? null : e instanceof Error ? e.message : "Request failed" })
        })
      void runUrlEnrich((signal) => getUrlEnrichment(value, 3, { signal }))
        .then((data) => {
          if (!sectionCurrent(g)) return
          if (data === undefined) {
            setUrlEnrich({ data: null, loading: false, error: null })
            return
          }
          setUrlEnrich({ data, loading: false, error: null })
        })
        .catch((e: unknown) => {
          if (!sectionCurrent(g)) return
          const aborted = (e as Error).name === "AbortError"
          setUrlEnrich({ data: null, loading: false, error: aborted ? null : e instanceof Error ? e.message : "Request failed" })
        })
    }
  }, [active, kind, value, runProfile, runReport, runHostEnrich, runBreakdown, runUrlEnrich, sectionCurrent, sectionNext])

  const handleCopy = useCallback(async () => {
    const ok = await copyText(`${kind}:${value} @ ${generatedAt}`)
    toast(ok ? { title: "Reference copied", variant: "success" } : { title: "Copy failed", variant: "error" })
  }, [generatedAt, kind, toast, value])

  const enrichLoading = kind === "host" ? hostEnrich.loading : urlEnrich.loading
  const enrichError = kind === "host" ? hostEnrich.error : urlEnrich.error
  const enrichOk = kind === "host" ? hostEnrich.data !== null : urlEnrich.data !== null
  const profileOk = kind === "host" ? profile.data !== null : breakdown.data !== null
  const profileLoading = kind === "host" ? profile.loading : breakdown.loading
  const findingsOk = kind === "host" ? report.data !== null : breakdown.data !== null
  const findingsLoading = kind === "host" ? report.loading : breakdown.loading
  // es_online comes ONLY from the explicit /health probe (above). It is never
  // inferred from a section payload, which could describe a different request
  // than the data on screen.
  const esOnline = !health.checked ? "checking" : health.es === true ? "ok" : health.es === false ? "unreachable" : "unknown (not probed)"
  // No entity selected: the view can be restored from localStorage on a bare
  // reload while globalFilter (which carries the entity) only rehydrates from
  // ?q=. Render an explicit empty state rather than a blank-titled report.
  if (value.trim() === "") {
    return (
      <div className="space-y-5">
        <PageHeader title="Investigation report" description="Read-only case file" />
        <Panel title="No entity selected">
          <p className="text-sm text-muted-foreground">
            No entity selected — open this report from Host Investigation or URL Investigation.
          </p>
          <div className="mt-3">
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  // Which sources actually fed this report — stated explicitly so the reader
  const sourcesUsed = kind === "host"
    ? [
        profile.data ? "host profile (live ES / findings)" : null,
        report.data ? "findings (SQLite)" : null,
        (kind === "host" ? hostEnrich.data : urlEnrich.data) ? "enrichment" : null,
      ].filter(Boolean).join(", ") || "none resolved"
    : [
        breakdown.data ? "findings (SQLite)" : null,
        urlEnrich.data ? "enrichment" : null,
      ].filter(Boolean).join(", ") || "none resolved"

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Investigation report — ${value}`}
        description={`Read-only case file · generated ${generatedAt}`}
      >
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <Button variant="outline" onClick={() => void handleCopy()}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copy reference
        </Button>
      </PageHeader>

      <Panel title="01 · Provenance" icon={FileText}>
        <dl className="divide-y divide-border">
          <Field label="entity" value={value} />
          <Field label="kind" value={kind} />
          <Field label="window" value={kind === "host" ? "24h live + all-time findings" : "all-time findings"} />
          <Field label="generated_at" value={generatedAt} />
          <Field label="es_online" value={esOnline} />
          <Field label="sources" value={sourcesUsed} />
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Profile</span>
          {profileLoading ? <Badge variant="secondary">loading</Badge> : profileOk ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
          <span>Findings</span>
          {findingsLoading ? <Badge variant="secondary">loading</Badge> : findingsOk ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
          <span>Enrichment</span>
          {enrichLoading ? <Badge variant="secondary">loading</Badge> : enrichOk ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
        </div>
      </Panel>

      {kind === "host" ? (
        <Panel title="02 · Risk summary">
          {profile.loading ? (
            <div aria-busy="true" aria-live="polite">
              <span className="sr-only">Loading risk summary</span>
              <SkeletonShape variant="panel-stack" count={1} />
            </div>
          ) : profile.data ? (
            <RiskSummaryBody profile={profile.data} />
          ) : (
            <p className="text-sm text-muted-foreground">Section unavailable: {profile.error ?? "no profile"}</p>
          )}
        </Panel>
      ) : (
        <Panel title="02 · Risk summary">
          {breakdown.loading ? (
            <div aria-busy="true" aria-live="polite">
              <span className="sr-only">Loading risk summary</span>
              <SkeletonShape variant="panel-stack" count={1} />
            </div>
          ) : breakdown.data ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-2">
              <StatCard icon={FileText} label="Total accesses" value={breakdown.data.total_accesses.toLocaleString()} hint={breakdown.data.source} />
              <StatCard icon={FileText} label="Unique clients" value={breakdown.data.clients.length.toLocaleString()} tone="warning" hint="Distinct client IPs" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Section unavailable: {breakdown.error ?? "no breakdown"}</p>
          )}
        </Panel>
      )}

      <Panel title="03 · Indicators">
        {kind === "host" ? (
          report.loading ? (
            <div aria-busy="true" aria-live="polite">
              <span className="sr-only">Loading indicators</span>
              <SkeletonShape variant="panel-stack" count={3} />
            </div>
          ) : report.data ? (
            report.data.has_data === false ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No findings for this entity
              </p>
            ) : (
            <div className="space-y-5">
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Top domains
                </h4>
                <DataTable
                  columns={TOP_DOMAIN_COLUMNS}
                  data={report.data.top_domains.slice(0, 10)}
                  rowId={(r) => r.domain}
                  viewKey="report-domains"
                  ariaLabel="Top domains"
                  empty={{ icon: ShieldQuestion, title: "No data in window" }}
                />
              </section>
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Top patterns
                </h4>
                <DataTable
                  columns={TOP_PATTERN_COLUMNS}
                  data={report.data.top_patterns.slice(0, 10)}
                  rowId={(r) => r.pattern}
                  viewKey="report-patterns"
                  ariaLabel="Top patterns"
                  empty={{ icon: ShieldQuestion, title: "No data in window" }}
                />
              </section>
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Top URLs
                </h4>
                <DataTable
                  columns={TOP_URL_COLUMNS}
                  data={report.data.top_urls.slice(0, 10)}
                  rowId={(r) => r.url}
                  viewKey="report-urls"
                  ariaLabel="Top URLs"
                  empty={{ icon: ShieldQuestion, title: "No data in window" }}
                />
              </section>
            </div>
            )
          ) : (
            <p className="text-sm text-muted-foreground">Section unavailable: {report.error ?? "no report"}</p>
          )
        ) : breakdown.loading ? (
          <div aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading indicators</span>
            <SkeletonShape variant="panel-stack" count={1} />
          </div>
        ) : breakdown.data ? (
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Clients
            </h4>
            <DataTable
              columns={CLIENT_COLUMNS}
              data={breakdown.data.clients.slice(0, 25)}
              rowId={(r) => r.client_ip}
              viewKey="report-clients"
              ariaLabel="Clients"
              empty={{ icon: FileText, title: "No data in window" }}
            />
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">Section unavailable: {breakdown.error ?? "no breakdown"}</p>
        )}
      </Panel>

      <Panel title="04 · Network enrichment">
        {enrichLoading ? (
          <div aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading network enrichment</span>
            <SkeletonShape variant="panel-stack" count={1} />
          </div>
        ) : kind === "host" ? (
          hostEnrich.data ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">reverse_dns</span>
                <Badge variant={hostEnrich.data.reverse_dns.status === "ok" ? "success" : "secondary"}>{hostEnrich.data.reverse_dns.status}</Badge>
                <span className="text-muted-foreground">forward_dns</span>
                <Badge variant={hostEnrich.data.forward_dns.status === "ok" ? "success" : "secondary"}>{hostEnrich.data.forward_dns.status}</Badge>
                <span className="text-muted-foreground">rdap</span>
                <Badge variant={hostEnrich.data.rdap.status === "ok" ? "success" : "secondary"}>{hostEnrich.data.rdap.status}</Badge>
                <span className="font-mono text-muted-foreground">{hostEnrich.data.ip_version}</span>
              </div>
              <dl className="divide-y divide-border">
                <Field label="reverse_dns" value={hostEnrich.data.reverse_dns.hostname?.trim() ? hostEnrich.data.reverse_dns.hostname : "—"} />
                {lookupError(hostEnrich.data.reverse_dns.status, hostEnrich.data.reverse_dns.error) && (
                  <Field label="reverse_dns error" value={lookupError(hostEnrich.data.reverse_dns.status, hostEnrich.data.reverse_dns.error) ?? ""} />
                )}
                <Field label="forward_dns" value={hostEnrich.data.forward_dns.addresses?.length ? hostEnrich.data.forward_dns.addresses.join(", ") : "—"} />
                <Field label="rdap_org" value={hostEnrich.data.rdap.org?.trim() ? hostEnrich.data.rdap.org : "—"} />
                <Field label="rdap_handle" value={hostEnrich.data.rdap.handle?.trim() ? hostEnrich.data.rdap.handle : "—"} />
                <Field label="rdap_country" value={hostEnrich.data.rdap.country?.trim() ? hostEnrich.data.rdap.country : "—"} />
                <Field label="abuse_contact" value={hostEnrich.data.rdap.abuse_contact?.trim() ? hostEnrich.data.rdap.abuse_contact : "—"} />
                {hostEnrich.data.notes.length > 0 && <Field label="notes" value={hostEnrich.data.notes.join("; ")} />}
                {lookupError(hostEnrich.data.rdap.status, hostEnrich.data.rdap.error) && (
                  <Field label="rdap error" value={lookupError(hostEnrich.data.rdap.status, hostEnrich.data.rdap.error) ?? ""} />
                )}
              </dl>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Enrichment unavailable{enrichError ? `: ${enrichError}` : ""}</p>
          )
        ) : urlEnrich.data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">reverse_dns</span>
              <Badge variant={urlEnrich.data.reverse_dns.status === "ok" ? "success" : "secondary"}>{urlEnrich.data.reverse_dns.status}</Badge>
              <span className="text-muted-foreground">tls</span>
              <Badge variant={urlEnrich.data.tls.status === "ok" ? "success" : "secondary"}>{urlEnrich.data.tls.status}</Badge>
              <span className="text-muted-foreground">http</span>
              <Badge variant={urlEnrich.data.http.status === "ok" ? "success" : "secondary"}>{urlEnrich.data.http.status}</Badge>
              <span className="text-muted-foreground">rdap</span>
              <Badge variant={urlEnrich.data.rdap.status === "ok" ? "success" : "secondary"}>{urlEnrich.data.rdap.status}</Badge>
              {urlEnrich.data.is_ip_literal && <Badge variant="warning">ip-literal</Badge>}
            </div>
            <dl className="divide-y divide-border">
              <Field label="host" value={urlEnrich.data.host.trim() ? urlEnrich.data.host : "—"} />
              <Field label="resolved_ips" value={urlEnrich.data.resolved_ips.length ? urlEnrich.data.resolved_ips.join(", ") : "—"} />
              <Field label="reverse_dns" value={urlEnrich.data.reverse_dns.hostname?.trim() ? urlEnrich.data.reverse_dns.hostname : "—"} />
              <Field label="tls_subject" value={urlEnrich.data.tls.subject?.trim() ? urlEnrich.data.tls.subject : "—"} />
              <Field label="tls_issuer" value={urlEnrich.data.tls.issuer?.trim() ? urlEnrich.data.tls.issuer : "—"} />
              <Field label="tls_not_after" value={urlEnrich.data.tls.not_after?.trim() ? urlEnrich.data.tls.not_after : "—"} />
              <Field label="http_status" value={urlEnrich.data.http.status_code === null ? "—" : String(urlEnrich.data.http.status_code)} />
              <Field label="http_server" value={urlEnrich.data.http.server?.trim() ? urlEnrich.data.http.server : "—"} />
              <Field label="final_url" value={urlEnrich.data.http.final_url?.trim() ? urlEnrich.data.http.final_url : "—"} />
              <Field label="rdap_org" value={urlEnrich.data.rdap.org?.trim() ? urlEnrich.data.rdap.org : "—"} />
              <Field label="rdap_country" value={urlEnrich.data.rdap.country?.trim() ? urlEnrich.data.rdap.country : "—"} />
              {urlEnrich.data.notes.length > 0 && <Field label="notes" value={urlEnrich.data.notes.join("; ")} />}
              {lookupError(urlEnrich.data.reverse_dns.status, urlEnrich.data.reverse_dns.error) && (
                <Field label="reverse_dns error" value={lookupError(urlEnrich.data.reverse_dns.status, urlEnrich.data.reverse_dns.error) ?? ""} />
              )}
              {lookupError(urlEnrich.data.tls.status, urlEnrich.data.tls.error) && (
                <Field label="tls error" value={lookupError(urlEnrich.data.tls.status, urlEnrich.data.tls.error) ?? ""} />
              )}
              {lookupError(urlEnrich.data.http.status, urlEnrich.data.http.error) && (
                <Field label="http error" value={lookupError(urlEnrich.data.http.status, urlEnrich.data.http.error) ?? ""} />
              )}
              {lookupError(urlEnrich.data.rdap.status, urlEnrich.data.rdap.error) && (
                <Field label="rdap error" value={lookupError(urlEnrich.data.rdap.status, urlEnrich.data.rdap.error) ?? ""} />
              )}
            </dl>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Enrichment unavailable{enrichError ? `: ${enrichError}` : ""}</p>
        )}
      </Panel>

      <Panel title="06 · Notes & next steps">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Verify enrichment against a second source</li>
          <li>Decide whitelist/blacklist/jaillist disposition</li>
          <li>Attach screenshots to ticket</li>
        </ul>
        {kind === "host" && profile.data && (() => {
          // Same discriminant narrowing as RiskSummaryBody/HostEntityCard: an
          // unmeasured risk must not print a level+score badge on this
          // screenshot-safe, ticket-attachable panel (a fabricated `LOW 0/100`).
          const reason = profile.data.risk.riskReason
          const unavailable =
            reason && "state" in reason && reason.state === "unavailable" ? reason : null
          return (
            <div className="mt-3">
              {unavailable ? (
                <Badge variant="secondary">Risk not computed — score unavailable</Badge>
              ) : (
                <Badge variant={profile.data.risk.riskLevel === "HIGH" ? "destructive" : profile.data.risk.riskLevel === "MEDIUM" ? "warning" : "success"}>{profile.data.risk.riskLevel} {profile.data.risk.riskScore}/100</Badge>
              )}
            </div>
          )
        })()}
      </Panel>

      <p className="font-mono text-xs text-muted-foreground">
        uNetWatch case file · {kind}:{value} · generated {generatedAt} · sources: ES/findings/blacklist/enrichment · screenshot-safe
      </p>
    </div>
  )
}

export default ReportPage
