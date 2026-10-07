// FXR_V2_SPEC.md phase G2 (sections 2 and 3.2): the sim broker's on-chart order
// lines -- the open position's line, its SL/TP, the ghost SL/TP and working
// orders -- as ONE klinecharts overlay: a dashed price line across the pane, a
// segmented label at the right (tag | $ | qty | x), and a price tag on the y
// axis. Structure follows the reference screenshots (R10 position line, R11
// ghost SL/TP): grip-less here since the whole line drags.
//
// Why a custom overlay and not DOM: canvas figures track pan/zoom/axis-scale
// for free, and the label text is recomputed from the overlay's OWN live point
// on every frame, so a drag shows live $/ticks/% with no React round trip.
// The line starts clear of the candle legend (orderLineOverlay.ts says why it
// doesn't span the legend corner).
import { registerOverlay } from 'klinecharts'
import { hexToRgba } from '../color'
import { contrastRatio, mixHex } from '../../state/contrast'
import { labelSegments, roundToTick, type LabelSegment, type OrderLineInfo } from '../orderEntry'
import { orderLineStartX } from './orderLineOverlay'

export const KL_ORDER_LABEL = 'klOrderLabel'

export interface OrderLabelPalette {
  line: string // the role colour: accent (position/order), orange (SL), green (TP)
  surface: string // label background
  text: string
  textMuted: string
  positive: string
  negative: string
  onRole: string // text on a role-coloured fill (the SL/TP tag, the axis tag)
  ghost: string // the ghost's border/line: the role colour toned down, never below 3:1 on the chart background
}

export interface OrderLabelData {
  info: OrderLineInfo
  palette: OrderLabelPalette
  // Formats a price for the axis tag (instrument precision).
  formatPrice: (price: number) => string
  // The pointer is over this line: it brightens (a ghost is otherwise faint).
  hover?: boolean
}

export function isGhostRole(role: string): boolean {
  return role === 'ghost-sl' || role === 'ghost-tp'
}

// Ghosts are provisional: faint until hovered or dragged. Placed levels and
// the position are full strength.
export const GHOST_MIN_CONTRAST = 3
const GHOST_ALPHA_FLOOR = 0.4
const GHOST_ALPHA_CEIL = 0.85

// The ghost's border and line: the role colour blended toward the chart
// background by the SMALLEST step that still reads at 3:1 on that background
// (so it is as faint as it can be while staying visible, in dark and light
// alike), capped well short of full strength so a placed level is always
// clearly stronger. Solid hex, no alpha, so it draws crisp.
export function ghostStroke(lineHex: string, bgHex: string): string {
  for (let a = GHOST_ALPHA_FLOOR; a <= GHOST_ALPHA_CEIL + 1e-9; a += 0.05) {
    const c = mixHex(bgHex, lineHex, a)
    if (contrastRatio(c, bgHex) >= GHOST_MIN_CONTRAST) return c
  }
  return mixHex(bgHex, lineHex, GHOST_ALPHA_CEIL)
}
const GHOST_TEXT_ALPHA = 0.65

export const FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
// 12px: the type scale's secondary/table size (11 is reserved for caps micro-labels).
export const FONT_SIZE = 12
export const LABEL_HEIGHT = 20 // 4px grid
const PAD_X = 8
const RIGHT_MARGIN = 8
const CLOSE_WIDTH = 20
const GRIP_WIDTH = 16

// The chart theme styles overlay text with a backdrop and padding; these labels
// draw their own rectangles, so the text must bring none of that.
export const TEXT_RESET = {
  style: 'fill',
  backgroundColor: 'transparent',
  borderColor: 'transparent',
  borderSize: 0,
  paddingLeft: 0,
  paddingRight: 0,
  paddingTop: 0,
  paddingBottom: 0,
}

let measureCtx: CanvasRenderingContext2D | null = null
export function textWidth(text: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7
  measureCtx.font = `500 ${FONT_SIZE}px ${FONT_FAMILY}`
  return measureCtx.measureText(text).width
}

function toneColor(seg: LabelSegment, p: OrderLabelPalette): string {
  switch (seg.tone) {
    case 'positive':
      return p.positive
    case 'negative':
      return p.negative
    case 'muted':
      return p.textMuted
    case 'tag':
      return p.onRole
    default:
      return p.text
  }
}

// The widest a typical number-bearing segment gets: a label's box is never
// narrower than this, and digits are measured as "0", so the label's left edge
// does not jitter while a level is dragged (the P&L, ticks and % change on every
// frame). Canvas text has no tabular-figures switch, hence the measuring rule.
const WIDE_BODY = '-$0,000.00 | 000 ticks | 0.00%'
const WIDE_PNL = '-$0,000.00'

export function stableText(seg: LabelSegment): string {
  if (seg.key !== 'body') return seg.text
  return seg.text.includes('|') ? WIDE_BODY : WIDE_PNL
}

// Pure layout, exported for tests: segment widths and the label's left edge
// for a pane `paneWidth` wide. The label hugs the right edge of the pane.
export function layoutLabel(segments: LabelSegment[], paneWidth: number, measure: (t: string) => number = textWidth) {
  const widths = segments.map((s) => {
    if (s.key === 'close') return CLOSE_WIDTH
    if (s.key === 'grip') return GRIP_WIDTH
    const own = Math.ceil(measure(s.text.replace(/\d/g, '0')))
    const floor = s.key === 'body' ? Math.ceil(measure(stableText(s))) : 0
    return Math.max(own, floor) + PAD_X * 2
  })
  const total = widths.reduce((a, b) => a + b, 0)
  const left = Math.max(0, paneWidth - RIGHT_MARGIN - total)
  const xs: number[] = []
  let x = left
  for (const w of widths) {
    xs.push(x)
    x += w
  }
  return { widths, xs, left, total }
}

// Labels whose lines are closer than a label's height would sit on top of each
// other (a break-even stop is AT the entry; a target can be a tick from the
// market) and hide each other's P&L and x. Each overlay computes the same
// deterministic stacking from its siblings, so they sit side by side instead:
// by role rank (position first, then placed levels, ghosts, working orders; ties
// by id), each label shifts left of every higher-ranked one it vertically
// overlaps. Pure, so it can be tested without a chart.
const ROLE_RANK: Record<string, number> = { position: 0, sl: 1, tp: 1, 'ghost-sl': 2, 'ghost-tp': 2, order: 3 }
const STACK_GAP = 4

export interface StackEntry {
  id: string
  role: string
  y: number
  width: number
}

export function stackOffsets(entries: StackEntry[]): Map<string, number> {
  const ordered = [...entries].sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || (a.id < b.id ? -1 : 1))
  const placed: Array<StackEntry & { offset: number }> = []
  const out = new Map<string, number>()
  for (const e of ordered) {
    let offset = 0
    for (const f of placed) {
      if (Math.abs(f.y - e.y) < LABEL_HEIGHT) offset = Math.max(offset, f.offset + f.width + STACK_GAP)
    }
    placed.push({ ...e, offset })
    out.set(e.id, offset)
  }
  return out
}

// ---- y-axis price tags ------------------------------------------------------
// Each level has a tag on the price axis. With a tight bracket (a 4-tick stop is
// a few pixels at normal zoom) the tags of the position, SL, TP and the market's
// own last-price tag would sit on top of each other and hide their prices. So the
// tags are laid out vertically: the last-price tag is drawn by klinecharts and
// cannot move (an obstacle); the rest keep their true height when there is room
// and otherwise take the NEAREST free slot at least one tag plus a gap away, in
// role priority (position first, then placed levels, ghosts, working orders; ties
// by id). Every overlay derives the same layout from its siblings, so no tag
// needs to know about the others' drawing. A displaced tag keeps a thin bar at
// its left edge spanning from its true price to where it sits.
export const AXIS_TAG_SPACING = LABEL_HEIGHT + 4

export interface AxisTagEntry {
  id: string
  role: string
  // The level's true pixel height on the axis.
  y: number
}

export function axisTagLayout(entries: AxisTagEntry[], obstacles: number[], axisHeight: number, spacing = AXIS_TAG_SPACING): Map<string, number> {
  const half = LABEL_HEIGHT / 2
  const lo = half
  const hi = Math.max(lo, axisHeight - half)
  const clamp = (y: number) => Math.min(hi, Math.max(lo, y))
  const ordered = [...entries].sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || (a.id < b.id ? -1 : 1))
  const taken = [...obstacles]
  const out = new Map<string, number>()
  for (const e of ordered) {
    const want = clamp(e.y)
    const candidates = [want, lo, hi, ...taken.flatMap((t) => [t - spacing, t + spacing])].map(clamp)
    let best = want
    let bestCost = Infinity
    for (const c of candidates) {
      if (taken.some((t) => Math.abs(t - c) < spacing - 1e-9)) continue
      const cost = Math.abs(c - want)
      if (cost < bestCost) {
        best = c
        bestCost = cost
      }
    }
    // No free slot (more tags than the axis can hold): leave it at its own height.
    out.set(e.id, bestCost === Infinity ? want : best)
    taken.push(out.get(e.id) as number)
  }
  return out
}

let registered = false

export function ensureOrderLabelOverlayRegistered(): void {
  if (registered) return
  registered = true
  registerOverlay({
    name: KL_ORDER_LABEL,
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ chart, coordinates, bounding, overlay, yAxis }) => {
      const p = coordinates[0]
      const data = overlay.extendData as OrderLabelData | undefined
      const price = overlay.points[0]?.value
      if (!p || !data || typeof price !== 'number') return []
      const { palette, info } = data
      const segments = labelSegments(info, price)
      // Step aside for any sibling label this one would cover.
      let shift = 0
      if (yAxis) {
        const entries: StackEntry[] = []
        for (const o of chart.getOverlays({ groupId: overlay.groupId })) {
          const d = o.extendData as OrderLabelData | undefined
          const v = o.points[0]?.value
          if (!d || typeof v !== 'number') continue
          entries.push({ id: o.id, role: d.info.role, y: yAxis.convertToPixel(v), width: layoutLabel(labelSegments(d.info, v), bounding.width).total })
        }
        shift = stackOffsets(entries).get(overlay.id) ?? 0
      }
      const { widths, xs } = layoutLabel(segments, bounding.width - shift)
      const ghost = isGhostRole(info.role)
      const roleFill = info.role === 'sl' || info.role === 'tp'
      // Ghost: hairline in the role colour at reduced strength, hollow tag --
      // nothing about it reads as a live order. Hover/drag brings it to full.
      const border = ghost && !data.hover ? palette.ghost : palette.line
      const figures: unknown[] = [
        {
          type: 'line',
          attrs: { coordinates: [{ x: orderLineStartX(p.y, bounding.width), y: p.y }, { x: bounding.width, y: p.y }] },
          key: 'line',
        },
      ]
      segments.forEach((seg, i) => {
        const filled = seg.tone === 'tag' && roleFill
        figures.push({
          type: 'rect',
          key: seg.key,
          attrs: { x: xs[i], y: p.y - LABEL_HEIGHT / 2, width: widths[i], height: LABEL_HEIGHT },
          styles: {
            style: 'stroke_fill',
            color: filled ? palette.line : palette.surface,
            borderColor: border,
            borderSize: 1,
            borderStyle: ghost ? 'dashed' : 'solid',
            borderDashedValue: [3, 2],
            borderRadius: 2,
          },
        })
        if (seg.key === 'grip') {
          // Two columns of three dots: "this can be dragged".
          const cx = xs[i] + widths[i] / 2
          for (const dx of [-2, 2]) {
            for (const dy of [-4, 0, 4]) {
              figures.push({
                type: 'circle',
                key: 'grip-dot',
                ignoreEvent: true,
                attrs: { x: cx + dx, y: p.y + dy, r: 1 },
                styles: { style: 'fill', color: palette.textMuted },
              })
            }
          }
          return
        }
        // A ghost's tag is hollow, so its text takes the role colour (on a
        // filled tag it takes the colour that reads on the fill).
        // A ghost's whole label is faint (not just its border) until hovered or
        // dragged, so the P&L it quotes never reads like a live stop's.
        const base = seg.tone === 'tag' && ghost ? palette.line : toneColor(seg, palette)
        const color = ghost && !data.hover && seg.key !== 'hint' ? hexToRgba(base, GHOST_TEXT_ALPHA) : base
        figures.push({
          type: 'text',
          key: `${seg.key}-text`,
          ignoreEvent: true,
          attrs: { x: xs[i] + widths[i] / 2, y: p.y, text: seg.text, align: 'center', baseline: 'middle' },
          styles: { ...TEXT_RESET, color, size: seg.key === 'close' ? FONT_SIZE + 3 : FONT_SIZE, family: FONT_FAMILY, weight: '500' },
        })
      })
      return figures as never
    },
    // The y-axis price tag (R10/R11's coloured tag on the axis).
    createYAxisFigures: ({ chart, coordinates, bounding, overlay, yAxis }) => {
      const p = coordinates[0]
      const data = overlay.extendData as OrderLabelData | undefined
      const price = overlay.points[0]?.value
      if (!p || !data || typeof price !== 'number') return []
      // Where this tag sits once the siblings and the market's own price tag are
      // accounted for (see axisTagLayout); its true level stays at p.y.
      let y = p.y
      if (yAxis) {
        const entries: AxisTagEntry[] = []
        for (const o of chart.getOverlays({ groupId: overlay.groupId })) {
          const d = o.extendData as OrderLabelData | undefined
          const v = o.points[0]?.value
          if (!d || typeof v !== 'number') continue
          entries.push({ id: o.id, role: d.info.role, y: yAxis.convertToPixel(v) })
        }
        const dataList = chart.getDataList()
        const last = dataList[dataList.length - 1]
        const obstacles = last ? [yAxis.convertToPixel(last.close)] : []
        y = axisTagLayout(entries, obstacles, bounding.height).get(overlay.id) ?? p.y
      }
      // The tag shows the tick-snapped price (what a release would set), never
      // the raw pointer price; a ghost's tag is hollow like its label.
      const ghost = isGhostRole(data.info.role)
      const tagBorder = ghost && !data.hover ? data.palette.ghost : data.palette.line
      const figures: unknown[] = []
      if (Math.abs(y - p.y) > 1) {
        figures.push({
          type: 'rect',
          ignoreEvent: true,
          attrs: { x: 0, y: Math.min(y, p.y), width: 2, height: Math.abs(y - p.y) },
          styles: { style: 'fill', color: tagBorder },
        })
      }
      figures.push(
        {
          type: 'rect',
          ignoreEvent: true,
          attrs: { x: 0, y: y - LABEL_HEIGHT / 2, width: bounding.width, height: LABEL_HEIGHT },
          styles: ghost
            ? { style: 'stroke_fill', color: data.palette.surface, borderColor: tagBorder, borderSize: 1, borderRadius: 2 }
            : { style: 'fill', color: data.palette.line, borderRadius: 2 },
        },
        {
          type: 'text',
          ignoreEvent: true,
          attrs: { x: bounding.width / 2, y, text: data.formatPrice(roundToTick(price, data.info.spec.tickSize)), align: 'center', baseline: 'middle' },
          styles: { ...TEXT_RESET, color: ghost ? data.palette.line : data.palette.onRole, size: FONT_SIZE, family: FONT_FAMILY, weight: '500' },
        },
      )
      return figures as never
    },
  })
}
