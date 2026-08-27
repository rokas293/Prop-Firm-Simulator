// Shades the gap between equity and the trailing MLL floor -- "distance to
// breach." The band's own width IS the signal (thinner = closer to
// failing), so no extra color-intensity encoding is needed. Built the same
// way as TimeSpanPrimitive: a pane primitive that reads screen coordinates
// fresh on every draw so it stays aligned through pan/zoom.
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

export interface BandPoint {
  time: number
  equity: number
  floor: number
}

export class MllBandPrimitive implements IPanePrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private requestUpdate: (() => void) | null = null
  private _paneViews: MllBandPaneView[]

  constructor(
    private series: ISeriesApi<'Line'>,
    private points: BandPoint[],
    private color: string = 'rgba(248, 81, 73, 0.15)',
  ) {
    this._paneViews = [new MllBandPaneView(this)]
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

  setPoints(points: BandPoint[]): void {
    this.points = points
    this.requestUpdate?.()
  }

  // Live theme "down" color (POLISH_ROADMAP Phase P6) -- called whenever
  // the theme changes, not just at construction time.
  setColor(color: string): void {
    this.color = color
    this.requestUpdate?.()
  }

  getFillColor(): string {
    return this.color
  }

  getScreenPoints(): { x: number; yEquity: number; yFloor: number }[] {
    if (!this.chart) return []
    const ts = this.chart.timeScale()
    const out: { x: number; yEquity: number; yFloor: number }[] = []
    for (const p of this.points) {
      const x = ts.timeToCoordinate(p.time as Time)
      const yEquity = this.series.priceToCoordinate(p.equity)
      const yFloor = this.series.priceToCoordinate(p.floor)
      if (x === null || yEquity === null || yFloor === null) continue
      out.push({ x, yEquity, yFloor })
    }
    return out
  }
}

class MllBandPaneView implements IPanePrimitivePaneView {
  constructor(private source: MllBandPrimitive) {}

  renderer(): IPrimitivePaneRenderer | null {
    return new MllBandRenderer(this.source)
  }
}

class MllBandRenderer implements IPrimitivePaneRenderer {
  constructor(private source: MllBandPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const points = this.source.getScreenPoints()
    if (points.length < 2) return
    const color = this.source.getFillColor()

    target.useMediaCoordinateSpace(({ context }) => {
      context.beginPath()
      context.moveTo(points[0].x, points[0].yEquity)
      for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].yEquity)
      for (let i = points.length - 1; i >= 0; i--) context.lineTo(points[i].x, points[i].yFloor)
      context.closePath()
      context.fillStyle = color
      context.fill()
    })
  }
}
