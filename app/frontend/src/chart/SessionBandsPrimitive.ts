// Background shading for Asia/London/NY (+ any other configured session)
// plus a fair-value horizontal segment (not a full-width price line -- a
// fair value is only meaningful for the span of its own session) drawn per
// window. Same pane-primitive pattern as TimeSpanPrimitive/MllBandPrimitive.
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

export interface SessionBand {
  start: number
  end: number
  session: string
  fairValue: number | null
}

const SESSION_COLORS: Record<string, string> = {
  asia: 'rgba(163, 113, 247, 0.07)',
  london: 'rgba(88, 166, 255, 0.07)',
  ny: 'rgba(63, 185, 80, 0.07)',
  news: 'rgba(210, 153, 34, 0.09)',
}
const DEFAULT_SESSION_COLOR = 'rgba(139, 148, 158, 0.06)'
const FAIR_VALUE_COLOR = 'rgba(201, 209, 217, 0.6)'

export class SessionBandsPrimitive implements IPanePrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private requestUpdate: (() => void) | null = null
  private _paneViews: SessionBandsPaneView[]

  constructor(
    private series: ISeriesApi<'Candlestick'>,
    private bands: SessionBand[],
    private showShading: boolean,
    private showFairValue: boolean,
  ) {
    this._paneViews = [new SessionBandsPaneView(this)]
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

  update(bands: SessionBand[], showShading: boolean, showFairValue: boolean): void {
    this.bands = bands
    this.showShading = showShading
    this.showFairValue = showFairValue
    this.requestUpdate?.()
  }

  getFlags(): { showShading: boolean; showFairValue: boolean } {
    return { showShading: this.showShading, showFairValue: this.showFairValue }
  }

  getRenderData(): { x1: number; x2: number; yFairValue: number | null; color: string }[] {
    if (!this.chart) return []
    const ts = this.chart.timeScale()
    const out: { x1: number; x2: number; yFairValue: number | null; color: string }[] = []
    for (const b of this.bands) {
      const x1 = ts.timeToCoordinate(b.start as Time)
      const x2 = ts.timeToCoordinate(b.end as Time)
      if (x1 === null || x2 === null) continue
      out.push({
        x1,
        x2,
        yFairValue: b.fairValue !== null ? this.series.priceToCoordinate(b.fairValue) : null,
        color: SESSION_COLORS[b.session] ?? DEFAULT_SESSION_COLOR,
      })
    }
    return out
  }
}

class SessionBandsPaneView implements IPanePrimitivePaneView {
  constructor(private source: SessionBandsPrimitive) {}

  renderer(): IPrimitivePaneRenderer | null {
    return new SessionBandsRenderer(this.source)
  }
}

class SessionBandsRenderer implements IPrimitivePaneRenderer {
  constructor(private source: SessionBandsPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const data = this.source.getRenderData()
    if (data.length === 0) return
    const { showShading, showFairValue } = this.source.getFlags()
    if (!showShading && !showFairValue) return

    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const d of data) {
        const left = Math.min(d.x1, d.x2)
        const width = Math.max(1, Math.abs(d.x2 - d.x1))

        if (showShading) {
          context.fillStyle = d.color
          context.fillRect(left, 0, width, mediaSize.height)
        }

        if (showFairValue && d.yFairValue !== null) {
          context.strokeStyle = FAIR_VALUE_COLOR
          context.lineWidth = 1
          context.setLineDash([4, 3])
          context.beginPath()
          context.moveTo(left, d.yFairValue)
          context.lineTo(left + width, d.yFairValue)
          context.stroke()
          context.setLineDash([])
        }
      }
    })
  }
}
