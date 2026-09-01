// The left drawing toolbar's tool catalog (PART_A_REVISED_klinecharts.md
// Phase A2) -- built-in klinecharts overlays used as-is, plus a small set
// of custom ones (registerOverlay) for shapes/measure the library's core
// v10.0.3 doesn't ship. The full built-in overlay list was confirmed
// against github.com/klinecharts/KLineChart/tree/v10.0.3/src/extension/
// overlay (not assumed) -- it has no rectangle/circle/triangle/polygon
// shape overlays, and only one Fibonacci variant (retracement); those gaps
// are filled here per PART_A_REVISED_klinecharts.md's own guidance ("If
// any built-in overlay is missing... registerOverlay lets you add it...
// note gaps rather than reintroducing a fragile parallel drawing engine").
import { getFigureClass, registerFigure, registerOverlay, type Coordinate, type LineAttrs, type LineStyle, type OverlayCreate } from 'klinecharts'
import { computeMeasure, formatDuration } from '../measure'
import type { Bar } from '../../api/types'
import { registerRectOverlay } from './rectOverlay'

export type DrawingGroup = 'lines' | 'fibonacci' | 'shapes' | 'annotations'

export interface DrawingTool {
  name: string
  label: string
  group: DrawingGroup
  // Placing this tool asks for free-text via window.prompt() (a plain
  // string, so it round-trips through JSON persistence with no special
  // handling -- unlike klMeasure's live-computed label below).
  promptsForText?: boolean
}

export const KL_ZONE = 'klZone'
export const KL_CIRCLE = 'klCircle'
export const KL_TRIANGLE = 'klTriangle'
export const KL_MEASURE = 'klMeasure'

export const DRAWING_TOOLS: DrawingTool[] = [
  // Lines -- all real klinecharts built-ins.
  { name: 'horizontalStraightLine', label: 'Horizontal', group: 'lines' },
  { name: 'horizontalRayLine', label: 'Horizontal ray', group: 'lines' },
  { name: 'horizontalSegment', label: 'Horizontal segment', group: 'lines' },
  { name: 'verticalStraightLine', label: 'Vertical', group: 'lines' },
  { name: 'verticalRayLine', label: 'Vertical ray', group: 'lines' },
  { name: 'verticalSegment', label: 'Vertical segment', group: 'lines' },
  { name: 'segment', label: 'Trend', group: 'lines' },
  { name: 'rayLine', label: 'Ray', group: 'lines' },
  { name: 'straightLine', label: 'Extended', group: 'lines' },
  { name: 'priceLine', label: 'Price line', group: 'lines' },
  { name: 'parallelStraightLine', label: 'Parallel channel', group: 'lines' },
  { name: 'priceChannelLine', label: 'Price channel', group: 'lines' },
  // Fibonacci -- only "retracement" ships in core v10.0.3; extension/fan/
  // time-zone/circle variants would each need their own custom geometry
  // (noted gap, not built here -- see this file's header comment).
  { name: 'fibonacciLine', label: 'Retracement', group: 'fibonacci' },
  // Shapes -- all custom (no built-in shape overlays in core).
  { name: KL_ZONE, label: 'Zone', group: 'shapes' },
  { name: KL_CIRCLE, label: 'Circle', group: 'shapes' },
  { name: KL_TRIANGLE, label: 'Triangle', group: 'shapes' },
  // Annotations.
  { name: 'simpleAnnotation', label: 'Arrow / note', group: 'annotations', promptsForText: true },
  { name: 'simpleTag', label: 'Tag', group: 'annotations', promptsForText: true },
  { name: KL_MEASURE, label: 'Measure', group: 'annotations' },
  { name: 'brush', label: 'Brush', group: 'annotations' },
]

export const DRAWING_GROUP_ID = 'kl-user-drawing'

// The bars the measure tool computes bars-between/points/%/duration
// against -- set once per load by ChartKL (same bars A1's trade overlays
// use), read by klMeasure's live label function below. Module-level
// rather than threaded through createPointFigures' params because
// registerOverlay runs once at import time, outside any component's
// props/state.
let measureBars: Bar[] = []
export function setMeasureBarsContext(bars: Bar[]): void {
  measureBars = bars
}

export function measureLabel(
  p0: { timestamp?: number; value?: number },
  p1: { timestamp?: number; value?: number },
): string {
  if (p0.value === undefined || p1.value === undefined || p0.timestamp === undefined || p1.timestamp === undefined) {
    return ''
  }
  const result = computeMeasure(
    { time: p0.timestamp / 1000, price: p0.value },
    { time: p1.timestamp / 1000, price: p1.value },
    measureBars,
  )
  const sign = result.points >= 0 ? '+' : ''
  return `${sign}${result.points.toFixed(2)} (${sign}${result.percent.toFixed(2)}%)  ${result.bars} bars  ${formatDuration(result.seconds)}`
}

// klinecharts hardcodes a 2px hit-tolerance for its built-in 'line' figure
// (confirmed against the v10.0.3 source's DEVIATION constant -- not exposed
// via any public style/option), which is exactly why a thin trendline/ray/
// Fibonacci level is hard to grab with the mouse (REPLICA_ROADMAP.md Batch
// 1: "widen the interactive hit-tolerance for lines/segments/rays/fibs").
// Re-registering the figure under the SAME name applies globally to every
// overlay built on it -- every "Lines" tool, Fibonacci retracement, the
// measure tool's own line, and the SL/TP levels -- via one change, instead
// of reimplementing each of those overlay types from scratch (exactly the
// "fragile parallel drawing engine" this file's own header comment warns
// against). The visual draw is untouched: re-delegated to klinecharts' OWN
// existing 'line' figure class (captured via getFigureClass before the
// override), so rendering stays pixel-identical -- only the invisible hit
// radius grows.
export const LINE_HIT_TOLERANCE_PX = 6

export function distanceToSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(x - x1, y - y1)
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

// Exported standalone (not just inlined in registerFigure below) so the
// hit-tolerance itself is unit-testable without mounting a chart --
// REPLICA_ROADMAP.md Batch 1's own acceptance bar: "verify a click a few
// px off the line still selects it."
export function wideLineCheckEventOn(coordinate: Coordinate, attrs: LineAttrs | LineAttrs[]): boolean {
  const lines: LineAttrs[] = Array.isArray(attrs) ? attrs : [attrs]
  for (const line of lines) {
    const pts = line.coordinates
    for (let i = 1; i < pts.length; i++) {
      if (distanceToSegment(coordinate.x, coordinate.y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= LINE_HIT_TOLERANCE_PX) {
        return true
      }
    }
  }
  return false
}

let lineHitAreaRegistered = false
function ensureWideLineHitAreaRegistered(): void {
  if (lineHitAreaRegistered) return
  lineHitAreaRegistered = true
  const OriginalLine = getFigureClass<LineAttrs | LineAttrs[], LineStyle>('line')
  if (!OriginalLine) return // defensive only -- 'line' always ships built in
  registerFigure<LineAttrs | LineAttrs[], LineStyle>({
    name: 'line',
    checkEventOn: wideLineCheckEventOn,
    draw: (ctx, attrs, styles) => {
      new OriginalLine({ name: 'line', attrs, styles }).draw(ctx)
    },
  })
}

let customOverlaysRegistered = false
export function ensureDrawingOverlaysRegistered(): void {
  if (customOverlaysRegistered) return
  customOverlaysRegistered = true

  ensureWideLineHitAreaRegistered()
  registerRectOverlay(KL_ZONE, true)

  registerOverlay({
    name: KL_CIRCLE,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates }) => {
      const [center, edge] = coordinates
      if (!center || !edge) return []
      const r = Math.hypot(edge.x - center.x, edge.y - center.y)
      return [{ type: 'circle', attrs: { x: center.x, y: center.y, r } }]
    },
  })

  registerOverlay({
    name: KL_TRIANGLE,
    totalStep: 4,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates }: { coordinates: Coordinate[] }) => {
      if (coordinates.length < 3) return []
      return [{ type: 'polygon', attrs: { coordinates } }]
    },
  })

  registerOverlay({
    name: KL_MEASURE,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const [p0, p1] = coordinates
      const points = overlay.points
      if (!p0 || !p1 || points.length < 2) return []
      const midX = (p0.x + p1.x) / 2
      const midY = (p0.y + p1.y) / 2
      return [
        { type: 'line', attrs: { coordinates: [p0, p1] } },
        {
          type: 'text',
          ignoreEvent: true,
          attrs: { x: midX, y: midY - 8, text: measureLabel(points[0], points[1]), align: 'center', baseline: 'bottom' },
        },
      ]
    },
  })
}

// ---- persistence (localStorage, per instrument -- see klDrawingStore.ts)
// ----
// klMeasure's label is computed live (measureLabel above), never stored --
// functions/derived text don't round-trip through JSON, and re-deriving it
// from the persisted points + whatever bars happen to be loaded on restore
// is exactly the same computation either way, so there's nothing lost.
export interface PersistedOverlay {
  id: string
  name: string
  points: OverlayCreate['points']
  styles?: OverlayCreate['styles']
  extendDataText?: string
  // Per-drawing context menu's "Lock" (REPLICA_ROADMAP.md Batch 1) -- not
  // persisting this meant a locked drawing silently UN-locked itself on
  // the next reload/instrument switch, since hydrateOverlay had nothing to
  // pass klinecharts and it defaults every new overlay to lock: false.
  lock?: boolean
  // The drawing manager's per-item "hide" (REPLICA_ROADMAP.md Batch 2) --
  // same round-trip concern as lock above: without persisting it, a hidden
  // drawing would silently reappear on the next reload/instrument switch.
  visible?: boolean
}

export function serializeOverlay(overlay: {
  id: string
  name: string
  points: OverlayCreate['points']
  styles: OverlayCreate['styles']
  extendData: unknown
  lock?: boolean
  visible?: boolean
}): PersistedOverlay {
  return {
    id: overlay.id,
    name: overlay.name,
    points: overlay.points,
    styles: overlay.styles ?? undefined,
    extendDataText: typeof overlay.extendData === 'string' ? overlay.extendData : undefined,
    lock: overlay.lock,
    visible: overlay.visible,
  }
}

// Rebuilds a creatable OverlayCreate from a persisted record, re-attaching
// the live event callbacks the caller passes in (persistence hooks,
// mirroring how they're attached to freshly-drawn overlays) so a restored
// overlay is just as editable/persistable as one drawn this session.
export function hydrateOverlay(
  persisted: PersistedOverlay,
  callbacks: Pick<OverlayCreate, 'onDrawEnd' | 'onRemoved' | 'onPressedMoveEnd' | 'onRightClick' | 'onMouseEnter' | 'onMouseLeave'>,
): OverlayCreate {
  return {
    id: persisted.id,
    name: persisted.name,
    groupId: DRAWING_GROUP_ID,
    points: persisted.points,
    styles: persisted.styles,
    extendData: persisted.extendDataText,
    lock: persisted.lock ?? false,
    visible: persisted.visible ?? true,
    ...callbacks,
  }
}

export function toolByName(name: string): DrawingTool | undefined {
  return DRAWING_TOOLS.find((t) => t.name === name)
}
