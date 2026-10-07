// Where an order level's price line starts (FXR_V2_SPEC.md G2): the sim broker's
// order lines (orderLabelOverlay.ts) and the position tool never run through the
// candle legend in the pane's top-left corner.
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
//
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
