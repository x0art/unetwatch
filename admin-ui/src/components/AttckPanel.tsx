import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import { Badge, Button, Callout, EmptyState, Panel, SimpleTable, Skeleton, StatusBadge, type StatusTone } from "./ui"
import { type AttckMapping } from "../api"

interface Props {
  mapping: AttckMapping | null
  loading: boolean
  error: string | null
  entityLabel: string
  /** True when the host page already supplies its own Panel title, so the
   * panel must not render a second, duplicate heading. */
  embedded?: boolean
  /** In-place refetch for a failed mapping. When omitted the Retry control is
   * hidden entirely — never fall back to a page reload, which would discard
   * session state (e.g. the unpersisted global filter) and land the user on an
   * empty-entity report. */
  onRetry?: () => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  // `new Date("garbage")` does not throw — it yields an Invalid Date, which
  // would otherwise render as the literal string "Invalid Date".
  if (Number.isNaN(d.getTime())) return iso || "—"
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

/** Severity → `StatusBadge` tone. Identical mapping to `AttckFleetPage`'s
 *  `severityTone` so severity reads the same way on both surfaces. */
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
export function AttckPanel({ mapping, loading, error, entityLabel, embedded = false, onRetry }: Props) {
  const hasTechniques = !!mapping && mapping.techniques.length > 0
  const hasHighSeverity =
    !!mapping && mapping.techniques.some((t) => t.severity === "HIGH")
  // A suppressed technique produces no row in `techniques`, so without this
  // the panel would show "no techniques detected" and hide the fact that the
  // engine actively withheld them for absent fields. Only render rows the
  // backend actually reported (id + reason).
  const suppressed = (mapping?.signals?.suppressed ?? []).filter(
    (s) => !!s?.id && !!s?.reason,
  )
  // Icon reads the real state: an offline/empty mapping must NOT show the
  // green "all clear" shield that a clean result would show.
  const panelIcon = hasTechniques
    ? (hasHighSeverity ? ShieldAlert : ShieldCheck)
    : ShieldQuestion

  return (
    <Panel
      title={embedded ? undefined : "MITRE ATT&CK Mapping"}
      icon={embedded ? undefined : panelIcon}
    >
      {loading && (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading ATT&CK mapping</span>
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {!loading && !mapping && !error && (
        <p className="text-sm text-muted-foreground">
          Enter a {entityLabel.toLowerCase()} or URL to view ATT&CK mapping.
        </p>
      )}
      {!loading && error && (
        <Callout
          tone="danger"
          className="flex-col items-start gap-2"
          action={
            onRetry ? (
              <Button variant="outline" size="sm" className="self-start text-[11px]" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {error}
        </Callout>
      )}
      {!loading && !error && mapping && (
        <div className="space-y-4">
          {mapping.es_online === false && (
            <p className="text-xs text-muted-foreground italic">
              Elasticsearch unavailable — mapping unavailable.
            </p>
          )}
          {mapping.summary && (
            <p className="text-sm text-muted-foreground">{mapping.summary}</p>
          )}
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
          <SimpleTable
            className="group"
            ariaLabel="MITRE ATT&CK techniques"
            data={mapping.techniques}
            rowKey={(tech) => tech.technique_id}
            empty={<EmptyState icon={ShieldQuestion} title="No ATT&CK techniques detected for this entity." className="border-0" />}
            columns={[
              {
                id: "id",
                header: "Technique ID",
                cell: (tech) => (
                  <span className="font-mono text-xs text-muted-foreground align-top">
                    {tech.technique_id}
                  </span>
                ),
              },
              {
                id: "name",
                header: "Name",
                cell: (tech) => <span className="font-medium align-top">{tech.name}</span>,
              },
              {
                id: "severity",
                header: "Severity",
                cell: (tech) => (
                  <span className="align-top">
                    <StatusBadge tone={severityTone(tech.severity)}>{tech.severity}</StatusBadge>
                  </span>
                ),
              },
              {
                id: "rationale",
                header: "Rationale",
                cell: (tech) => (
                  <p
                    className="line-clamp-2 break-words text-xs text-muted-foreground group-hover:text-foreground align-top"
                    title={tech.description}
                  >
                    {tech.description}
                  </p>
                ),
              },
            ]}
          />
          {suppressed.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {suppressed.length} technique
                {suppressed.length === 1 ? "" : "s"} withheld — required field
                {suppressed.length === 1 ? " was" : "s were"} absent:
              </p>
              <ul className="space-y-1">
                {suppressed.map((s) => (
                  <li key={s.id} className="flex gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">
                      {s.id}
                    </span>
                    <span className="break-words text-muted-foreground/80">
                      {s.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
