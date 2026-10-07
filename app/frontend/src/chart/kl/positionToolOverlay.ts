// FXR_V2_SPEC.md phase G3, section 3.5 (reference R2): the Long / Short Position
// tool as ONE klinecharts overlay -- a target zone above (below, for a short)
// the entry, a stop zone on the other side, an entry line, three drag handles,
// the live Target / Stop / R:R labels, and the three price tags on the y axis.
//
// Geometry: the tool is anchored to ONE bar -- the cursor bar, "now" (its three
// points share that timestamp, so it cannot reach into data that has not been
// revealed) -- and extends a fixed pixel width to the right, into the chart's
// empty right margin. Where that margin is too narrow the box is drawn shifted
// left to stay whole. Only the three prices ever move, so a
// drag is vertical; ChartKL's onPressedMoving puts every point back on the
// anchor and the tool's own levels (chart/positionTool.ts moveToolLevel) decide
// where each handle may sit.
//
// The labels are recomputed from the overlay's OWN live points on every frame,
// so a drag updates $ risk / $ reward / R:R with no React round trip -- the same
// approach as orderLabelOverlay.ts.
import { registerOverlay, type OverlayCreate } from 'klinecharts'
import { hexToRgba } from '../color'
import { fmtPrice } from '../../format'
import { roundToTick } from '../orderEntry'
import { toolLabels, type PositionToolLevels, type ToolHandle, type ToolLabel, type ToolSizing } from '../positionTool'
import type { ContractSpec } from '../simBroker'
import { FONT_FAMILY, FONT_SIZE, LABEL_HEIGHT, TEXT_RESET, textWidth } from './orderLabelOverlay'

export const KL_POSITION_TOOL = 'klPositionTool'
export const POSITION_TOOL_ID = 'kl-position-tool'
export const POSITION_TOOL_GROUP_ID = 'kl-position-tool-group'
// The tool's names in the toolbar's "armed" state.
export const POSITION_TOOL_LONG = 'klPositionLong'
export const POSITION_TOOL_SHORT = 'klPositionShort'

export const TOOL_BOX_WIDTH = 280
const HANDLE = 8
const PAD_X = 8
const PILL_GAP = 4
const CLOSE_WIDTH = 20
const ZONE_ALPHA = 0.16
// The box keeps this far from the pane's right edge when it has to shift left.
const EDGE = 8

export interface PositionToolPalette {
  entry: string // the entry line / R:R pill: the accent
  sl: string // the stop: orange, as the order lines draw it
  tp: string // the target: green
  surface: string
  text: string
  textMuted: string
  positive: string // text-safe variants for the $ amounts
  negative: string
  // Text on a tag filled with the entry / stop / target colour (the y-axis tags).
  onEntry: string
  onSl: string
  onTp: string
}

export interface PositionToolData {
  levels: PositionToolLevels // the placing-phase levels, and the side (always)
  spec: ContractSpec
  sizing: ToolSizing
  instrument: string
  palette: PositionToolPalette
  hover: boolean
  // The anchor bar (ms) while the first click is pending; once placed, the
  // overlay's own points carry it.
  anchorMs: number
}

// The levels the overlay is showing: its three live points once placed, else
// the ones it was started with (while the first click is still pending).
export function levelsOfOverlay(overlay: { points: Array<{ value?: number }>; extendData: unknown }): PositionToolLevels | null {
  const data = overlay.extendData as PositionToolData | undefined
  if (!data) return null
  const [e, s, t] = overlay.points
  if (overlay.points.length >= 3 && typeof e?.value === 'number' && typeof s?.value === 'number' && typeof t?.value === 'number') {
    return { side: data.levels.side, entry: e.value, sl: s.value, tp: t.value }
  }
  return data.levels
}

// The three points of a placed tool: one anchor bar, three prices.
export function toolPoints(levels: PositionToolLevels, anchorMs: number): NonNullable<OverlayCreate['points']> {
  return [
    { timestamp: anchorMs, value: levels.entry },
    { timestamp: anchorMs, value: levels.sl },
    { timestamp: anchorMs, value: levels.tp },
  ]
}

export const HANDLE_INDEX: Record<ToolHandle, number> = { entry: 0, sl: 1, tp: 2 }

interface Pill {
  figures: unknown[]
}

// One label: a surface-filled pill with a role-coloured border, the descriptive
// text in the primary colour and the $ amount (the number only) in its tone.
function pill(label: ToolLabel, cx: number, wantedY: number, paneWidth: number, paneHeight: number, border: string, p: PositionToolPalette, closable: boolean): Pill {
  const textW = Math.ceil(textWidth(label.text))
  const amountW = label.amount ? Math.ceil(textWidth(label.amount)) : 0
  const body = PAD_X + textW + (label.amount ? PILL_GAP + amountW : 0) + PAD_X
  const width = body + (closable ? CLOSE_WIDTH : 0)
  const x = Math.max(0, Math.min(paneWidth - width, cx - width / 2))
  // A label stays inside the pane even when its level is scrolled off the edge.
  const cy = Math.max(LABEL_HEIGHT / 2, Math.min(paneHeight - LABEL_HEIGHT / 2, wantedY))
  const y = cy - LABEL_HEIGHT / 2
  const textStyle = { ...TEXT_RESET, size: FONT_SIZE, family: FONT_FAMILY, weight: '500' }
  const figures: unknown[] = [
    {
      type: 'rect',
      ignoreEvent: true,
      attrs: { x, y, width, height: LABEL_HEIGHT },
      styles: { style: 'stroke_fill', color: p.surface, borderColor: border, borderSize: 1, borderRadius: 2 },
    },
    {
      type: 'text',
      ignoreEvent: true,
      attrs: { x: x + PAD_X, y: cy, text: label.text, align: 'left', baseline: 'middle' },
      styles: { ...textStyle, color: p.text },
    },
  ]
  if (label.amount) {
    figures.push({
      type: 'text',
      ignoreEvent: true,
      attrs: { x: x + PAD_X + textW + PILL_GAP, y: cy, text: label.amount, align: 'left', baseline: 'middle' },
      styles: { ...textStyle, color: label.tone === 'positive' ? p.positive : label.tone === 'negative' ? p.negative : p.text },
    })
  }
  if (closable) {
    figures.push(
      {
        type: 'rect',
        key: 'close',
        attrs: { x: x + body, y, width: CLOSE_WIDTH, height: LABEL_HEIGHT },
        styles: { style: 'fill', color: 'transparent' },
      },
      {
        type: 'text',
        key: 'close-text',
        ignoreEvent: true,
        attrs: { x: x + body + CLOSE_WIDTH / 2, y: cy, text: '×', align: 'center', baseline: 'middle' },
        styles: { ...textStyle, size: FONT_SIZE + 3, color: p.textMuted },
      },
    )
  }
  return { figures }
}

let registered = false

export function ensurePositionToolOverlayRegistered(): void {
  if (registered) return
  registered = true
  registerOverlay({
    name: KL_POSITION_TOOL,
    // One click places it (steps count the "done" step too): the tool needs no
    // second point -- its size is its three prices, not a dragged rectangle.
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay, xAxis, yAxis }) => {
      const data = overlay.extendData as PositionToolData | undefined
      const levels = levelsOfOverlay(overlay)
      const placed = overlay.points.length >= 3
      // Placed: the overlay's own anchor point. Still placing: the cursor bar,
      // wherever the pointer is.
      const anchorX: number | undefined = placed ? coordinates[0]?.x : xAxis ? xAxis.convertTimestampToPixel(data?.anchorMs ?? 0) : coordinates[0]?.x
      if (!data || !levels || anchorX === undefined || !yAxis) return []
      const p = data.palette
      const roomRight = bounding.width - EDGE - TOOL_BOX_WIDTH
      const x0 = anchorX > roomRight && anchorX <= bounding.width ? Math.max(0, roomRight) : anchorX
      const x1 = Math.min(bounding.width, x0 + TOOL_BOX_WIDTH)
      const midX = (x0 + x1) / 2
      const yEntry = yAxis.convertToPixel(levels.entry)
      const ySl = yAxis.convertToPixel(levels.sl)
      const yTp = yAxis.convertToPixel(levels.tp)
      const labels = toolLabels(levels, data.spec, data.sizing, data.instrument)
      const lineW = data.hover ? 2 : 1
      const zone = (yFrom: number, yTo: number, color: string) => ({
        type: 'rect',
        ignoreEvent: true,
        attrs: { x: x0, y: Math.min(yFrom, yTo), width: x1 - x0, height: Math.abs(yTo - yFrom) },
        styles: { style: 'fill', color: hexToRgba(color, ZONE_ALPHA) },
      })
      const level = (key: ToolHandle, y: number, color: string, dashed: boolean) => ({
        type: 'line',
        key,
        attrs: { coordinates: [{ x: x0, y }, { x: x1, y }] },
        styles: { style: dashed ? 'dashed' : 'solid', dashedValue: [4, 3], size: lineW, color },
      })
      const handle = (key: ToolHandle, x: number, y: number, color: string) => ({
        type: 'rect',
        key,
        attrs: { x: x - HANDLE / 2, y: y - HANDLE / 2, width: HANDLE, height: HANDLE },
        styles: { style: 'stroke_fill', color: p.surface, borderColor: color, borderSize: 1, borderRadius: 1 },
      })
      // A long's target sits above its entry and its label above the target line
      // (outside the zone); a short mirrors it. The stop's label sits on the far
      // side of the stop line.
      const tpAbove = yTp < yEntry
      const slAbove = ySl < yEntry
      const tpPill = pill(labels.target, midX, tpAbove ? yTp - LABEL_HEIGHT / 2 - 4 : yTp + LABEL_HEIGHT / 2 + 4, bounding.width, bounding.height, p.tp, p, false)
      const slPill = pill(labels.stop, midX, slAbove ? ySl - LABEL_HEIGHT / 2 - 4 : ySl + LABEL_HEIGHT / 2 + 4, bounding.width, bounding.height, p.sl, p, false)
      const centerPill = pill(labels.center, midX, yEntry, bounding.width, bounding.height, p.entry, p, placed)
      const figures: unknown[] = [
        zone(yEntry, yTp, p.tp),
        zone(yEntry, ySl, p.sl),
        level('tp', yTp, p.tp, false),
        level('sl', ySl, p.sl, false),
        level('entry', yEntry, p.entry, true),
        ...tpPill.figures,
        ...slPill.figures,
        ...centerPill.figures,
      ]
      // Handles only once placed (the preview that follows the pointer has none).
      if (placed) figures.push(handle('tp', x0, yTp, p.tp), handle('sl', x0, ySl, p.sl), handle('entry', x1, yEntry, p.entry))
      return figures as never
    },
    // The three price tags on the y axis (reference R2's coloured tags).
    createYAxisFigures: ({ bounding, overlay, yAxis }) => {
      const data = overlay.extendData as PositionToolData | undefined
      const levels = levelsOfOverlay(overlay)
      if (!data || !levels || !yAxis) return []
      const spec = data.spec
      const tag = (price: number, fill: string, text: string) => {
        const y = yAxis.convertToPixel(price)
        return [
          { type: 'rect', ignoreEvent: true, attrs: { x: 0, y: y - LABEL_HEIGHT / 2, width: bounding.width, height: LABEL_HEIGHT }, styles: { style: 'fill', color: fill, borderRadius: 2 } },
          {
            type: 'text',
            ignoreEvent: true,
            attrs: { x: bounding.width / 2, y, text: fmtPrice(roundToTick(price, spec.tickSize), data.instrument), align: 'center', baseline: 'middle' },
            styles: { ...TEXT_RESET, color: text, size: FONT_SIZE, family: FONT_FAMILY, weight: '500' },
          },
        ]
      }
      const p = data.palette
      return [...tag(levels.tp, p.tp, p.onTp), ...tag(levels.sl, p.sl, p.onSl), ...tag(levels.entry, p.entry, p.onEntry)] as never
    },
  })
}
