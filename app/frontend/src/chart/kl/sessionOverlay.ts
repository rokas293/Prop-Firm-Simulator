// Session background shading + fair-value lines for the KLineCharts engine
// (PART_A_REVISED_klinecharts.md Phase A3) -- values come straight from
// /api/sessions (ChartPanel already fetches this for the lightweight-
// charts engine; same data, same SessionBand shape, just re-rendered).
// Session shading needs a genuinely full-pane-height band regardless of
// price (a session spans the whole visible price range, not a price
// zone), which is exactly the kind of raw-pixel geometry no built-in
// price/time-anchored overlay exposes -- so, like Phase A1's trade zones,
// it's a custom registerOverlay built on the 'rect' figure, this time
// reading `bounding.height` directly instead of two price-derived
// corners (the deferred "true full-height" version noted in
// tradeOverlays.ts's PnL-zone comment).
import { registerOverlay, type OverlayCreate } from 'klinecharts'
import { SESSION_COLORS as SESSION_HEX } from '../../state/themeStore'
import { hexToRgba } from '../color'

export const KL_SESSION_BAND = 'klSessionBand'
export const SESSION_BAND_GROUP = 'kl-session-band'
export const FAIR_VALUE_GROUP = 'kl-fair-value'

// Session shape shared with ChartPanel.tsx, which fetches /api/sessions
// once and hands the same bands to whichever engine is mounted -- lived on
// the lightweight-charts-only SessionBandsPrimitive.ts until that file was
// removed (PART_A_REVISED_klinecharts.md's parity audit), moved here since
// this is the side that outlives it.
export interface SessionBand {
  start: number
  end: number
  session: string
  fairValue: number | null
}

// Session identity colors come from themeStore.ts's SESSION_COLORS (Part C1
// audit risk #3 -- "which session is this" is categorical, not a
// win/loss/accent semantic, so it's a fixed hex per session there, shared
// with anything else that ever needs to show a session's identity color).
// hexToRgba applies each shading alpha here, at the point of use, since the
// alpha (how STRONG the shading is) is a rendering concern of this overlay,
// not part of the session's identity.
const SESSION_ALPHA: Record<string, number> = { asia: 0.07, london: 0.07, ny: 0.07, news: 0.09 }
const SESSION_COLORS: Record<string, string> = {
  asia: hexToRgba(SESSION_HEX.asia, SESSION_ALPHA.asia),
  london: hexToRgba(SESSION_HEX.london, SESSION_ALPHA.london),
  ny: hexToRgba(SESSION_HEX.ny, SESSION_ALPHA.ny),
  news: hexToRgba(SESSION_HEX.news, SESSION_ALPHA.news),
}
const DEFAULT_SESSION_COLOR = 'rgba(139, 148, 158, 0.06)'
export const FAIR_VALUE_COLOR = 'rgba(201, 209, 217, 0.6)'

export function sessionColor(session: string): string {
  return SESSION_COLORS[session] ?? DEFAULT_SESSION_COLOR
}

let registered = false
export function ensureSessionBandOverlayRegistered(): void {
  if (registered) return
  registered = true
  registerOverlay({
    name: KL_SESSION_BAND,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const [p0, p1] = coordinates
      if (!p0 || !p1) return []
      const color = typeof overlay.extendData === 'string' ? overlay.extendData : DEFAULT_SESSION_COLOR
      return [
        {
          type: 'rect',
          attrs: { x: Math.min(p0.x, p1.x), y: 0, width: Math.abs(p1.x - p0.x), height: bounding.height },
          ignoreEvent: true,
          styles: { style: 'fill', color },
        },
      ]
    },
  })
}

export function buildSessionBandOverlay(band: SessionBand): OverlayCreate {
  return {
    id: `kl-session-${band.session}-${band.start}`,
    name: KL_SESSION_BAND,
    groupId: SESSION_BAND_GROUP,
    lock: true,
    // Value is unused (the figure above ignores price entirely, spanning
    // the full pane height) -- 0 is an arbitrary placeholder just to give
    // the point a valid shape.
    points: [
      { timestamp: band.start * 1000, value: 0 },
      { timestamp: band.end * 1000, value: 0 },
    ],
    extendData: sessionColor(band.session),
  }
}

// Non-interactive use of the built-in horizontalSegment overlay (same
// pattern as Phase A1's SL/TP price lines): both points share the same
// `value` so it renders as a flat segment spanning just this session's
// time range, matching SessionBandsPrimitive.ts's "a fair value is only
// meaningful for the span of its own session" (not a full-width price
// line like SL/TP).
export function buildFairValueOverlay(band: SessionBand): OverlayCreate | null {
  if (band.fairValue === null) return null
  return {
    id: `kl-fairvalue-${band.session}-${band.start}`,
    name: 'horizontalSegment',
    groupId: FAIR_VALUE_GROUP,
    lock: true,
    points: [
      { timestamp: band.start * 1000, value: band.fairValue },
      { timestamp: band.end * 1000, value: band.fairValue },
    ],
    styles: { line: { color: FAIR_VALUE_COLOR, style: 'dashed', size: 1 } },
  }
}
