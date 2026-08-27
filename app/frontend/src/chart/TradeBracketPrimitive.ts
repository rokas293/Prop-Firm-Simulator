// Renders every trade as an on-chart entry->exit "bracket" (POLISH_ROADMAP
// Phase P3): a PnL zone shaded by outcome, lightly-shaded SL/TP corridors,
// and an R/$PnL label -- collapsing to a small marker when zoomed out (see
// chart/tradeBracket.ts's shouldSimplify, the "density control"). Same
// pane-primitive pattern as the other overlays in this directory: reads
// fresh screen coordinates on every draw so brackets stay pixel-aligned
// through pan/zoom automatically.
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
import type { ReplayTradeView } from './replay'
import { hexToRgba } from './color'
import {
  computeBracketBounds,
  shouldShowLabel,
  shouldSimplify,
  type BracketBounds,
  type BracketDensity,
} from './tradeBracket'

// Derived from the theme's up/down/accent colors (POLISH_ROADMAP Phase P6)
// -- setTradeColors() recomputes these whenever the theme changes, not just
// at construction, so an already-open chart re-themes live.
interface BracketColors {
  winFill: string
  winStroke: string
  lossFill: string
  lossStroke: string
  openStroke: string
  slFill: string
  tpFill: string
}

function deriveColors(up: string, down: string, accent: string): BracketColors {
  return {
    winFill: hexToRgba(up, 0.18),
    winStroke: hexToRgba(up, 0.9),
    lossFill: hexToRgba(down, 0.18),
    lossStroke: hexToRgba(down, 0.9),
    openStroke: hexToRgba(accent, 0.7),
    slFill: hexToRgba(down, 0.08),
    tpFill: hexToRgba(up, 0.08),
  }
}

// This app's original palette (Phase P1 onward / the "Ocean" theme preset),
// so a primitive never has an undefined color before the first theme effect
// runs.
const DEFAULT_COLORS = deriveColors('#3fb950', '#f85149', '#58a6ff')
const SELECTED_STROKE_WIDTH = 2.5
const STROKE_WIDTH = 1

interface RenderItem {
  bounds: BracketBounds
  x1: number
  x2: number
  yEntry: number
  yExit: number | null
  ySl: number | null
  yTp: number | null
  isSelected: boolean
}

export class TradeBracketPrimitive implements IPanePrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null
  private requestUpdate: (() => void) | null = null
  private _paneViews: BracketPaneView[]
  private colors: BracketColors = DEFAULT_COLORS

  constructor(
    private series: ISeriesApi<'Candlestick'>,
    private views: ReplayTradeView[],
    private selectedTradeId: number | null,
    private density: BracketDensity,
  ) {
    this._paneViews = [new BracketPaneView(this)]
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

  update(views: ReplayTradeView[], selectedTradeId: number | null, density: BracketDensity): void {
    this.views = views
    this.selectedTradeId = selectedTradeId
    this.density = density
    this.requestUpdate?.()
  }

  getDensity(): BracketDensity {
    return this.density
  }

  getColors(): BracketColors {
    return this.colors
  }

  // Live theme up/down/accent colors (POLISH_ROADMAP Phase P6) -- recomputes
  // the derived fill/stroke set and repaints, so an already-open chart
  // re-themes without needing to remount.
  setTradeColors(up: string, down: string, accent: string): void {
    this.colors = deriveColors(up, down, accent)
    this.requestUpdate?.()
  }

  getRenderItems(): RenderItem[] {
    if (!this.chart) return []
    const ts = this.chart.timeScale()
    const out: RenderItem[] = []
    for (const view of this.views) {
      const bounds = computeBracketBounds(view)
      const x1 = ts.timeToCoordinate(bounds.timeFrom as Time)
      const x2 = ts.timeToCoordinate(bounds.timeTo as Time)
      const yEntry = this.series.priceToCoordinate(view.trade.entry_price)
      if (x1 === null || x2 === null || yEntry === null) continue
      out.push({
        bounds,
        x1,
        x2,
        yEntry,
        yExit: bounds.outcome !== 'open' ? this.series.priceToCoordinate(view.trade.exit_price) : null,
        ySl: view.trade.sl_price !== null ? this.series.priceToCoordinate(view.trade.sl_price) : null,
        yTp: view.trade.tp_price !== null ? this.series.priceToCoordinate(view.trade.tp_price) : null,
        isSelected: this.selectedTradeId === view.trade.trade_id,
      })
    }
    return out
  }
}

class BracketPaneView implements IPanePrimitivePaneView {
  constructor(private source: TradeBracketPrimitive) {}

  renderer(): IPrimitivePaneRenderer | null {
    return new BracketRenderer(this.source)
  }
}

class BracketRenderer implements IPrimitivePaneRenderer {
  constructor(private source: TradeBracketPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const items = this.source.getRenderItems()
    if (items.length === 0) return
    const density = this.source.getDensity()

    target.useMediaCoordinateSpace(({ context }) => {
      for (const item of items) {
        const width = Math.abs(item.x2 - item.x1)
        if (shouldSimplify(width, density)) {
          this.drawMarker(context, item)
        } else {
          this.drawFull(context, item, width)
        }
      }
    })
  }

  private colorsFor(item: RenderItem): { fill: string; stroke: string } {
    const c = this.source.getColors()
    if (item.bounds.outcome === 'win') return { fill: c.winFill, stroke: c.winStroke }
    if (item.bounds.outcome === 'loss') return { fill: c.lossFill, stroke: c.lossStroke }
    return { fill: 'transparent', stroke: c.openStroke }
  }

  private drawMarker(context: CanvasRenderingContext2D, item: RenderItem): void {
    const { stroke } = this.colorsFor(item)
    const x = (item.x1 + item.x2) / 2
    const r = item.isSelected ? 4 : 2.5
    context.fillStyle = stroke
    context.beginPath()
    context.arc(x, item.yEntry, r, 0, Math.PI * 2)
    context.fill()
  }

  private drawFull(context: CanvasRenderingContext2D, item: RenderItem, width: number): void {
    const left = Math.min(item.x1, item.x2)
    const c = this.source.getColors()

    // SL/TP corridors -- known at entry, so drawn even while a trade is
    // still "open" in replay (no look-ahead violation: these are pre-set
    // risk parameters fixed before the trade opened, not future price info).
    if (item.ySl !== null) {
      context.fillStyle = c.slFill
      const top = Math.min(item.yEntry, item.ySl)
      context.fillRect(left, top, width, Math.abs(item.ySl - item.yEntry))
    }
    if (item.yTp !== null) {
      context.fillStyle = c.tpFill
      const top = Math.min(item.yEntry, item.yTp)
      context.fillRect(left, top, width, Math.abs(item.yTp - item.yEntry))
    }

    if (item.bounds.outcome === 'open' || item.yExit === null) return

    const { fill, stroke } = this.colorsFor(item)
    const top = Math.min(item.yEntry, item.yExit)
    const height = Math.max(1, Math.abs(item.yExit - item.yEntry))
    context.fillStyle = fill
    context.fillRect(left, top, width, height)
    context.strokeStyle = stroke
    context.lineWidth = item.isSelected ? SELECTED_STROKE_WIDTH : STROKE_WIDTH
    context.strokeRect(left, top, width, height)

    if (shouldShowLabel(width)) {
      const t = item.bounds.trade
      const sign = t.pnl_usd >= 0 ? '+' : '-'
      const rText = t.r_multiple !== null ? `${t.r_multiple >= 0 ? '+' : ''}${t.r_multiple.toFixed(2)}R  ` : ''
      const text = `${rText}${sign}$${Math.abs(t.pnl_usd).toFixed(2)}`
      context.font = item.isSelected ? 'bold 11px sans-serif' : '11px sans-serif'
      context.fillStyle = stroke
      context.textBaseline = 'bottom'
      context.fillText(text, left + 3, top - 3)
    }
  }
}
