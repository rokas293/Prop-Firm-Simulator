// A horizontal price line for the sim broker's own order levels (FXR_SPEC
// section B: the New-Trade ticket's entry/SL/TP, a working order's preview,
// and an open position's draggable SL/TP).
//
// Why not the built-in `horizontalStraightLine`: that one spans the pane
// edge to edge, which means a level sitting near the top of the visible
// range draws straight through the candle legend in the top-left corner.
// klinecharts draws the legend AFTER overlays (IndicatorWidget.updateOverlay
// runs the tooltip view last), so the text stays on top and legible -- but a
// dashed line passing behind it fills every gap between the glyphs, and both
// end up hard to read. There is no z-order or clip knob for this, so the
// line yields instead: inside the legend's band it starts to the right of
// the text, everywhere else it spans the full pane.
import { registerOverlay } from 'klinecharts'

export const KL_ORDER_LINE = 'klOrderLine'

// The legend block's footprint, in pane pixels. Both track the tooltip
// styles set in ChartKL's themeStyles (a 14px title row above a 12px
// OHLC row, 4px offset) -- keep them in step if that template changes.
// Deliberately generous: overshooting costs a slightly longer gap on the
// rare level that sits up there, undershooting puts the line back through
// the text.
const LEGEND_BAND_HEIGHT = 52
const LEGEND_CLEAR_WIDTH = 300

export function orderLineStartX(y: number, paneWidth: number): number {
  if (y > LEGEND_BAND_HEIGHT) return 0
  // Never eat the whole line on a narrow pane -- past halfway the gap is
  // worse than the overlap it avoids.
  return Math.min(LEGEND_CLEAR_WIDTH, paneWidth / 2)
}

let registered = false

export function ensureOrderLineOverlayRegistered(): void {
  if (registered) return
  registered = true
  registerOverlay({
    name: KL_ORDER_LINE,
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding }) => {
      const [p] = coordinates
      if (!p) return []
      const startX = orderLineStartX(p.y, bounding.width)
      return [
        {
          type: 'line',
          attrs: { coordinates: [{ x: startX, y: p.y }, { x: bounding.width, y: p.y }] },
          // Interactive on purpose: these lines are dragged to modify a
          // live order (F4), so the figure has to stay hit-testable.
        },
      ]
    },
  })
}
