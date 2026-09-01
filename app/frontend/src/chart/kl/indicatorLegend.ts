// On-chart per-indicator legend controls (REPLICA_ROADMAP.md Batch 3).
// klinecharts already renders a native, always-on legend row per active
// indicator (name + live values -- confirmed against the v10.0.3 source:
// IndicatorTooltipView, showRule defaults to 'always') -- this file only
// supplies the interactive part TradingView-style tools add on top: a
// small cluster of canvas-drawn icon buttons at the end of that SAME row,
// via klinecharts' own `tooltip.features` mechanism (SVG-path figures with
// built-in hover/active-color state), not a separate DOM overlay.
//
// Every path below is hand-authored directly in a 14x14 box (matching the
// feature `size` used everywhere here) rather than borrowed/rescaled from
// an icon set -- klinecharts' path parser (confirmed against the source)
// supports the full SVG path grammar (M/L/H/V/C/S/Q/T/A/Z, absolute and
// relative), so any real icon source would work too, but these are simple
// enough to author directly at the exact size they render.
import type { TooltipFeatureStyle } from 'klinecharts'
import type { IndicatorPrefs } from '../../state/indicatorStore'

export const FEATURE_SIZE = 14

export const EYE_PATH = 'M2 7Q7 2 12 7Q7 12 2 7Z'
export const EYE_OFF_PATH = 'M2 7Q7 2 12 7Q7 12 2 7Z M2 11L12 3'
export const REMOVE_PATH = 'M4 4L10 10M10 4L4 10'
// A "sliders" glyph (two tracks + offset ticks) rather than a literal gear
// -- easier to author correctly with only straight lines, and reads as
// "settings/adjust" just as clearly at 14px (DESIGN_LANGUAGE.md §7: simple,
// monochrome, consistent stroke).
export const SETTINGS_PATH = 'M2 4H12M5 2V6M2 10H12M9 8V12'
export const CHEVRON_UP_PATH = 'M3 9L7 4L11 9'
export const CHEVRON_DOWN_PATH = 'M3 5L7 10L11 5'

export type IndicatorFeatureId = 'ind-settings' | 'ind-eye' | 'ind-up' | 'ind-down' | 'ind-remove'

// klinecharts' internal indicator `name` -> our IndicatorPrefs key. 'VOL'
// is the one plain built-in (Phase A3); the other four are the backend
// pass-through custom indicators registered in indicators.ts.
export const INDICATOR_KEY_BY_NAME: Record<string, keyof IndicatorPrefs> = {
  VOL: 'volume',
  klVwap: 'vwap',
  klEma20: 'ema20',
  klEma50: 'ema50',
  klAtr14: 'atr14',
}

function pathFeature(
  id: IndicatorFeatureId,
  path: string,
  opts: { color: string; activeColor: string; hoverBg: string; marginLeft: number },
): TooltipFeatureStyle {
  return {
    id,
    position: 'right',
    type: 'path',
    content: { path, style: 'stroke', lineWidth: 1.3 },
    size: FEATURE_SIZE,
    color: opts.color,
    activeColor: opts.activeColor,
    backgroundColor: 'transparent',
    activeBackgroundColor: opts.hoverBg,
    borderRadius: 3,
    paddingLeft: 2,
    paddingTop: 2,
    paddingRight: 2,
    paddingBottom: 2,
    marginLeft: opts.marginLeft,
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
  }
}

// Built once per indicator, right after it's (re)created -- rebuildIndicatorsRef
// in ChartKL.tsx recreates every indicator on any prefs/data/theme change,
// so this always reflects the CURRENT hidden-state/reorder-eligibility
// rather than needing its own separate update path.
export function buildIndicatorFeatures(opts: {
  hidden: boolean
  showSettings: boolean
  reorder: 'up' | 'down' | 'both' | 'none'
  color: string
  activeColor: string
  hoverBg: string
}): TooltipFeatureStyle[] {
  const features: TooltipFeatureStyle[] = []
  const styleOpts = { color: opts.color, activeColor: opts.activeColor, hoverBg: opts.hoverBg }
  if (opts.reorder === 'up' || opts.reorder === 'both') {
    features.push(pathFeature('ind-up', CHEVRON_UP_PATH, { ...styleOpts, marginLeft: features.length > 0 ? 4 : 10 }))
  }
  if (opts.reorder === 'down' || opts.reorder === 'both') {
    features.push(pathFeature('ind-down', CHEVRON_DOWN_PATH, { ...styleOpts, marginLeft: features.length > 0 ? 4 : 10 }))
  }
  if (opts.showSettings) {
    features.push(pathFeature('ind-settings', SETTINGS_PATH, { ...styleOpts, marginLeft: features.length > 0 ? 4 : 10 }))
  }
  features.push(pathFeature('ind-eye', opts.hidden ? EYE_OFF_PATH : EYE_PATH, { ...styleOpts, marginLeft: features.length > 0 ? 4 : 10 }))
  features.push(pathFeature('ind-remove', REMOVE_PATH, { ...styleOpts, marginLeft: 4 }))
  return features
}
