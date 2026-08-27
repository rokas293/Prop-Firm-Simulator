// Theme system (POLISH_ROADMAP Phase P6): a few curated dark themes plus a
// user-adjustable accent color and up/down candle colors, persisted. Every
// theme is dark -- this app has no light mode (VIZ_SPEC/Phase V7's
// color-scheme:dark decision stands) -- presets differ in accent hue and
// candle palette, not in the base surface grays every panel already uses.
// `colors` is the single source of truth: CSS-consuming UI reads it via the
// runtime-overridden --color-accent-* custom properties (see
// applyThemeToDocument, called from App.tsx), and canvas-consuming chart
// code (PriceChart.tsx and its primitives) reads it directly from this
// store, since a <canvas> can't resolve a CSS variable on its own.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ThemeColors {
  accent: string
  up: string
  down: string
}

export interface ThemePreset {
  id: string
  name: string
  colors: ThemeColors
}

// "Ocean" reproduces this app's original GitHub-dark-inspired palette
// (Phase P1 onward) exactly, so picking it is a true no-op for anyone who
// never opens Settings.
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'ocean', name: 'Ocean', colors: { accent: '#58a6ff', up: '#3fb950', down: '#f85149' } },
  { id: 'amber', name: 'Amber', colors: { accent: '#d29922', up: '#3fb950', down: '#f85149' } },
  { id: 'violet', name: 'Violet', colors: { accent: '#a371f7', up: '#56d364', down: '#ff7b72' } },
  // #6e7681 (not a near-white gray) so white button text stays legible on
  // bg-accent-blue -- see the accent sweep's "active" buttons throughout
  // the app, which all pair the accent background with white text.
  { id: 'mono', name: 'Mono', colors: { accent: '#6e7681', up: '#7ee787', down: '#ffa198' } },
]

const DEFAULT_PRESET = THEME_PRESETS[0]

// Which preset (if any) the current colors exactly match -- 'custom' once
// the user tweaks a single color picker away from a preset's own values.
export function matchingPresetId(colors: ThemeColors): string {
  const match = THEME_PRESETS.find(
    (p) => p.colors.accent === colors.accent && p.colors.up === colors.up && p.colors.down === colors.down,
  )
  return match?.id ?? 'custom'
}

interface ThemeState {
  colors: ThemeColors
  applyPreset: (id: string) => void
  setAccent: (hex: string) => void
  setUp: (hex: string) => void
  setDown: (hex: string) => void
  reset: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      colors: DEFAULT_PRESET.colors,
      applyPreset: (id) => {
        const preset = THEME_PRESETS.find((p) => p.id === id)
        if (preset) set({ colors: preset.colors })
      },
      setAccent: (hex) => set((s) => ({ colors: { ...s.colors, accent: hex } })),
      setUp: (hex) => set((s) => ({ colors: { ...s.colors, up: hex } })),
      setDown: (hex) => set((s) => ({ colors: { ...s.colors, down: hex } })),
      reset: () => set({ colors: DEFAULT_PRESET.colors }),
    }),
    { name: 'propbt-viz:theme' },
  ),
)

// Pushes the live theme onto :root as CSS custom properties. Every Tailwind
// utility already built from --color-accent-* (bg-accent-blue,
// text-accent-green, the dockview/cmdk CSS in index.css) picks this up
// automatically since Tailwind v4's @theme tokens ARE those same runtime
// custom properties, not build-time-only constants. accent-color is a real
// (inherited) CSS property, not a custom one -- setting it on the root
// cascades to every native checkbox/radio/range input in the app.
export function applyThemeToDocument(colors: ThemeColors): void {
  const root = document.documentElement.style
  root.setProperty('--color-accent-blue', colors.accent)
  root.setProperty('--color-accent-green', colors.up)
  root.setProperty('--color-accent-red', colors.down)
  root.setProperty('accent-color', colors.accent)
}
