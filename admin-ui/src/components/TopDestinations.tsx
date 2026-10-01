import { SimpleTable, StatusBadge } from "./ui"
import { cn } from "../lib/utils"

export interface TopDomain {
  domain: string
  count: number
  /** Percentage share of the whole window (0..100). */
  pct: number
  /** True when this domain's rows matched a block pattern (flag — distinct
   * from an ordinary top destination). Set from the backend's
   * `flaggedDomains` when that list is supplied. */
  flagged?: boolean
  /** Optional caption clarifying what `count` measures. Used to label the
   * backend's flagged-domain counts honestly as pattern matches. */
  countLabel?: string
}

export interface TriggeredPattern {
  pattern: string
  hits: number
}

interface TopDestinationsProps {
  topDomains: TopDomain[]
  triggeredPatterns: TriggeredPattern[]
  /** Optional header caption, overridden when the backend's flagged-domain
   * list is rendered so the numbers are never read as total access volume. */
  domainsCaption?: string
  className?: string
}

export function TopDestinations({ topDomains, triggeredPatterns, domainsCaption, className }: TopDestinationsProps) {
  const maxDomain = Math.max(1, ...topDomains.map((d) => (Number.isFinite(d.count) ? d.count : 0)))
  const maxHits = Math.max(1, ...triggeredPatterns.map((p) => p.hits))

  return (
    <div className={cn("rounded-md border border-border bg-card shadow-sm overflow-hidden", className)}>
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight">Top Destinations &amp; Rule Matches</h3>
        <span className="ml-auto hidden text-xs font-medium text-muted-foreground sm:inline">
          {domainsCaption ?? "Destinations ranked by volume · rules by trigger count"}
        </span>
      </div>

      <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        {/* ── Left: Top Accessed Domains ─────────────────────────────── */}
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="text-xs font-medium text-muted-foreground">
              Top accessed domains
            </span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {topDomains.length > 0
                ? `${topDomains.length} domain${topDomains.length === 1 ? "" : "s"}`
                : "—"}
            </span>
          </div>
          <SimpleTable
            ariaLabel="Top accessed domains"
            data={topDomains}
            rowKey={(d) => d.domain}
            columns={[
              {
                id: "rank",
                header: "#",
                width: "w-10",
                cell: (_d, i) => (
                  <span className={cn("font-mono text-xs font-bold", i < 3 ? "text-foreground" : "text-muted-foreground")}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                ),
              },
              {
                id: "domain",
                header: "Domain",
                // The badge/truncated-domain/bar layout (and the warning bar tint for
                // flagged rows) is passed as a custom cell; the shared `bar` slot only
                // draws the canonical `bg-primary/60` bar, so we reproduce it here to
                // preserve the flagged-vs-normal colour distinction.
                cell: (d) => (
                  <div className="flex min-w-0 items-center gap-2">
                    {d.flagged ? (
                      // Shared status pill; the `text-[10px]` override is kept
                      // because this is an inline chip inside a table cell and
                      // StatusBadge's default `text-xs` would widen the row.
                      // Corners/tint/hover now come from the primitive so the
                      // `rounded-full` copy can't drift again.
                      <StatusBadge
                        tone="warning"
                        title="Destination reached through a block-pattern match"
                        className="px-1.5 text-[10px]"
                      >
                        Flagged
                      </StatusBadge>
                    ) : null}
                    <span className="block max-w-[220px] truncate font-mono text-[13px] font-semibold" title={d.domain}>
                      {d.domain}
                    </span>
                    <div className="h-1.5 min-w-[24px] flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div
                        className={cn("h-full rounded-full", d.flagged ? "bg-warning" : "bg-primary")}
                        style={{ width: `${Math.max(2, (d.count / maxDomain) * 100)}%` }}
                      />
                    </div>
                  </div>
                ),
              },
              {
                id: "share",
                header: "Share",
                align: "right",
                width: "w-28",
                cell: (d) => (
                  <span className="font-mono text-[13px] font-bold tabular-nums">
                    {d.pct.toFixed(0)}%
                    <span className="ml-1.5 font-normal text-muted-foreground" title={d.countLabel}>
                      ({d.count.toLocaleString()}
                      {d.countLabel ? ` ${d.countLabel}` : ""})
                    </span>
                  </span>
                ),
              },
            ]}
          />
        </div>

        {/* ── Right: Triggered URL Patterns ──────────────────────────── */}
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="text-xs font-medium text-muted-foreground">
              Triggered URL patterns
            </span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {triggeredPatterns.length > 0
                ? `${triggeredPatterns.length} pattern${triggeredPatterns.length === 1 ? "" : "s"}`
                : "—"}
            </span>
          </div>
          <SimpleTable
            ariaLabel="Triggered URL patterns"
            data={triggeredPatterns}
            rowKey={(p) => p.pattern}
            columns={[
              {
                id: "pattern",
                header: "Pattern",
                cell: (p) => (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="block max-w-[240px] truncate font-mono text-[13px] font-semibold" title={p.pattern}>
                      {p.pattern}
                    </span>
                    {/* Always the warning tint (never primary) — matches the old table. */}
                    <div className="h-1.5 min-w-[24px] flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-warning"
                        style={{ width: `${Math.max(2, (p.hits / maxHits) * 100)}%` }}
                      />
                    </div>
                  </div>
                ),
              },
              {
                id: "hits",
                header: "Hits",
                align: "right",
                width: "w-24",
                cell: (p) => (
                  <span className="font-mono text-[13px] font-bold tabular-nums">
                    {p.hits.toLocaleString()}
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}