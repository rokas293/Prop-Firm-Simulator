// A rectangle spanning two (time, price) corners -- there is no built-in
// "rect" OVERLAY in KLineCharts core (only a built-in "rect" FIGURE,
// confirmed against the v10.0.3 source at
// github.com/klinecharts/KLineChart/tree/v10.0.3/src/extension/overlay,
// which lists no rect.ts), so this factory registers one custom overlay
// type per caller-chosen name, built on that figure -- exactly the
// "registerOverlay for any custom shape not built in" pattern the plan
// doc calls for. Shared by tradeOverlays.ts's non-interactive trade PnL/
// SL/TP zones (Phase A1) and the user-drawn "Zone" drawing tool
// (Phase A2) so the geometry exists in exactly one place.
import { registerOverlay } from 'klinecharts'

const registered = new Set<string>()

export function registerRectOverlay(name: string, interactive: boolean): void {
  if (registered.has(name)) return
  registered.add(name)
  registerOverlay({
    name,
    totalStep: 3,
    // Point-edit handles only make sense for the interactive, user-drawn
    // variant (Phase A2's Zone tool) -- Phase A1's non-interactive trade
    // zones are `lock: true` at creation anyway, but skipping the default
    // handles here keeps them visually clean regardless.
    needDefaultPointFigure: interactive,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates }) => {
      const [p0, p1] = coordinates
      if (!p0 || !p1) return []
      return [
        {
          type: 'rect',
          attrs: {
            x: Math.min(p0.x, p1.x),
            y: Math.min(p0.y, p1.y),
            width: Math.abs(p1.x - p0.x),
            height: Math.abs(p1.y - p0.y),
          },
          ignoreEvent: !interactive,
        },
      ]
    },
  })
}
