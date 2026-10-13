// FXR_V2_SPEC.md section 7 (G9): drawing style templates -- save a drawing's style (colour and
// line width, what the style popover edits) and apply it to new drawings.
import type { DrawingStyle } from '../../state/klDrawingStore'

// klinecharts overlay styles that carry a drawing's colour and width. Every tool reads the keys
// that apply to its shapes (lines, rectangles, polygons, circles, text).
export function styleToOverlayStyles(style: DrawingStyle) {
  const { color, width } = style
  return {
    line: { color, size: width },
    point: { color },
    rect: { borderColor: color, borderSize: width },
    polygon: { borderColor: color, borderSize: width },
    circle: { borderColor: color, borderSize: width },
    text: { color },
  }
}

interface LooseStyles {
  line?: { color?: string; size?: number }
  rect?: { borderColor?: string; borderSize?: number }
  polygon?: { borderColor?: string; borderSize?: number }
  circle?: { borderColor?: string; borderSize?: number }
  text?: { color?: string }
}

// The style a drawing currently has, read from its (partial) overlay styles; whatever it never
// set takes the given fallback (the theme default a fresh drawing renders with).
export function styleFromOverlayStyles(styles: unknown, fallback: DrawingStyle): DrawingStyle {
  const s = (styles ?? {}) as LooseStyles
  return {
    color: s.line?.color ?? s.rect?.borderColor ?? s.polygon?.borderColor ?? s.circle?.borderColor ?? s.text?.color ?? fallback.color,
    width: s.line?.size ?? s.rect?.borderSize ?? s.polygon?.borderSize ?? s.circle?.borderSize ?? fallback.width,
  }
}
