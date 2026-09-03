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
import { FALLBACK_DARK, FALLBACK_LIGHT, resolveAllColors } from "../lib/echartsTheme"

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