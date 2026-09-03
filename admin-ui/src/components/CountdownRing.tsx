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
      className={`relative grid h-28 w-28 shrink-0 place-items-center border-[2.5px] border-[#0A0A0A] bg-card brutal-shadow-sm dark:border-[#F6F2E8] ${className}`}
      role="timer"
      aria-label={`Approximately ${formatted} until the next Elasticsearch poll`}
    >
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 112 112" aria-hidden="true">
        <circle
          cx="56"
          cy="56"
          r={radius}
          fill="none"
          className="stroke-[#ECE8DD] dark:stroke-[#1E1E1E]"
          strokeWidth="7"
          strokeLinecap="butt"
        />
        <circle
          cx="56"
          cy="56"
          r={radius}
          fill="none"
          className="stroke-[#0A0A0A] transition-[stroke-dashoffset] duration-1000 ease-linear dark:stroke-[#FFD60A]"
          strokeWidth="7"
          strokeLinecap="butt"
          strokeDasharray={circumference}
          strokeDashoffset={strokeOffset}
        />
      </svg>
      <div className="relative text-center">
        <span className="block font-mono text-xl font-black tabular-nums tracking-tight text-foreground">{formatted}</span>
        <span className="mono-label mt-1 block">
          APPROX.
        </span>
      </div>
    </div>
  )
}
