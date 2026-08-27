import { beforeEach, describe, expect, it } from 'vitest'
import { useLayoutStore } from './layoutStore'

beforeEach(() => {
  localStorage.clear()
  useLayoutStore.setState({ lastLayout: null })
})

describe('useLayoutStore', () => {
  it('starts with no saved layout', () => {
    expect(useLayoutStore.getState().lastLayout).toBeNull()
  })

  it('setLastLayout stores the given data with a timestamp', () => {
    const fakeSerializedLayout = { grid: { root: { type: 'leaf' }, width: 100, height: 100 } }
    useLayoutStore.getState().setLastLayout(fakeSerializedLayout)

    const stored = useLayoutStore.getState().lastLayout
    expect(stored).not.toBeNull()
    expect(stored?.data).toEqual(fakeSerializedLayout)
    expect(typeof stored?.savedAt).toBe('string')
    expect(() => new Date(stored!.savedAt).toISOString()).not.toThrow()
  })

  it('clearLastLayout resets back to null', () => {
    useLayoutStore.getState().setLastLayout({ some: 'layout' })
    expect(useLayoutStore.getState().lastLayout).not.toBeNull()

    useLayoutStore.getState().clearLastLayout()
    expect(useLayoutStore.getState().lastLayout).toBeNull()
  })

  it('persists to localStorage under its own key and survives a fresh store instance reading it back', () => {
    const layout = { grid: { root: { type: 'leaf', data: { views: ['chart', 'trade-list'] } } } }
    useLayoutStore.getState().setLastLayout(layout)

    const raw = localStorage.getItem('propbt-viz:workspace-layout')
    expect(raw).not.toBeNull()

    const parsed = JSON.parse(raw!)
    expect(parsed.state.lastLayout.data).toEqual(layout)
  })

  it('overwriting with a new layout replaces the old one, not merges it', () => {
    useLayoutStore.getState().setLastLayout({ panels: ['chart'] })
    useLayoutStore.getState().setLastLayout({ panels: ['dashboard'] })

    expect(useLayoutStore.getState().lastLayout?.data).toEqual({ panels: ['dashboard'] })
  })
})
