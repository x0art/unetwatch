import { useEffect, useMemo, useRef } from "react"
import * as echarts from "echarts/core"
import { LineChart } from "echarts/charts"
import {
  GridComponent,
  TooltipComponent,
  TitleComponent,
  LegendComponent,
} from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import type {
  ECharts,
  EChartsOption,
  TooltipComponentFormatterCallbackParams,
} from "echarts"
import { useTheme } from "./Sidebar"
import { cn } from "../lib/utils"

echarts.use([LineChart, GridComponent, TooltipComponent, TitleComponent, LegendComponent, CanvasRenderer])

export interface TimelinePoint {
  hour: string
  volume: number
}

interface TrafficTimelineProps {
  points: TimelinePoint[]
  anomalyAnnotation?: string
  className?: string
  height?: number
}

function resolveColor(raw: string, fallback: Record<string, string>): string {
  const m = raw.match(/var\((--[\w-]+)\)/)
  if (!m) return raw
  const token = m[1]
  const live = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  if (!live) return fallback[token] ?? "#888"
  if (live.startsWith("oklch")) {
    const parsed = parseOklch(live)
    if (parsed) return oklchToSrgb(parsed[0], parsed[1], parsed[2])
    return fallback[token] ?? "#888"
  }
  return live
}

function parseOklch(input: string): [number, number, number] | null {
  const m = input.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?/)
  if (!m) return null
  const num = (s: string) => (s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s))
  return [num(m[1]), num(m[2]), Number(m[3])]
}

function oklchToSrgb(L: number, C: number, Hdeg: number): string {
  const H = (Hdeg * Math.PI) / 180
  const a = C * Math.cos(H)
  const b = C * Math.sin(H)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const r_lin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g_lin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b_lin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const lin = (c: number) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c)
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(lin(v) * 255)))
  return `rgb(${clamp(r_lin)}, ${clamp(g_lin)}, ${clamp(b_lin)})`
}

const FALLBACK_DARK: Record<string, string> = {
  "--color-info": "#5b8def",
  "--color-warning": "#e8a33d",
  "--color-danger": "#ef6a6a",
  "--color-success": "#4fbf7a",
  "--color-primary": "#5b8def",
  "--color-foreground": "#e8e8ee",
  "--color-muted-foreground": "#a0a0ac",
  "--color-card": "#232331",
  "--color-border": "#3f3f4d",
}

const FALLBACK_LIGHT: Record<string, string> = {
  "--color-info": "#006398",
  "--color-warning": "#8A5700",
  "--color-danger": "#C10000",
  "--color-success": "#006C15",
  "--color-primary": "#006398",
  "--color-foreground": "#070B14",
  "--color-muted-foreground": "#454E5B",
  "--color-card": "#FFFFFF",
  "--color-border": "#D0D4DB",
}

function resolveAllColors(fallback: Record<string, string>): Record<string, string> {
  const tokens = [
    "--color-info",
    "--color-warning",
    "--color-danger",
    "--color-success",
    "--color-primary",
    "--color-foreground",
    "--color-muted-foreground",
    "--color-card",
    "--color-border",
  ]
  const resolved: Record<string, string> = {}
  for (const token of tokens) {
    resolved[token] = resolveColor(`var(${token})`, fallback)
  }
  return resolved
}

export function TrafficTimeline({ points, anomalyAnnotation, className, height = 240 }: TrafficTimelineProps) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const { theme } = useTheme()

  // resolveAllColors forces a style recalc, so it only re-runs on theme change.
  // `fallback` derives from `theme`, so the theme dep alone is sufficient.
  const colors = useMemo(() => resolveAllColors(theme === "light" ? FALLBACK_LIGHT : FALLBACK_DARK), [theme])
  const data = useMemo(() => points, [points])

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

    const option = buildOption(data, colors, anomalyAnnotation)
    chart.setOption(option, true)
    chart.getZr().flush()
  }, [data, colors, anomalyAnnotation])

  return (
    <div
      ref={ref}
      role="img"
      aria-label="Traffic timeline"
      className={cn("w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm", className)}
      style={{ height }}
    />
  )
}

/** Append an alpha channel to a hex or rgb() color (ECharts gradient stops). */
function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(",").map((s) => s.trim())
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
  }
  if (color.startsWith("#")) {
    const hex = color.length === 4 ? color.slice(1).split("").map((c) => c + c).join("") : color.slice(1)
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

function buildOption(
  points: TimelinePoint[],
  colors: Record<string, string>,
  anomalyAnnotation?: string,
): EChartsOption {
  const primary = colors["--color-primary"]
  const foreground = colors["--color-foreground"]
  const muted = colors["--color-muted-foreground"]
  const card = colors["--color-card"]
  const border = colors["--color-border"]

  if (points.length === 0) {
    return {
      animation: false,
      backgroundColor: card,
      title: {
        text: "No traffic data",
        left: "center",
        top: "center",
        textStyle: { color: muted, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace" },
      },
    }
  }

  const xData = points.map((p) => p.hour)
  const yData = points.map((p) => p.volume)
  const maxVolume = Math.max(1, ...yData)

  // Find the spike point for annotation
  let spikeIndex = -1
  if (anomalyAnnotation) {
    spikeIndex = yData.indexOf(Math.max(...yData))
  }

  return {
    animation: false,
    backgroundColor: card,
    grid: {
      left: 48,
      right: 16,
      top: 28,
      bottom: 40,
    },
    xAxis: {
      type: "category",
      data: xData,
      boundaryGap: false,
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: {
        color: muted,
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        interval: Math.max(1, Math.floor(xData.length / 12)),
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
        formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)),
      },
      splitLine: { lineStyle: { color: border, type: "dashed" } },
      min: 0,
      max: Math.ceil(maxVolume * 1.2 / 100) * 100,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: card,
      borderColor: border,
      borderWidth: 1,
      textStyle: { color: foreground, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace" },
      axisPointer: {
        type: "line",
        lineStyle: { color: muted, type: "dashed" },
        label: { show: false },
      },
      formatter: (params: TooltipComponentFormatterCallbackParams) => {
        const p = Array.isArray(params) ? params[0] : params
        const name = String(p.name ?? "")
        const value = typeof p.value === "number" ? p.value : Number(p.value)
        return `
          <div style="font-family:ui-monospace,SFMono-Regular,monospace">
            <div style="color:${muted};font-size:10px">${name}</div>
            <div style="margin-top:4px;color:${foreground}">${value.toLocaleString()} requests</div>
          </div>
        `
      },
    },
    series: [
      {
        name: "Volume",
        type: "line",
        data: yData,
        smooth: true,
        symbol: "none",
        lineStyle: { color: primary, width: 2 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(primary, 0.35) },
              { offset: 1, color: withAlpha(primary, 0.03) },
            ],
          },
        },
        emphasis: { focus: "series" },
        markPoint: anomalyAnnotation && spikeIndex >= 0
          ? {
              silent: true,
              data: [
                {
                  name: anomalyAnnotation,
                  coord: [xData[spikeIndex], yData[spikeIndex]],
                  value: yData[spikeIndex],
                  label: {
                    color: colors["--color-danger"],
                    fontSize: 10,
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    fontWeight: "bold",
                    formatter: anomalyAnnotation,
                    position: "top",
                    distance: 8,
                    backgroundColor: card,
                    borderColor: colors["--color-danger"],
                    borderWidth: 1,
                    borderRadius: 4,
                    padding: [4, 6],
                  },
                  itemStyle: { color: colors["--color-danger"], borderColor: colors["--color-danger"], borderWidth: 1.5 },
                  symbol: "circle",
                  symbolSize: 8,
                },
              ],
            }
          : undefined,
      },
    ],
  }
}