import { useEffect, useMemo, useRef } from "react"
import * as echarts from "echarts/core"
import { BarChart, LineChart } from "echarts/charts"
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type {
  ECharts,
  EChartsOption,
  TooltipComponentFormatterCallbackParams,
} from "echarts"
import { useTheme } from "./Sidebar"
import { cn } from "../lib/utils"
import {
  FALLBACK_DARK,
  FALLBACK_LIGHT,
  resolveAllColors,
  resolveColor,
} from "../lib/echartsTheme"

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

/** One x-axis bucket with one value per series (e.g. inbound/outbound or allow/deny). */
export interface TrendPoint {
  bucket: string
  [series: string]: string | number
}

const DEFAULT_LABELS: Record<TrendChartsProps["type"], string[]> = {
  area: ["inbound", "outbound"],
  stackedBar: ["allow", "deny"],
}

interface TrendChartsProps {
  /** "area" → two smooth lines with gradient fill (Daily Bandwidth);
   *  "stackedBar" → two stacked bars (Daily Enforcements). */
  type: "area" | "stackedBar"
  data: TrendPoint[]
  /** Series keys to render, in order. Defaults by type: area → inbound/outbound,
   *  stackedBar → allow/deny. */
  labels?: string[]
  /** Optional display names per series (fall back to the key, uppercased). */
  seriesNames?: string[]
  /** CSS color tokens (var(--color-*)) or hex strings, one per series. */
  colorTokens?: string[]
  height?: number
  className?: string
  ariaLabel?: string
  /** Suffix appended to tooltip values, e.g. "GB" or "reqs". */
  unit?: string
}

/** Append an alpha channel to a hex or rgb() color (ECharts gradient stops). */
function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(",").map((s) => s.trim())
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
  }
  if (color.startsWith("#")) {
    const hex =
      color.length === 4
        ? color
            .slice(1)
            .split("")
            .map((c) => c + c)
            .join("")
        : color.slice(1)
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

function buildOption(
  type: "area" | "stackedBar",
  data: TrendPoint[],
  labels: string[],
  seriesNames: string[] | undefined,
  colorTokens: string[] | undefined,
  colors: Record<string, string>,
  unit: string,
): EChartsOption {
  const foreground = colors["--color-foreground"]
  const muted = colors["--color-muted-foreground"]
  const card = colors["--color-card"]
  const border = colors["--color-border"]

  if (data.length === 0) {
    return {
      animation: false,
      backgroundColor: card,
      title: {
        text: "NO DATA IN WINDOW",
        left: "center",
        top: "center",
        textStyle: { color: muted, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace" },
      },
    }
  }

  const defaultTokens =
    type === "area"
      ? ["var(--color-info)", "var(--color-success)"]
      : ["var(--color-success)", "var(--color-danger)"]
  const tokens = colorTokens ?? defaultTokens
  const resolvedSeries = labels.map((label, i) => ({
    label,
    color: resolveColor(tokens[i % tokens.length] ?? defaultTokens[0], colors),
    name: seriesNames?.[i] ?? label.toUpperCase(),
  }))

  const xData = data.map((d) => d.bucket)
  const maxValue = Math.max(1, ...data.flatMap((d) => labels.map((l) => Number(d[l]) || 0)))

  const series = resolvedSeries.map((s) =>
    type === "area"
      ? {
          name: s.name,
          type: "line",
          data: data.map((d) => Number(d[s.label]) || 0),
          smooth: true,
          symbol: "none",
          lineStyle: { color: s.color, width: 2 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: withAlpha(s.color, 0.3) },
                { offset: 1, color: withAlpha(s.color, 0.02) },
              ],
            },
          },
          emphasis: { focus: "series" },
        }
      : {
          name: s.name,
          type: "bar",
          stack: "total",
          barWidth: "55%",
          itemStyle: { color: s.color },
          data: data.map((d) => Number(d[s.label]) || 0),
          emphasis: { focus: "series" },
        },
  )

  return {
    // No enter animation: first paint must not depend on requestAnimationFrame
    // ticks (stalled rAF in embedded webviews leaves the chart blank forever).
    animation: false,
    backgroundColor: card,
    grid: { left: 56, right: 16, top: 40, bottom: 40 },
    legend: {
      top: 4,
      right: 8,
      textStyle: { color: muted, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace" },
      icon: type === "area" ? "roundRect" : "rect",
      itemWidth: 12,
      itemHeight: type === "area" ? 3 : 10,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: card,
      borderColor: border,
      borderWidth: 1,
      textStyle: { color: foreground, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace" },
      axisPointer: {
        type: type === "area" ? "line" : "shadow",
        lineStyle: { color: muted, type: "dashed" },
      },
      formatter: (params: TooltipComponentFormatterCallbackParams) => {
        const list = Array.isArray(params) ? params : [params]
        const name = String(list[0]?.name ?? "")
        const rows = list
          .map((p) => {
            const markerColor = p.color ?? muted
            const marker = `<span style="display:inline-block;width:8px;height:8px;border-radius:${type === "area" ? "50%" : "2px"};background:${markerColor};margin-right:6px"></span>`
            const value = typeof p.value === "number" ? p.value : Number(p.value)
            return `<div style="margin-top:3px;color:${muted}">${marker}${p.seriesName}: <b style="color:${foreground}">${value.toLocaleString()}${unit ? ` ${unit}` : ""}</b></div>`
          })
          .join("")
        return `<div style="font-family:ui-monospace,SFMono-Regular,monospace"><div style="color:${muted};font-size:10px">${name}</div>${rows}</div>`
      },
    },
    xAxis: {
      type: "category",
      data: xData,
      boundaryGap: type === "stackedBar",
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        interval: Math.max(1, Math.floor(xData.length / 10)),
        rotate: 15,
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        formatter: (v: number) =>
          v >= 1_000_000_000
            ? `${(v / 1_000_000_000).toFixed(1)}B`
            : v >= 1_000_000
              ? `${(v / 1_000_000).toFixed(1)}M`
              : v >= 1000
                ? `${(v / 1000).toFixed(1)}k`
                : String(v),
      },
      splitLine: { lineStyle: { color: border, type: "dashed" } },
      min: 0,
      max: Math.ceil((maxValue * 1.15) / 100) * 100,
    },
    series: series as EChartsOption["series"],
  }
}

/**
 * TrendCharts — theme-aware ECharts wrapper for the Analytics page.
 *
 * Used for both Daily Bandwidth Consumption (``type="area"``, Inbound vs
 * Outbound) and Daily Policy Enforcements (``type="stackedBar"``, Allow vs
 * Deny). Colors resolve through ``lib/echartsTheme.ts`` ``resolveAllColors``
 * so a CSS-token parsing fix can never drift between the two charts (Task 7).
 */
export function TrendCharts({
  type,
  data,
  labels,
  seriesNames,
  colorTokens,
  height = 260,
  className,
  ariaLabel = "Trend chart",
  unit = "",
}: TrendChartsProps) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const { theme } = useTheme()

  // resolveAllColors forces a style recalc, so it only re-runs on theme change.
  const colors = useMemo(
    () => resolveAllColors(theme === "light" ? FALLBACK_LIGHT : FALLBACK_DARK),
    [theme],
  )
  const effectiveLabels = useMemo(() => labels ?? DEFAULT_LABELS[type], [labels, type])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chartRef.current = chart

    const onResize = () => chart.resize()
    window.addEventListener("resize", onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(el)

    return () => {
      window.removeEventListener("resize", onResize)
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(
      buildOption(type, data, effectiveLabels, seriesNames, colorTokens, colors, unit),
      true,
    )
    chart.getZr().flush()
  }, [type, data, effectiveLabels, seriesNames, colorTokens, colors, unit])

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={cn("w-full", className)}
      style={{ height }}
    />
  )
}
