// Shades the time span a position was open (VIZ_SPEC section 8: "use a
// lightweight custom series/primitive... don't fake it with candles").
// A pane primitive, not a series -- it just paints a translucent vertical
// band between two x-coordinates derived from the chart's own time scale,
// so it always aligns with real bar time even as the user pans/zooms.
import type {
  IChartApiBase,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  PaneAttachedParameter,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'

export class TimeSpanPrimitive implements IPanePrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private requestUpdate: (() => void) | null = null
  private _paneViews: TimeSpanPaneView[]

  constructor(
    private startTime: number | null,
    private endTime: number | null,
    private color: string = 'rgba(88, 166, 255, 0.08)',
  ) {
    this._paneViews = [new TimeSpanPaneView(this)]
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

  setRange(startTime: number | null, endTime: number | null): void {
    this.startTime = startTime
    this.endTime = endTime
    this.requestUpdate?.()
  }

  // Live theme accent color (POLISH_ROADMAP Phase P6) -- called whenever
  // the theme changes, not just at construction time.
  setColor(color: string): void {
    this.color = color
    this.requestUpdate?.()
  }

  getFillColor(): string {
    return this.color
  }

  getCoordinates(): { x1: number | null; x2: number | null } {
    if (!this.chart || this.startTime === null || this.endTime === null) {
      return { x1: null, x2: null }
    }
    const ts = this.chart.timeScale()
    return {
      x1: ts.timeToCoordinate(this.startTime as Time),
      x2: ts.timeToCoordinate(this.endTime as Time),
    }
  }
}

class TimeSpanPaneView implements IPanePrimitivePaneView {
  constructor(private source: TimeSpanPrimitive) {}

  renderer(): IPrimitivePaneRenderer | null {
    return new TimeSpanRenderer(this.source)
  }
}

class TimeSpanRenderer implements IPrimitivePaneRenderer {
  constructor(private source: TimeSpanPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const { x1, x2 } = this.source.getCoordinates()
    if (x1 === null || x2 === null) return
    const color = this.source.getFillColor()

    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const left = Math.min(x1, x2)
      const width = Math.max(1, Math.abs(x2 - x1))
      context.fillStyle = color
      context.fillRect(left, 0, width, mediaSize.height)
    })
  }
}
