interface CountdownRingProps {
  remaining: number
  total: number
  className?: string
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return `${minutes}:${remainder.toString().padStart(2, "0")}`
}

export function CountdownRing({ remaining, total, className = "" }: CountdownRingProps) {
  const safeTotal = Math.max(1, total)
  const safeRemaining = Math.min(safeTotal, Math.max(0, remaining))
  const radius = 44
  const circumference = 2 * Math.PI * radius
  const progress = safeRemaining / safeTotal
  const strokeOffset = circumference * (1 - progress)
  const formatted = formatDuration(safeRemaining)

  return (
    <div
      className={`relative grid h-28 w-28 shrink-0 place-items-center rounded-md border border-border bg-card shadow-sm ${className}`}
      role="timer"
      aria-label={`Approximately ${formatted} until the next Elasticsearch poll`}
    >
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 112 112" aria-hidden="true">
        <circle
          cx="56"
          cy="56"
          r={radius}
          fill="none"
          className="stroke-muted"
          strokeWidth="7"
          strokeLinecap="butt"
        />
        <circle
          cx="56"
          cy="56"
          r={radius}
          fill="none"
          className="stroke-current text-foreground transition-[stroke-dashoffset] duration-1000 ease-linear"
          strokeWidth="7"
          strokeLinecap="butt"
          strokeDasharray={circumference}
          strokeDashoffset={strokeOffset}
        />
      </svg>
      <div className="relative text-center">
        <span className="block font-mono text-xl font-semibold tabular-nums tracking-tight text-foreground">{formatted}</span>
        <span className="mono-label mt-1 block">
          Approx
        </span>
      </div>
    </div>
  )
}
