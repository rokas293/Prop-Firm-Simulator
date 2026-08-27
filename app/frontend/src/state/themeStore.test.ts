import { beforeEach, describe, expect, it } from 'vitest'
import { THEME_PRESETS, matchingPresetId, useThemeStore } from './themeStore'

beforeEach(() => {
  useThemeStore.setState({ colors: THEME_PRESETS[0].colors })
})

describe('matchingPresetId', () => {
  it('identifies an exact preset match', () => {
    expect(matchingPresetId(THEME_PRESETS[1].colors)).toBe(THEME_PRESETS[1].id)
  })

  it('returns "custom" for a color combination that matches no preset', () => {
    expect(matchingPresetId({ accent: '#123456', up: '#3fb950', down: '#f85149' })).toBe('custom')
  })
})

describe('useThemeStore', () => {
  it('starts on the Ocean (default) preset colors', () => {
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS[0].colors)
  })

  it('applyPreset switches all three colors at once', () => {
    useThemeStore.getState().applyPreset('violet')
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS.find((p) => p.id === 'violet')!.colors)
  })

  it('applyPreset with an unknown id is a no-op', () => {
    const before = useThemeStore.getState().colors
    useThemeStore.getState().applyPreset('does-not-exist')
    expect(useThemeStore.getState().colors).toEqual(before)
  })

  it('setAccent/setUp/setDown patch one color independently', () => {
    useThemeStore.getState().setAccent('#ff00ff')
    expect(useThemeStore.getState().colors.accent).toBe('#ff00ff')
    expect(useThemeStore.getState().colors.up).toBe(THEME_PRESETS[0].colors.up)

    useThemeStore.getState().setUp('#00ff00')
    useThemeStore.getState().setDown('#ff0000')
    expect(useThemeStore.getState().colors).toEqual({ accent: '#ff00ff', up: '#00ff00', down: '#ff0000' })
  })

  it('reset restores the default preset', () => {
    useThemeStore.getState().setAccent('#ff00ff')
    useThemeStore.getState().reset()
    expect(useThemeStore.getState().colors).toEqual(THEME_PRESETS[0].colors)
  })
})
