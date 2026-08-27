// Pure hex -> rgba conversion (POLISH_ROADMAP Phase P6): the theme store
// holds plain hex strings (from <input type="color"> and the curated
// presets), but canvas primitives need translucent fills (e.g. a trade
// bracket's shaded PnL zone) -- this is the one conversion point, tested in
// isolation, that everything reading a theme color for a canvas fill goes
// through.
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const int = parseInt(full, 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
