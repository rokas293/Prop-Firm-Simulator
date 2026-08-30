// Theme system (POLISH_ROADMAP Phase P6, expanded to the full semantic
// token set in REDESIGN_APPROACH.md Part C1). `colors` holds the tunable
// SEMANTIC tokens (accent/positive/negative/up-candle/down-candle);
// `mode` picks between the two BASE token sets (dark/light) defined in
// index.css's `@theme` / `[data-theme='light']` blocks. Both are single
// sources of truth: CSS-consuming UI reads the live CSS custom properties
// via Tailwind utilities built from them (bg-accent, text-positive, etc.),
// and canvas-consuming chart code (ChartKL.tsx, RiskChart.tsx, and the
// Recharts panels' per-datum colors) reads `colors`/`base` directly from
// this store, since a <canvas> can't resolve a CSS variable on its own.
// `applyThemeToDocument`, called from App.tsx, is the one place that pushes
// both onto :root so the two stay identical.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ThemeColors {
  accent: string
  // Deliberately separate from upCandle/downCandle (Part C1 audit risk #1):
  // "this trade/metric is good" and "this candle closed up" are different
  // questions -- collapsing them would mean a red-up-candle preset also
  // paints every win badge red.
  positive: string
  negative: string
  upCandle: string
  downCandle: string
}

// The shell's structural palette -- NOT part of the per-preset accent/candle
// model above; one set per `mode`, matching index.css's dark @theme block
// and its `[data-theme='light']` override exactly (kept in sync manually --
// see the comment there). Needed as plain JS strings (not just CSS
// variables) because klinecharts/lightweight-charts render to <canvas> and
// can't read a custom property themselves.
export interface ThemeBase {
  bg: string
  surface: string
  border: string
  text: string
  textMuted: string
  grid: string
  warning: string
}

const BASE_TOKENS: Record<ThemeMode, ThemeBase> = {
  dark: {
    bg: '#0d1117',
    surface: '#161b22',
    border: '#30363d',
    text: '#c9d1d9',
    textMuted: '#8b949e',
    grid: '#21262d',
    warning: '#d29922',
  },
  light: {
    bg: '#f6f8fa',
    surface: '#ffffff',
    border: '#d0d7de',
    text: '#1f2328',
    textMuted: '#59636e',
    grid: '#eaeef2',
    warning: '#9a6700',
  },
}

// Fixed CATEGORICAL identity colors (Part C1 audit risk #3): "which session
// is this" / "which run is this" is not a positive/negative/accent
// question, so these stay outside the tunable model entirely -- same
// values regardless of preset or mode. Centralized here (not inlined in
// sessionOverlay.ts/indicators.ts/ComparePage.tsx) so there's exactly one
// place a session's or a chart line's identity color is defined, mirrored
// into index.css's @theme only for a DOM consumer (e.g. a legend swatch)
// that might want the Tailwind-class form.
export const SESSION_COLORS = {
  asia: '#a371f7',
  london: '#58a6ff',
  ny: '#3fb950',
  news: '#d29922',
} as const

export const CHART_LINE_COLORS = {
  // VWAP intentionally reuses the live accent (a key reference line, same
  // "primary" role as the accent elsewhere) rather than a fixed hue.
  ema20: '#79c0ff',
  ema50: '#d2a8ff',
} as const

export const COMPARE_B_COLOR = '#e3b341'

// The fixed foreground every "active/selected" button app-wide pairs with
// bg-accent (`bg-accent text-white`, ChartPanel/SettingsPanel/etc) --
// named and centralized here (not a literal at the Theme Editor's contrast-
// check call site) for the same single-source-of-truth reason as the
// categorical colors above, and so it stays in the one file this repo's
// designTokens.test.ts allowlists for literal color values.
export const ACCENT_BUTTON_TEXT_COLOR = '#ffffff'

export type ThemeMode = 'dark' | 'light'

export interface ThemePreset {
  id: string
  name: string
  // A preset picks its base wholesale (Part C2: "presets should set both
  // the data-theme base and the tunable semantic colors together") rather
  // than mixing-and-matching individual base tokens -- C1's own design
  // decision stands: presets vary identity colors and mode, not the shell's
  // structural palette (see BASE_TOKENS above, which stays exactly 2 sets).
  mode: ThemeMode
  colors: ThemeColors
}

// Curated set (REDESIGN_APPROACH.md Part C2's own example names). Three
// dark, one light -- High Contrast is deliberately the light one, so
// picking a preset is also the concrete, reachable way to see light mode
// (the toggle alone would otherwise be inert for anyone who never tries
// it). positive/negative default to the same values as upCandle/downCandle
// per preset -- independently tunable from the pickers, not different out
// of the box. Every preset's colors are chosen to already clear the
// contrast guardrail against its own mode's surface/bg (see
// contrast.test.ts's thresholds) -- a curated preset should never itself
// trigger the warning it exists partly to demonstrate.
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    colors: { accent: '#58a6ff', positive: '#3fb950', negative: '#f85149', upCandle: '#3fb950', downCandle: '#f85149' },
  },
  {
    id: 'slate',
    name: 'Slate',
    mode: 'dark',
    colors: { accent: '#8b9bb4', positive: '#56d364', negative: '#ff7b72', upCandle: '#56d364', downCandle: '#ff7b72' },
  },
  {
    id: 'paper-dark',
    name: 'Paper Dark',
    mode: 'dark',
    colors: { accent: '#d29922', positive: '#3fb950', negative: '#f85149', upCandle: '#3fb950', downCandle: '#f85149' },
  },
  // GitHub's own light-mode accessible palette (#0969da/#1a7f37/#cf222e are
  // its documented AA-on-white link/success/danger colors) -- the obvious
  // source for "high contrast" since it's already built and verified for
  // exactly this purpose, not reinvented here.
  {
    id: 'high-contrast',
    name: 'High Contrast',
    mode: 'light',
    colors: { accent: '#0969da', positive: '#1a7f37', negative: '#cf222e', upCandle: '#1a7f37', downCandle: '#cf222e' },
  },
]

const DEFAULT_PRESET = THEME_PRESETS[0]

// Which preset (if any) the current colors+mode exactly match -- 'custom'
// once the user tweaks a single picker (or the mode toggle) away from a
// preset's own combination.
export function matchingPresetId(colors: ThemeColors, mode: ThemeMode): string {
  const match = THEME_PRESETS.find(
    (p) =>
      p.mode === mode &&
      p.colors.accent === colors.accent &&
      p.colors.positive === colors.positive &&
      p.colors.negative === colors.negative &&
      p.colors.upCandle === colors.upCandle &&
      p.colors.downCandle === colors.downCandle,
  )
  return match?.id ?? 'custom'
}

interface ThemeState {
  colors: ThemeColors
  mode: ThemeMode
  applyPreset: (id: string) => void
  setAccent: (hex: string) => void
  setPositive: (hex: string) => void
  setNegative: (hex: string) => void
  setUpCandle: (hex: string) => void
  setDownCandle: (hex: string) => void
  setMode: (mode: ThemeMode) => void
  reset: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      colors: DEFAULT_PRESET.colors,
      mode: DEFAULT_PRESET.mode,
      applyPreset: (id) => {
        const preset = THEME_PRESETS.find((p) => p.id === id)
        if (preset) set({ colors: preset.colors, mode: preset.mode })
      },
      setAccent: (hex) => set((s) => ({ colors: { ...s.colors, accent: hex } })),
      setPositive: (hex) => set((s) => ({ colors: { ...s.colors, positive: hex } })),
      setNegative: (hex) => set((s) => ({ colors: { ...s.colors, negative: hex } })),
      setUpCandle: (hex) => set((s) => ({ colors: { ...s.colors, upCandle: hex } })),
      setDownCandle: (hex) => set((s) => ({ colors: { ...s.colors, downCandle: hex } })),
      setMode: (mode) => set({ mode }),
      reset: () => set({ colors: DEFAULT_PRESET.colors, mode: DEFAULT_PRESET.mode }),
    }),
    { name: 'propbt-viz:theme' },
  ),
)

// Import/export (REDESIGN_APPROACH.md Part C2: "import/export a theme as
// JSON"). Plain functions, not store actions, so the ThemeEditor component
// can call exportTheme() to build a downloadable Blob and importTheme() on
// a FileReader result without needing React context -- same "pure
// function alongside the store" pattern as matchingPresetId/resolveBase.
const THEME_FILE_VERSION = 1

export function exportTheme(colors: ThemeColors, mode: ThemeMode): string {
  return JSON.stringify({ version: THEME_FILE_VERSION, mode, colors }, null, 2)
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

// Returns the parsed {colors, mode} on success, or an error string on any
// shape/value problem -- never throws, so the caller (a file-picker
// handler) can show the message directly without its own try/catch.
export function importTheme(json: string): { colors: ThemeColors; mode: ThemeMode } | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return 'Not valid JSON.'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'Expected a JSON object.'
  const obj = parsed as Record<string, unknown>
  if (obj.mode !== 'dark' && obj.mode !== 'light') return `"mode" must be "dark" or "light".`
  const c = obj.colors
  if (typeof c !== 'object' || c === null) return 'Missing "colors" object.'
  const colorsObj = c as Record<string, unknown>
  const keys: (keyof ThemeColors)[] = ['accent', 'positive', 'negative', 'upCandle', 'downCandle']
  for (const key of keys) {
    const v = colorsObj[key]
    if (typeof v !== 'string' || !HEX_RE.test(v)) return `"colors.${key}" must be a 6-digit hex color like "#58a6ff".`
  }
  return {
    mode: obj.mode,
    colors: {
      accent: colorsObj.accent as string,
      positive: colorsObj.positive as string,
      negative: colorsObj.negative as string,
      upCandle: colorsObj.upCandle as string,
      downCandle: colorsObj.downCandle as string,
    },
  }
}

// Resolves the current mode's base tokens -- a plain function (not a hook)
// since callers that already subscribe to `mode` (or don't need to react to
// it) can call this directly; components needing live updates should
// select `mode` themselves and pass it here, or use useThemeBase() below.
export function resolveBase(mode: ThemeMode): ThemeBase {
  return BASE_TOKENS[mode]
}

export function useThemeBase(): ThemeBase {
  return useThemeStore((s) => resolveBase(s.mode))
}

// Pushes the live theme onto :root as CSS custom properties. Every Tailwind
// utility already built from these --color-* tokens (bg-accent,
// text-positive, the dockview/cmdk CSS in index.css) picks this up
// automatically since Tailwind v4's @theme tokens ARE those same runtime
// custom properties, not build-time-only constants. accent-color is a real
// (inherited) CSS property, not a custom one -- setting it on the root
// cascades to every native checkbox/radio/range input in the app. `mode` is
// pushed as a `data-theme` attribute (not a CSS variable) since it selects
// which *block* of variables applies (index.css's `[data-theme='light']`),
// not a single value.
export function applyThemeToDocument(colors: ThemeColors, mode: ThemeMode): void {
  const root = document.documentElement
  root.setAttribute('data-theme', mode)
  const style = root.style
  style.setProperty('--color-accent', colors.accent)
  style.setProperty('--color-positive', colors.positive)
  style.setProperty('--color-negative', colors.negative)
  style.setProperty('--color-up-candle', colors.upCandle)
  style.setProperty('--color-down-candle', colors.downCandle)
  style.setProperty('accent-color', colors.accent)
}
