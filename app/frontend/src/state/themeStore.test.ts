import { beforeEach, describe, expect, it } from 'vitest'
import { MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, passesContrast } from './contrast'
import { THEME_PRESETS, exportTheme, importTheme, matchingPresetId, resolveBase, useThemeStore } from './themeStore'

beforeEach(() => {
  useThemeStore.setState({ colors: THEME_PRESETS[0].colors, mode: THEME_PRESETS[0].mode, baseOverride: { bg: null, surface: null } })
})

describe('matchingPresetId', () => {
  it('identifies an exact preset match', () => {
    expect(matchingPresetId(THEME_PRESETS[1].colors, THEME_PRESETS[1].mode)).toBe(THEME_PRESETS[1].id)
  })

  it('returns "custom" for a color combination that matches no preset', () => {
    expect(
      matchingPresetId(
        { accent: '#123456', positive: '#3fb950', negative: '#f85149', upCandle: '#3fb950', downCandle: '#f85149' },
        'dark',
      ),
    ).toBe('custom')
  })

  it('returns "custom" when colors match a preset but the mode does not', () => {
    // High Contrast's own colors, but forced into dark mode -- not the same
    // theme as the actual (light) High Contrast preset.
    const hc = THEME_PRESETS.find((p) => p.id === 'high-contrast')!
    expect(matchingPresetId(hc.colors, 'dark')).toBe('custom')
  })
})

describe('useThemeStore', () => {
  it('starts on the default preset colors and mode', () => {
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS[0].colors)
    expect(useThemeStore.getState().mode).toBe(THEME_PRESETS[0].mode)
  })

  it('applyPreset switches all five colors AND the mode together', () => {
    useThemeStore.getState().applyPreset('high-contrast')
    const preset = THEME_PRESETS.find((p) => p.id === 'high-contrast')!
    expect(useThemeStore.getState().colors).toEqual(preset.colors)
    expect(useThemeStore.getState().mode).toBe('light')
  })

  it('applyPreset with an unknown id is a no-op', () => {
    const before = useThemeStore.getState().colors
    useThemeStore.getState().applyPreset('does-not-exist')
    expect(useThemeStore.getState().colors).toEqual(before)
  })

  it('setAccent/setPositive/setNegative/setUpCandle/setDownCandle patch one color independently', () => {
    useThemeStore.getState().setAccent('#ff00ff')
    expect(useThemeStore.getState().colors.accent).toBe('#ff00ff')
    expect(useThemeStore.getState().colors.positive).toBe(THEME_PRESETS[0].colors.positive)

    useThemeStore.getState().setPositive('#00ff00')
    useThemeStore.getState().setNegative('#ff0000')
    useThemeStore.getState().setUpCandle('#00ffff')
    useThemeStore.getState().setDownCandle('#ffff00')
    expect(useThemeStore.getState().colors).toEqual({
      accent: '#ff00ff',
      positive: '#00ff00',
      negative: '#ff0000',
      upCandle: '#00ffff',
      downCandle: '#ffff00',
    })
  })

  it('reset restores the default preset and mode', () => {
    useThemeStore.getState().setAccent('#ff00ff')
    useThemeStore.getState().setMode('light')
    useThemeStore.getState().reset()
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS[0].colors)
    expect(useThemeStore.getState().mode).toBe(THEME_PRESETS[0].mode)
  })

  it('setMode switches the base-token mode', () => {
    useThemeStore.getState().setMode('light')
    expect(useThemeStore.getState().mode).toBe('light')
  })
})

describe('curated presets', () => {
  it('every preset already clears the contrast guardrail against its own base -- a curated preset should never trigger its own warning', () => {
    for (const preset of THEME_PRESETS) {
      const base = resolveBase(preset.mode)
      for (const key of ['accent', 'positive', 'negative'] as const) {
        expect(
          passesContrast(preset.colors[key], base.surface, MIN_TEXT_CONTRAST),
          `${preset.name}.${key} vs ${preset.mode} surface`,
        ).toBe(true)
      }
      for (const key of ['upCandle', 'downCandle'] as const) {
        expect(
          passesContrast(preset.colors[key], base.bg, MIN_UI_CONTRAST),
          `${preset.name}.${key} vs ${preset.mode} bg`,
        ).toBe(true)
      }
    }
  })
})

describe('resolveBase', () => {
  it('returns distinct dark and light base token sets', () => {
    const dark = resolveBase('dark')
    const light = resolveBase('light')
    expect(dark.bg).not.toBe(light.bg)
    expect(dark.text).not.toBe(light.text)
  })
})

describe('exportTheme / importTheme', () => {
  const colors = THEME_PRESETS[2].colors
  const mode = THEME_PRESETS[2].mode

  it('round-trips colors and mode through JSON, with no override by default', () => {
    const json = exportTheme(colors, mode)
    const result = importTheme(json)
    expect(result).toEqual({ colors, mode, baseOverride: { bg: null, surface: null } })
  })

  it('round-trips a background/surface override through JSON', () => {
    const json = exportTheme(colors, mode, { bg: '#010203', surface: null })
    const result = importTheme(json)
    expect(result).toEqual({ colors, mode, baseOverride: { bg: '#010203', surface: null } })
  })

  it('defaults baseOverride to {bg: null, surface: null} when the field is absent (pre-v2 export)', () => {
    const json = JSON.stringify({ version: 1, mode, colors })
    expect(importTheme(json)).toEqual({ colors, mode, baseOverride: { bg: null, surface: null } })
  })

  it('rejects invalid JSON', () => {
    expect(importTheme('{not json')).toBe('Not valid JSON.')
  })

  it('rejects a non-object payload', () => {
    expect(importTheme('42')).toBe('Expected a JSON object.')
  })

  it('rejects a missing or invalid mode', () => {
    expect(importTheme(JSON.stringify({ mode: 'sepia', colors }))).toMatch(/"mode"/)
  })

  it('rejects a missing colors object', () => {
    expect(importTheme(JSON.stringify({ mode: 'dark' }))).toBe('Missing "colors" object.')
  })

  it('rejects a non-hex color value', () => {
    const bad = { ...colors, accent: 'blue' }
    expect(importTheme(JSON.stringify({ mode: 'dark', colors: bad }))).toMatch(/"colors\.accent"/)
  })

  it('rejects a color missing the # prefix or wrong length', () => {
    const bad = { ...colors, negative: '58a6ff' }
    expect(importTheme(JSON.stringify({ mode: 'dark', colors: bad }))).toMatch(/"colors\.negative"/)
  })

  it('rejects a non-hex, non-null baseOverride value', () => {
    const json = JSON.stringify({ mode: 'dark', colors, baseOverride: { bg: 'blue', surface: null } })
    expect(importTheme(json)).toMatch(/"baseOverride\.bg"/)
  })

  it('rejects a non-object baseOverride', () => {
    const json = JSON.stringify({ mode: 'dark', colors, baseOverride: 'nope' })
    expect(importTheme(json)).toBe('"baseOverride" must be an object.')
  })
})

describe('baseOverride', () => {
  it('resolveBase returns the mode default when no override is set', () => {
    expect(resolveBase('dark', { bg: null, surface: null })).toEqual(resolveBase('dark'))
  })

  it('resolveBase applies bg/surface overrides on top of the mode default, leaving other base tokens untouched', () => {
    const dark = resolveBase('dark')
    const overridden = resolveBase('dark', { bg: '#010203', surface: '#040506' })
    expect(overridden.bg).toBe('#010203')
    expect(overridden.surface).toBe('#040506')
    expect(overridden.text).toBe(dark.text)
    expect(overridden.border).toBe(dark.border)
  })

  it('setBgOverride/setSurfaceOverride patch the store independently, and null reverts to the mode default', () => {
    useThemeStore.getState().setBgOverride('#111111')
    expect(useThemeStore.getState().baseOverride).toEqual({ bg: '#111111', surface: null })
    useThemeStore.getState().setSurfaceOverride('#222222')
    expect(useThemeStore.getState().baseOverride).toEqual({ bg: '#111111', surface: '#222222' })
    useThemeStore.getState().setBgOverride(null)
    expect(useThemeStore.getState().baseOverride).toEqual({ bg: null, surface: '#222222' })
  })

  it('reset clears any active override back to {bg: null, surface: null}', () => {
    useThemeStore.getState().setBgOverride('#111111')
    useThemeStore.getState().reset()
    expect(useThemeStore.getState().baseOverride).toEqual({ bg: null, surface: null })
  })

  it('matchingPresetId returns "custom" once a background/surface override is active, even if colors+mode still match a preset exactly', () => {
    const preset = THEME_PRESETS[0]
    expect(matchingPresetId(preset.colors, preset.mode, { bg: '#010203', surface: null })).toBe('custom')
    expect(matchingPresetId(preset.colors, preset.mode, { bg: null, surface: null })).toBe(preset.id)
  })
})
