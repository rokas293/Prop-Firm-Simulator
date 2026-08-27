// Renders drawing-tool annotations (POLISH_ROADMAP Phase P2). Same
// pane-primitive pattern as TimeSpanPrimitive/SessionBandsPrimitive/
// MllBandPrimitive: reads fresh screen coordinates on every draw call, so
// drawings stay pixel-aligned through pan/zoom automatically instead of
// needing to be repositioned manually.
import type {
  IChartApiBase,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  ISeriesApi,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { Bar } from '../api/types'
import type { Drawing } from '../state/drawingStore'
import { computeMeasure, formatDuration } from './measure'

const DRAWING_COLOR = '#e3b341'
const MEASURE_COLOR = '#79c0ff'
const PREVIEW_ALPHA = 0.6

interface ScreenPoint {
  x: number
  y: number
}

export class DrawingLayerPrimitive implements IPanePrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private requestUpdate: (() => void) | null = null
  private _paneViews: DrawingPaneView[]

  constructor(
    private series: ISeriesApi<'Candlestick'>,
    private drawings: Drawing[],
    private preview: Drawing | null,
    private bars: Bar[],
  ) {
    this._paneViews = [new DrawingPaneView(this)]
  }

  attached(param: PaneAttachedParameter<Time>): void {
    this.chart = param.chart
    this.requestUpdate = param.requestUpdate
  }

  detached(): void {
    this.chart = null
    this.requestUpdate = null
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this._paneViews
  }

  update(drawings: Drawing[], preview: Drawing | null, bars: Bar[]): void {
    this.drawings = drawings
    this.preview = preview
    this.bars = bars
    this.requestUpdate?.()
  }

  getBars(): Bar[] {
    return this.bars
  }

  getRenderList(): { drawing: Drawing; isPreview: boolean }[] {
    const list = this.drawings.map((d) => ({ drawing: d, isPreview: false }))
    if (this.preview) list.push({ drawing: this.preview, isPreview: true })
    return list
  }

  toScreenPoint(time: number, price: number): ScreenPoint | null {
    if (!this.chart) return null
    const x = this.chart.timeScale().timeToCoordinate(time as Time)
    const y = this.series.priceToCoordinate(price)
    if (x === null || y === null) return null
    return { x, y }
  }
}

class DrawingPaneView implements IPanePrimitivePaneView {
  constructor(private source: DrawingLayerPrimitive) {}

  renderer(): IPrimitivePaneRenderer | null {
    return new DrawingRenderer(this.source)
  }
}

class DrawingRenderer implements IPrimitivePaneRenderer {
  constructor(private source: DrawingLayerPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const items = this.source.getRenderList()
    if (items.length === 0) return
    const bars = this.source.getBars()

    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const { drawing, isPreview } of items) {
        context.save()
        context.globalAlpha = isPreview ? PREVIEW_ALPHA : 1
        this.drawOne(context, mediaSize, drawing, bars)
        context.restore()
      }
    })
  }

  private drawOne(
    context: CanvasRenderingContext2D,
    mediaSize: { width: number; height: number },
    drawing: Drawing,
    bars: Bar[],
  ): void {
    const p1 = drawing.points[0]
    if (!p1) return
    const s1 = this.source.toScreenPoint(p1.time, p1.price)
    if (!s1) return

    context.strokeStyle = drawing.type === 'measure' ? MEASURE_COLOR : DRAWING_COLOR
    context.fillStyle = context.strokeStyle
    context.lineWidth = 1.5

    if (drawing.type === 'hline') {
      context.beginPath()
      context.moveTo(0, s1.y)
      context.lineTo(mediaSize.width, s1.y)
      context.stroke()
      return
    }

    const p2 = drawing.points[1]
    if (!p2) return
    const s2 = this.source.toScreenPoint(p2.time, p2.price)
    if (!s2) return

    if (drawing.type === 'trendline' || drawing.type === 'measure') {
      context.beginPath()
      context.moveTo(s1.x, s1.y)
      context.lineTo(s2.x, s2.y)
      context.stroke()
      if (drawing.type === 'measure') {
        this.drawMeasureLabel(context, s2, p1, p2, bars)
      }
      return
    }

    if (drawing.type === 'ray') {
      const end = extendToEdge(s1, s2, mediaSize.width)
      context.beginPath()
      context.moveTo(s1.x, s1.y)
      context.lineTo(end.x, end.y)
      context.stroke()
      return
    }

    if (drawing.type === 'rect') {
      const left = Math.min(s1.x, s2.x)
      const top = Math.min(s1.y, s2.y)
      const width = Math.abs(s2.x - s1.x)
      const height = Math.abs(s2.y - s1.y)
      const strokeAlpha = context.globalAlpha
      context.save()
      context.globalAlpha = strokeAlpha * 0.15
      context.fillRect(left, top, width, height)
      context.restore()
      context.strokeRect(left, top, width, height)
      return
    }
  }

  private drawMeasureLabel(
    context: CanvasRenderingContext2D,
    at: ScreenPoint,
    p1: { time: number; price: number },
    p2: { time: number; price: number },
    bars: Bar[],
  ): void {
    const m = computeMeasure(p1, p2, bars)
    const sign = m.points >= 0 ? '+' : ''
    const text = `${sign}${m.points.toFixed(2)} pts (${sign}${m.percent.toFixed(2)}%) · ${m.bars} bars · ${formatDuration(m.seconds)}`
    context.font = '11px sans-serif'
    const metrics = context.measureText(text)
    const padding = 4
    const boxX = at.x + 8
    const boxY = at.y - 20
    context.fillStyle = 'rgba(13, 17, 23, 0.9)'
    context.fillRect(boxX - padding, boxY - 11 - padding, metrics.width + padding * 2, 16 + padding)
    context.fillStyle = MEASURE_COLOR
    context.fillText(text, boxX, boxY)
  }
}

function extendToEdge(from: ScreenPoint, through: ScreenPoint, paneWidth: number): ScreenPoint {
  const dx = through.x - from.x
  if (Math.abs(dx) < 0.001) return through // vertical-ish: no meaningful horizontal extension
  const slope = (through.y - from.y) / dx
  const targetX = dx > 0 ? paneWidth : 0
  const targetY = from.y + slope * (targetX - from.x)
  return { x: targetX, y: targetY }
}
