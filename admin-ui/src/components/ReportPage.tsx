import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, Copy, FileText, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import {
  getClientReport,
  getHostAttckMapping,
  getHostEnrichment,
  getHostProfile,
  getUrlAttckMapping,
  getUrlBreakdown,
  getUrlEnrichment,
  probeEsHealth,
  type AttckMapping,
  type ClientReport,
  type EnrichHost,
  type EnrichUrl,
  type HostProfile,
  type UrlBreakdown,
} from "../api"
import { copyText } from "../lib/utils"
import { AttckPanel } from "./AttckPanel"
import {
  Badge,
  Button,
  PageHeader,
  Panel,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"

interface Props {
  kind: "host" | "url"
  value: string
  onBack: () => void
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

/** Panel icon for section 05, mirroring AttckPanel's own state logic so the
 * embedded panel still signals "nothing assessed" rather than "all clear". */
function attckIcon(mapping: AttckMapping | null) {
  if (!mapping || mapping.techniques.length === 0) return ShieldQuestion
  return mapping.techniques.some((t) => t.severity === "HIGH") ? ShieldAlert : ShieldCheck
}

/** Shared indicator table for report section 03. All four tables (host
 * domains/patterns/urls, url clients) were byte-identical markup differing
 * only in column labels and cell rendering, so they share one implementation
 * — this is also what keeps their empty states consistent. */
function IndicatorTable<T>({
  title, columns, rows, emptyLabel, renderRow, rowKey,
}: {
  title: string
  columns: { label: string; align?: "left" | "right" }[]
  rows: T[]
  emptyLabel: string
  renderRow: (row: T) => ReactNode
  rowKey: (row: T, index: number) => string
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              {columns.map((c) => (
                <th key={c.label} scope="col" className={c.align === "right" ? "pb-2 text-right font-medium" : "pb-2 pr-4 font-medium"}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-8 text-center text-sm text-muted-foreground">
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => <tr key={rowKey(row, i)}>{renderRow(row)}</tr>)
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ReportPage({ kind, value, onBack }: Props) {
  const { toast } = useToast()
  const [generatedAt, setGeneratedAt] = useState(() => new Date().toISOString())

  const [profile, setProfile] = useState<SectionState<HostProfile>>({ data: null, loading: true, error: null })
  const [report, setReport] = useState<SectionState<ClientReport>>({ data: null, loading: true, error: null })
  const [hostAttck, setHostAttck] = useState<SectionState<AttckMapping>>({ data: null, loading: true, error: null })
  const [hostEnrich, setHostEnrich] = useState<SectionState<EnrichHost>>({ data: null, loading: true, error: null })
  const [breakdown, setBreakdown] = useState<SectionState<UrlBreakdown>>({ data: null, loading: true, error: null })
  const [urlAttck, setUrlAttck] = useState<SectionState<AttckMapping>>({ data: null, loading: true, error: null })
  const [urlEnrich, setUrlEnrich] = useState<SectionState<EnrichUrl>>({ data: null, loading: true, error: null })
  // Explicit ES-reachability probe — NEVER inferred from a section payload.
  // /health always answers and reports dependencies.elasticsearch as
  // "ok" | "unreachable" (app/main.py:257-303).
  const [health, setHealth] = useState<{ checked: boolean; es: boolean | null }>({ checked: false, es: null })
  useEffect(() => {
    let cancelled = false
    void probeEsHealth()
      .then((es) => { if (!cancelled) setHealth({ checked: true, es }) })
      .catch(() => { if (!cancelled) setHealth({ checked: true, es: null }) })
    return () => { cancelled = true }
  }, [])

  // Single ATT&CK loader shared by the main effect and section 05's Retry, so
  // a failed mapping can be refetched in place without a page reload.
  const fetchAttck = useCallback(() => {
    const set = kind === "host" ? setHostAttck : setUrlAttck
    set({ data: null, loading: true, error: null })
    const req = kind === "host"
      ? getHostAttckMapping(value, { timeRange: "24h" })
      : getUrlAttckMapping(value, { source: "findings", limit: 100 })
    return req
      .then((data) => set({ data, loading: false, error: null }))
      .catch((e: unknown) => set({ data: null, loading: false, error: e instanceof Error ? e.message : "Request failed" }))
  }, [kind, value])
  useEffect(() => {
    // Re-stamp on every refetch so the timestamp always belongs to the data
    // currently on screen (report views stay mounted; switching entity only
    // re-runs this effect).
    setGeneratedAt(new Date().toISOString())
    // No entity selected (e.g. a bare reload restoring the view from
    // localStorage with no ?q=) — never issue a fetch with an empty value.
    if (value.trim() === "") return
    let cancelled = false
    if (kind === "host") {
      setProfile({ data: null, loading: true, error: null })
      setReport({ data: null, loading: true, error: null })
      setHostAttck({ data: null, loading: true, error: null })
      setHostEnrich({ data: null, loading: true, error: null })
      void getHostProfile(value, "24h")
        .then((data) => { if (!cancelled) setProfile({ data, loading: false, error: null }) })
        .catch((e: unknown) => { if (!cancelled) setProfile({ data: null, loading: false, error: e instanceof Error ? e.message : "Request failed" }) })
      void getClientReport(value)
        .then((data) => { if (!cancelled) setReport({ data, loading: false, error: null }) })
        .catch((e: unknown) => { if (!cancelled) setReport({ data: null, loading: false, error: e instanceof Error ? e.message : "Request failed" }) })
      void fetchAttck()
      void getHostEnrichment(value)
        .then((data) => { if (!cancelled) setHostEnrich({ data, loading: false, error: null }) })
        .catch((e: unknown) => { if (!cancelled) setHostEnrich({ data: null, loading: false, error: e instanceof Error ? e.message : "Request failed" }) })
    } else {
      setBreakdown({ data: null, loading: true, error: null })
      setUrlAttck({ data: null, loading: true, error: null })
      setUrlEnrich({ data: null, loading: true, error: null })
      void getUrlBreakdown(value, { limit: 100, source: "findings" })
        .then((data) => { if (!cancelled) setBreakdown({ data, loading: false, error: null }) })
        .catch((e: unknown) => { if (!cancelled) setBreakdown({ data: null, loading: false, error: e instanceof Error ? e.message : "Request failed" }) })
      void fetchAttck()
      void getUrlEnrichment(value)
        .then((data) => { if (!cancelled) setUrlEnrich({ data, loading: false, error: null }) })
        .catch((e: unknown) => { if (!cancelled) setUrlEnrich({ data: null, loading: false, error: e instanceof Error ? e.message : "Request failed" }) })
    }
    return () => { cancelled = true }
    // fetchAttck is memoized on [kind, value] — the same keys this effect uses —
    // so including it here changes nothing but satisfies exhaustive-deps.
  }, [kind, value, fetchAttck])

  const handleCopy = useCallback(async () => {
    const ok = await copyText(`${kind}:${value} @ ${generatedAt}`)
    toast(ok ? { title: "Reference copied", variant: "success" } : { title: "Copy failed", variant: "error" })
  }, [generatedAt, kind, toast, value])

  const attck = kind === "host" ? hostAttck : urlAttck
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
        attck.data ? "ATT&CK mapping" : null,
        (kind === "host" ? hostEnrich.data : urlEnrich.data) ? "enrichment" : null,
      ].filter(Boolean).join(", ") || "none resolved"
    : [
        breakdown.data ? "findings (SQLite)" : null,
        attck.data ? "ATT&CK mapping" : null,
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
          {kind === "host" && profile.data?.placeholder && (
            <div className="mt-3">
              <Badge variant="destructive">SYNTHETIC / DEMO DATA — not evidence</Badge>
            </div>
          )}
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Profile</span>
          {profileLoading ? <Badge variant="secondary">loading</Badge> : profileOk ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
          <span>Findings</span>
          {findingsLoading ? <Badge variant="secondary">loading</Badge> : findingsOk ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
          <span>ATT&CK</span>
          {attck.loading ? <Badge variant="secondary">loading</Badge> : attck.data !== null ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
          <span>Enrichment</span>
          {enrichLoading ? <Badge variant="secondary">loading</Badge> : enrichOk ? <Badge variant="success">ok</Badge> : <Badge variant="secondary">unavailable</Badge>}
        </div>
      </Panel>

      {kind === "host" ? (
        <Panel title="02 · Risk summary">
          {profile.loading ? (
            <div aria-busy="true" aria-live="polite">
              <span className="sr-only">Loading risk summary</span>
              <Skeleton className="h-28 w-full" />
            </div>
          ) : profile.data ? (
            <div className="space-y-3">
              {profile.data.placeholder && (
                <Badge variant="destructive">SYNTHETIC / DEMO DATA — not evidence</Badge>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  icon={FileText}
                  label="Risk score"
                  value={`${profile.data.risk.riskScore}/100`}
                  tone={profile.data.risk.riskLevel === "HIGH" ? "danger" : profile.data.risk.riskLevel === "MEDIUM" ? "warning" : "success"}
                  hint={`Level ${profile.data.risk.riskLevel}`}
                />
                <StatCard icon={FileText} label="Total requests" value={profile.data.risk.totalRequests.toLocaleString()} hint={profile.data.hostname || profile.data.primaryIp} />
                <StatCard icon={FileText} label="Risk requests" value={profile.data.risk.riskRequests.toLocaleString()} tone="warning" hint="ALLOW pattern matches" />
                <StatCard icon={FileText} label="Enforcements" value={profile.data.risk.enforcements.toLocaleString()} tone="info" hint={`${profile.data.risk.enforcementsPct.toFixed(1)}% enforced`} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Section unavailable: {profile.error ?? "no profile"}</p>
          )}
        </Panel>
      ) : (
        <Panel title="02 · Risk summary">
          {breakdown.loading ? (
            <div aria-busy="true" aria-live="polite">
              <span className="sr-only">Loading risk summary</span>
              <Skeleton className="h-28 w-full" />
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
              <Skeleton className="h-40 w-full" />
            </div>
          ) : report.data ? (
            report.data.has_data === false ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No findings for this entity
              </p>
            ) : (
            <div className="space-y-5">
              <IndicatorTable
                title="Top domains"
                emptyLabel="No data in window"
                columns={[{ label: "Domain" }, { label: "Count", align: "right" }, { label: "Share", align: "right" }]}
                rows={report.data.top_domains.slice(0, 10)}
                rowKey={(r) => r.domain}
                renderRow={(r) => (
                  <>
                    <td className="py-2 pr-4 font-mono text-xs">{r.domain}</td>
                    <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">{r.count.toLocaleString()}</td>
                    <td className="py-2 text-right font-mono text-xs tabular-nums">{r.pct.toFixed(1)}%</td>
                  </>
                )}
              />
              <IndicatorTable
                title="Top patterns"
                emptyLabel="No data in window"
                columns={[{ label: "Pattern" }, { label: "Hits", align: "right" }]}
                rows={report.data.top_patterns.slice(0, 10)}
                rowKey={(r) => r.pattern}
                renderRow={(r) => (
                  <>
                    <td className="py-2 pr-4 font-mono text-xs">{r.pattern}</td>
                    <td className="py-2 text-right font-mono text-xs tabular-nums">{r.hits.toLocaleString()}</td>
                  </>
                )}
              />
              <IndicatorTable
                title="Top URLs"
                emptyLabel="No data in window"
                columns={[{ label: "URL" }, { label: "Count", align: "right" }]}
                rows={report.data.top_urls.slice(0, 10)}
                rowKey={(r) => r.url}
                renderRow={(r) => (
                  <>
                    <td className="max-w-[420px] truncate py-2 pr-4 font-mono text-xs" title={r.url}>{r.url}</td>
                    <td className="py-2 text-right font-mono text-xs tabular-nums">{r.count.toLocaleString()}</td>
                  </>
                )}
              />
            </div>
            )
          ) : (
            <p className="text-sm text-muted-foreground">Section unavailable: {report.error ?? "no report"}</p>
          )
        ) : breakdown.loading ? (
          <div aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading indicators</span>
            <Skeleton className="h-40 w-full" />
          </div>
        ) : breakdown.data ? (
          <IndicatorTable
            title="Clients"
            emptyLabel="No data in window"
            columns={[{ label: "Client IP" }, { label: "Accesses", align: "right" }, { label: "Last seen" }]}
            rows={breakdown.data.clients.slice(0, 25)}
            rowKey={(r) => r.client_ip}
            renderRow={(r) => (
              <>
                <td className="py-2 pr-4 font-mono text-xs">{r.client_ip}</td>
                <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums">{r.count.toLocaleString()}</td>
                <td className="whitespace-nowrap py-2 font-mono text-xs text-muted-foreground">{r.last_seen}</td>
              </>
            )}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Section unavailable: {breakdown.error ?? "no breakdown"}</p>
        )}
      </Panel>

      <Panel title="04 · Network enrichment">
        {enrichLoading ? (
          <div aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading network enrichment</span>
            <Skeleton className="h-32 w-full" />
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
      <Panel
        title="05 · MITRE ATT&CK"
        icon={attckIcon(attck.data)}
      >
        <AttckPanel
          onRetry={() => void fetchAttck()}
          embedded
          mapping={attck.data}
          loading={attck.loading}
          error={attck.error}
          entityLabel={kind === "host" ? "Host" : "URL"}
        />
      </Panel>

      <Panel title="06 · Notes & next steps">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Verify enrichment against a second source</li>
          <li>Decide whitelist/blacklist/jaillist disposition</li>
          <li>Attach screenshots to ticket</li>
        </ul>
        {kind === "host" && profile.data && (
          <div className="mt-3">
            <Badge variant={profile.data.risk.riskLevel === "HIGH" ? "destructive" : profile.data.risk.riskLevel === "MEDIUM" ? "warning" : "success"}>{profile.data.risk.riskLevel} {profile.data.risk.riskScore}/100</Badge>
          </div>
        )}
      </Panel>

      <p className="font-mono text-xs text-muted-foreground">
        uNetWatch case file · {kind}:{value} · generated {generatedAt} · sources: ES/findings/blacklist/enrichment · screenshot-safe
      </p>
    </div>
  )
}

export default ReportPage
