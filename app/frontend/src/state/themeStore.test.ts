import { beforeEach, describe, expect, it } from 'vitest'
import { THEME_PRESETS, matchingPresetId, resolveBase, useThemeStore } from './themeStore'

beforeEach(() => {
  useThemeStore.setState({ colors: THEME_PRESETS[0].colors, mode: 'dark' })
})

describe('matchingPresetId', () => {
  it('identifies an exact preset match', () => {
    expect(matchingPresetId(THEME_PRESETS[1].colors)).toBe(THEME_PRESETS[1].id)
  })

  it('returns "custom" for a color combination that matches no preset', () => {
    expect(
      matchingPresetId({ accent: '#123456', positive: '#3fb950', negative: '#f85149', upCandle: '#3fb950', downCandle: '#f85149' }),
    ).toBe('custom')
  })
})

describe('useThemeStore', () => {
  it('starts on the Ocean (default) preset colors', () => {
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS[0].colors)
  })

  it('applyPreset switches all five colors at once', () => {
    useThemeStore.getState().applyPreset('violet')
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS.find((p) => p.id === 'violet')!.colors)
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

  it('reset restores the default preset and dark mode', () => {
    useThemeStore.getState().setAccent('#ff00ff')
    useThemeStore.getState().setMode('light')
    useThemeStore.getState().reset()
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS[0].colors)
    expect(useThemeStore.getState().mode).toBe('dark')
  })

  it('setMode switches the base-token mode', () => {
    useThemeStore.getState().setMode('light')
    expect(useThemeStore.getState().mode).toBe('light')
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
