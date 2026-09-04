import { Stagger, StaggerItem } from "./motion"
import { cn } from "../lib/utils"

export interface TopDomain {
  domain: string
  count: number
  /** Percentage share of the whole window (0..100). */
  pct: number
}

export interface TriggeredPattern {
  pattern: string
  hits: number
}

interface TopDestinationsProps {
  topDomains: TopDomain[]
  triggeredPatterns: TriggeredPattern[]
  className?: string
}

/** Shared empty-state cell for both NOC table halves. */
function EmptyCell() {
  return (
    <p className="py-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
      NO DATA IN WINDOW
    </p>
  )
}

export function TopDestinations({ topDomains, triggeredPatterns, className }: TopDestinationsProps) {
  const maxDomain = Math.max(1, ...topDomains.map((d) => d.count))
  const maxHits = Math.max(1, ...triggeredPatterns.map((p) => p.hits))

  return (
    <div className={cn("brutal-card overflow-hidden", className)}>
      <div className="flex items-center gap-2 border-b-[2.5px] border-border bg-muted/40 px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <h3 className="font-mono text-xs font-extrabold uppercase tracking-widest">Top Destinations &amp; Rule Matches</h3>
        <span className="ml-auto hidden font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground sm:inline">
          Destinations ranked by volume · rules by trigger count
        </span>
      </div>

      <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        {/* ── Left: Top Accessed Domains ─────────────────────────────── */}
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Top Accessed Domains
            </span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
              {topDomains.length > 0
                ? `${topDomains.length} domain${topDomains.length === 1 ? "" : "s"}`
                : "—"}
            </span>
          </div>
          {topDomains.length === 0 ? (
            <EmptyCell />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                  <th className="w-10 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest">#</th>
                  <th className="px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest">Domain</th>
                  <th className="w-28 px-4 py-2 text-right font-mono text-[11px] font-bold uppercase tracking-widest">Share</th>
                </tr>
              </thead>
              <Stagger as="tbody" className="divide-y divide-border">
                {topDomains.map((d, i) => (
                  <StaggerItem as="tr" key={d.domain} className="transition-colors hover:bg-muted/30">
                    <td className={cn("px-4 py-2.5 font-mono text-xs font-bold", i < 3 ? "text-foreground" : "text-muted-foreground")}>
                      {String(i + 1).padStart(2, "0")}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="block max-w-[220px] truncate font-mono text-[13px] font-semibold" title={d.domain}>
                          {d.domain}
                        </span>
                        <div className="h-1.5 min-w-[24px] flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.max(2, (d.count / maxDomain) * 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[13px] font-bold tabular-nums">
                      {d.pct.toFixed(0)}%
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        ({d.count.toLocaleString()})
                      </span>
                    </td>
                  </StaggerItem>
                ))}
              </Stagger>
            </table>
          )}
        </div>

        {/* ── Right: Triggered URL Patterns ──────────────────────────── */}
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Triggered URL Patterns
            </span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
              {triggeredPatterns.length > 0
                ? `${triggeredPatterns.length} pattern${triggeredPatterns.length === 1 ? "" : "s"}`
                : "—"}
            </span>
          </div>
          {triggeredPatterns.length === 0 ? (
            <EmptyCell />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                  <th className="px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest">Pattern</th>
                  <th className="w-24 px-4 py-2 text-right font-mono text-[11px] font-bold uppercase tracking-widest">Hits</th>
                </tr>
              </thead>
              <Stagger as="tbody" className="divide-y divide-border">
                {triggeredPatterns.map((p) => (
                  <StaggerItem as="tr" key={p.pattern} className="transition-colors hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="block max-w-[240px] truncate font-mono text-[13px] font-semibold" title={p.pattern}>
                          {p.pattern}
                        </span>
                        <div className="h-1.5 min-w-[24px] flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <div
                            className="h-full rounded-full bg-warning"
                            style={{ width: `${Math.max(2, (p.hits / maxHits) * 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[13px] font-bold tabular-nums">
                      {p.hits.toLocaleString()}
                    </td>
                  </StaggerItem>
                ))}
              </Stagger>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}