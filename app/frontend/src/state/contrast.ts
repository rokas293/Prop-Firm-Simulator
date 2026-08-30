// WCAG 2.x contrast-ratio math (REDESIGN_APPROACH.md Part C2: "enforce a
// minimum text/background contrast ratio (warn or auto-adjust)"). Pure
// hex-in-hex-out, no React/store dependency, so the Theme Editor's
// guardrail and its tests call the exact same functions.
//
// Thresholds: WCAG AA normal text is 4.5:1 (used for accent/positive/
// negative, which render as literal text color -- error messages, win/loss
// badges -- throughout the app, not just decoration); WCAG AA "UI
// components and graphical objects" is 3:1 (used for the candle colors,
// which are canvas fills against the chart background, not text).
export const MIN_TEXT_CONTRAST = 4.5
export const MIN_UI_CONTRAST = 3.0

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const int = parseInt(full, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  return '#' + [r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')
}

// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio -- symmetric, always in
// [1, 21] (1 = identical colors, 21 = pure black vs pure white).
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA]
  return (lighter + 0.05) / (darker + 0.05)
}

export function passesContrast(hex: string, bgHex: string, minRatio: number): boolean {
  return contrastRatio(hex, bgHex) >= minRatio
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = l * 255
    return rgbToHex(v, v, v)
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return rgbToHex(hue2rgb(h + 1 / 3) * 255, hue2rgb(h) * 255, hue2rgb(h - 1 / 3) * 255)
}

// Walks the color's own lightness toward whichever end raises contrast
// against `bgHex` (lighten on a dark background, darken on a light one) and
// stops the instant `minRatio` clears -- keeps the user's chosen hue rather
// than snapping to black/white outright. Gives up at the lightness extreme
// (0 or 1) rather than looping forever if minRatio is unreachable for this
// hue against this background; returns the closest it got in that case.
export function ensureContrast(hex: string, bgHex: string, minRatio: number): string {
  if (passesContrast(hex, bgHex, minRatio)) return hex
  const bgIsLight = relativeLuminance(bgHex) > 0.5
  const [h, s, l] = hexToHsl(hex)
  const step = bgIsLight ? -0.02 : 0.02
  let lightness = l
  for (let i = 0; i < 50; i++) {
    const next = Math.max(0, Math.min(1, lightness + step))
    lightness = next
    const candidate = hslToHex(h, s, lightness)
    if (passesContrast(candidate, bgHex, minRatio)) return candidate
    if (lightness === 0 || lightness === 1) break
  }
  return hslToHex(h, s, lightness)
}
