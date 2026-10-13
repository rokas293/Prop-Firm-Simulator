// FXR_V2_SPEC.md section 7 (G9): Heikin Ashi as a chart type, DISPLAY ONLY.
//
// The chart's data list never holds Heikin Ashi values: it stays the real
// candles, so everything that reads it (the last price tag, the crosshair and
// legend, order lines, fills, the forming candle's glide) keeps real prices.
// The smoothed candles are drawn by a candle-pane indicator over the (then
// transparent) real ones. Its calc reads only the data list, and point i
// depends only on points <= i, so the forming candle uses revealed data alone.
import { registerIndicator } from 'klinecharts'
import { useThemeStore } from '../../state/themeStore'

export const KL_HEIKIN_ASHI = 'klHeikinAshi'

export interface OhlcLike {
  open: number
  high: number
  low: number
  close: number
}

export interface HaPoint {
  haOpen: number
  haHigh: number
  haLow: number
  haClose: number
}

// ha_close = (o+h+l+c)/4; ha_open = (prev ha_open + prev ha_close)/2, seeded with
// (o+c)/2 on the first candle; ha_high/low take the extremes of the real
// high/low and the two HA values.
export function heikinAshiSeries(bars: readonly OhlcLike[]): HaPoint[] {
  const out: HaPoint[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const haClose = (b.open + b.high + b.low + b.close) / 4
    const haOpen = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].haOpen + out[i - 1].haClose) / 2
    out.push({
      haOpen,
      haClose,
      haHigh: Math.max(b.high, haOpen, haClose),
      haLow: Math.min(b.low, haOpen, haClose),
    })
  }
  return out
}

export interface HeikinAshiColors {
  up: string
  down: string
}

const initial = useThemeStore.getState().colors
let colors: HeikinAshiColors = { up: initial.upCandle, down: initial.downCandle }
export function setHeikinAshiColors(next: HeikinAshiColors): void {
  colors = next
}

let registered = false
export function ensureHeikinAshiRegistered(): void {
  if (registered) return
  registered = true
  registerIndicator<HaPoint>({
    name: KL_HEIKIN_ASHI,
    shortName: 'HA',
    series: 'price',
    calcParams: [],
    figures: [],
    // No legend row of its own: the pane's O/H/L/C legend stays the real candle's.
    createTooltipDataSource: () => ({ name: '', calcParamsText: '', features: [], legends: [] }),
    calc: (dataList) => heikinAshiSeries(dataList),
    draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
      const result = indicator.result as HaPoint[]
      const list = chart.getDataList()
      const { from, to } = chart.getVisibleRange()
      const { bar } = chart.getBarSpace()
      const bodyWidth = Math.max(1, Math.floor(bar * 0.8))
      ctx.save()
      ctx.lineWidth = 1
      for (let i = Math.max(0, from); i < Math.min(to, list.length, result.length); i++) {
        const p = result[i]
        if (!p) continue
        const x = Math.round(xAxis.convertTimestampToPixel(list[i].timestamp)) + 0.5
        const up = p.haClose >= p.haOpen
        const color = up ? colors.up : colors.down
        const yOpen = yAxis.convertToPixel(p.haOpen)
        const yClose = yAxis.convertToPixel(p.haClose)
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(x, Math.round(yAxis.convertToPixel(p.haHigh)))
        ctx.lineTo(x, Math.round(yAxis.convertToPixel(p.haLow)))
        ctx.stroke()
        const top = Math.round(Math.min(yOpen, yClose))
        const height = Math.max(1, Math.round(Math.abs(yClose - yOpen)))
        ctx.fillRect(Math.round(x - bodyWidth / 2), top, bodyWidth, height)
      }
      ctx.restore()
      return true
    },
  })
}
