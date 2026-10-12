// The economic calendar's markers for the KLineCharts engine (FXR_V2_SPEC.md
// section 6, G7): a thin dashed line through the pane at each scheduled
// high-impact event, a small flag on the time axis and the event's name.
//
// Only the SCHEDULE is drawn -- when and what -- which is public ahead of time, so a
// marker may sit beyond the replay cursor. There is no actual / forecast / previous
// anywhere in the data, and nothing here could show one. Like the session bands this
// is a custom registerOverlay reading `bounding` directly: the line spans the full
// pane height regardless of price.
import { registerOverlay, type OverlayCreate, type OverlayFigure } from 'klinecharts'
import { SESSION_COLORS as SESSION_HEX } from '../../state/themeStore'
import type { NewsEvent } from '../../api/types'
import { hexToRgba } from '../color'
import { FONT_FAMILY, TEXT_RESET } from './orderLabelOverlay'

export const KL_NEWS_MARKER = 'klNewsMarker'
export const NEWS_MARKER_GROUP = 'kl-news-marker'

const LINE_COLOR = hexToRgba(SESSION_HEX.news, 0.55)
const FLAG_COLOR = hexToRgba(SESSION_HEX.news, 0.95)
const FLAG_HALF_WIDTH = 4
const FLAG_HEIGHT = 7
const LABEL_MAX_CHARS = 22
// Pixels a label needs to the right of its line before it flips to the left.
const LABEL_ROOM = 150

interface NewsMarkerData {
  label: string
  // The theme's muted text colour: amber stays on the line and flag only.
  labelColor: string
}

let registered = false
export function ensureNewsMarkerOverlayRegistered(): void {
  if (registered) return
  registered = true
  registerOverlay({
    name: KL_NEWS_MARKER,
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const [p] = coordinates
      if (!p) return []
      const data = overlay.extendData as NewsMarkerData | undefined
      const bottom = bounding.height
      const nearRightEdge = bounding.width - p.x < LABEL_ROOM
      const figures: OverlayFigure[] = [
        {
          type: 'line',
          attrs: { coordinates: [{ x: p.x, y: 0 }, { x: p.x, y: bottom }] },
          styles: { style: 'dashed', color: LINE_COLOR, size: 1, dashedValue: [4, 4] },
          ignoreEvent: true,
        },
        {
          type: 'polygon',
          attrs: {
            coordinates: [
              { x: p.x, y: bottom - FLAG_HEIGHT },
              { x: p.x - FLAG_HALF_WIDTH, y: bottom },
              { x: p.x + FLAG_HALF_WIDTH, y: bottom },
            ],
          },
          styles: { style: 'fill', color: FLAG_COLOR },
          ignoreEvent: true,
        },
      ]
      if (data?.label) {
        figures.push({
          type: 'text',
          // Flips to the line's left near the right edge so the name is never clipped.
          attrs: nearRightEdge
            ? { x: p.x - FLAG_HALF_WIDTH - 3, y: bottom - 9, text: data.label, align: 'right', baseline: 'middle' }
            : { x: p.x + FLAG_HALF_WIDTH + 3, y: bottom - 9, text: data.label, align: 'left', baseline: 'middle' },
          styles: { ...TEXT_RESET, color: data.labelColor, size: 11, family: FONT_FAMILY },
          ignoreEvent: true,
        })
      }
      return figures
    },
  })
}

// One marker per release time (a 08:30 CPI and Core CPI share a line): the first
// event's name, and how many more are due at the same minute.
export function newsMarkerLabel(group: readonly NewsEvent[]): string {
  const first = group[0]?.event ?? ''
  const name = first.length > LABEL_MAX_CHARS ? `${first.slice(0, LABEL_MAX_CHARS - 1)}…` : first
  return group.length > 1 ? `${name} +${group.length - 1}` : name
}

export function groupNewsByTime(events: readonly NewsEvent[]): NewsEvent[][] {
  const byTime = new Map<number, NewsEvent[]>()
  for (const e of events) {
    const list = byTime.get(e.time)
    if (list) list.push(e)
    else byTime.set(e.time, [e])
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list)
}

export function buildNewsMarkerOverlays(events: readonly NewsEvent[], labelColor: string): OverlayCreate[] {
  return groupNewsByTime(events).map((group) => ({
    id: `kl-news-${group[0].time}`,
    name: KL_NEWS_MARKER,
    groupId: NEWS_MARKER_GROUP,
    lock: true,
    points: [{ timestamp: group[0].time * 1000, value: 0 }],
    extendData: { label: newsMarkerLabel(group), labelColor } satisfies NewsMarkerData,
  }))
}
