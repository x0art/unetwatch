import { type ReactNode } from "react"
import { cn } from "../lib/utils"

/* ════════════════════════════════════════════════════════════════
 * ClusterFlow — clustered flow visualization
 *
 * Renders the "url1->| / url2->| final_url1 / url3->|" layout: a group of
 * source items on the left, each with a connector arrow, feeding into one
 * destination card on the right. Groups stack vertically.
 *
 *   <ClusterFlow
 *     groups={[
 *       {
 *         id: "dest-1",
 *         title: "https://final.example/",
 *         badge: <Badge>3 sources</Badge>,
 *         subtitle: "301 · permanent redirect",
 *         sources: [
 *           { id: "u1", label: "https://a.example/x" },
 *           { id: "u2", label: "https://b.example/y", meta: "12 req" },
 *         ],
 *       },
 *     ]}
 *   />
 * ════════════════════════════════════════════════════════════════ */

export interface ClusterFlowSource {
  id: string
  label: string
  /** Right-aligned extra info (e.g. request count). */
  meta?: ReactNode
  /** Full label for tooltip when truncated. */
  title?: string
  tone?: "default" | "muted" | "success" | "warning" | "danger"
}

export interface ClusterFlowGroup {
  id: string
  /** Destination shown in the card (final_url / base_url). */
  title: string
  subtitle?: ReactNode
  /** Small badge rendered above the destination title. */
  badge?: ReactNode
  sources: ClusterFlowSource[]
  /** Card accent color. */
  tone?: "default" | "success" | "warning" | "danger" | "info"
}

const CARD_ACCENT: Record<NonNullable<ClusterFlowGroup["tone"]>, string> = {
  default: "border-border",
  success: "border-success/40",
  warning: "border-warning/40",
  danger: "border-danger/40",
  info: "border-info/40",
}

const SOURCE_TONE: Record<NonNullable<ClusterFlowSource["tone"]>, string> = {
  default: "border-border/60 bg-muted/40 text-foreground/90",
  muted: "border-border/50 bg-muted/20 text-muted-foreground",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
}

export function ClusterFlow({
  groups,
  maxSourcesPerGroup = 12,
  onSourceClick,
  className,
}: {
  groups: ClusterFlowGroup[]
  /** Cap the number of source rows per group; extras collapse to "+N more". */
  maxSourcesPerGroup?: number
  /** Optional click handler on a source row (e.g. to filter the table). */
  onSourceClick?: (group: ClusterFlowGroup, source: ClusterFlowSource) => void
  className?: string
}) {
  if (groups.length === 0) return null

  return (
    <div className={cn("space-y-3", className)} role="img" aria-label="Flow clustered by destination">
      {groups.map((group) => {
        const visible = group.sources.slice(0, maxSourcesPerGroup)
        const hidden = group.sources.length - visible.length
        return (
          <div key={group.id} className="flex items-stretch gap-2">
            {/* Sources column — the shared vertical bar is its right border */}
            <div className="flex min-w-0 flex-1 flex-col justify-center border-r-2 border-border/70 py-1">
              {visible.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-[3px]">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-md border px-2 py-1 font-mono text-[11px] leading-none",
                      SOURCE_TONE[s.tone ?? "default"],
                      onSourceClick && "cursor-pointer transition-colors hover:border-info/50 hover:bg-info/10",
                    )}
                    title={s.title ?? s.label}
                    onClick={onSourceClick ? () => onSourceClick(group, s) : undefined}
                  >
                    {s.label}
                  </span>
                  {s.meta && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {s.meta}
                    </span>
                  )}
                  {/* Connector arrow meeting the shared vertical bar */}
                  <span className="relative h-px w-7 shrink-0 bg-border/70" aria-hidden="true">
                    <span className="absolute -top-[2.5px] right-0 h-1.5 w-1.5 rotate-45 border-t-2 border-r-2 border-muted-foreground/60" />
                  </span>
                </div>
              ))}
              {hidden > 0 && (
                <p className="py-[3px] pl-2 text-[11px] text-muted-foreground">
                  +{hidden} more…
                </p>
              )}
            </div>

            {/* Destination card */}
            <div
              className={cn(
                "flex w-[min(46%,430px)] shrink-0 flex-col justify-center rounded-lg border bg-card px-4 py-3 shadow-sm",
                CARD_ACCENT[group.tone ?? "default"],
              )}
            >
              {group.badge && <div className="mb-1">{group.badge}</div>}
              <p
                className="truncate font-mono text-xs font-semibold tracking-tight"
                title={group.title}
              >
                {group.title}
              </p>
              {group.subtitle && (
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {group.subtitle}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
