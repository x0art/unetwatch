import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import { Badge, Button, Panel, Skeleton } from "./ui"
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
export function AttckPanel({ mapping, loading, error, entityLabel, embedded = false, onRetry }: Props) {
  const hasTechniques = !!mapping && mapping.techniques.length > 0
  const hasHighSeverity =
    !!mapping && mapping.techniques.some((t) => t.severity === "HIGH")
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
        <div className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <span>{error}</span>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="self-start text-[11px]"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
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
          {mapping.techniques.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No ATT&CK techniques detected for this entity.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="pb-2 pr-4 font-medium">Technique ID</th>
                    <th scope="col" className="pb-2 pr-4 font-medium">Name</th>
                    <th scope="col" className="pb-2 pr-4 font-medium">Severity</th>
                    <th scope="col" className="pb-2 font-medium">Rationale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {mapping.techniques.map((tech) => (
                    <tr key={tech.technique_id} className="group">
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground align-top">
                        {tech.technique_id}
                      </td>
                      <td className="py-2 pr-4 font-medium align-top">
                        {tech.name}
                      </td>
                      <td className="py-2 pr-4 align-top">
                        <Badge variant={severityVariant(tech.severity)}>
                          {tech.severity}
                        </Badge>
                      </td>
                      <td className="py-2 align-top">
                        <p
                          className="line-clamp-2 break-words text-xs text-muted-foreground group-hover:text-foreground"
                          title={tech.description}
                        >
                          {tech.description}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
