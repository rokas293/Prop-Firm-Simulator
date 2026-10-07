import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SCALPER, fromScalperConfig, normalizeScalper, toScalperConfig } from '../chart/scalper'
import { LEGACY_SCALPER_KEY, dropLegacyScalper, readLegacyScalper, readScalper, useScalperStore } from './scalperStore'

const state = () => useScalperStore.getState()

beforeEach(() => {
  useScalperStore.setState({ bySession: {} })
})

describe('Scalper settings are remembered per session', () => {
  it('a session never configured reads the defaults, disarmed', () => {
    expect(readScalper(state().bySession, 'a')).toEqual({ armed: false, settings: DEFAULT_SCALPER })
    expect(readScalper(state().bySession, null)).toEqual({ armed: false, settings: DEFAULT_SCALPER })
  })

  it('edits and arming for one session do not touch another', () => {
    state().patch('a', { slValue: 25, slUnit: 'percent' })
    state().setArmed('a', true)
    expect(readScalper(state().bySession, 'a')).toMatchObject({ armed: true, settings: { slValue: 25, slUnit: 'percent' } })
    expect(readScalper(state().bySession, 'b')).toEqual({ armed: false, settings: DEFAULT_SCALPER })
  })

  it('arming keeps the settings, and editing keeps the armed state', () => {
    state().patch('a', { tpValue: 3 })
    state().setArmed('a', true)
    state().patch('a', { beOn: true, beValue: 2 })
    expect(readScalper(state().bySession, 'a')).toMatchObject({ armed: true, settings: { tpValue: 3, beOn: true, beValue: 2 } })
    state().setArmed('a', false)
    expect(readScalper(state().bySession, 'a').settings.tpValue).toBe(3)
  })

  it('edits go through the same rules as everywhere (no break-even without a stop)', () => {
    state().patch('a', { slOn: false })
    state().patch('a', { beOn: true })
    expect(readScalper(state().bySession, 'a').settings).toMatchObject({ slOn: false, beOn: false })
  })

  it('a shape read back from storage is made coherent', () => {
    useScalperStore.setState({
      bySession: { a: { armed: true, settings: { ...DEFAULT_SCALPER, slOn: false, beOn: true, tpUnit: 'r', slValue: -1 } } },
    })
    expect(readScalper(state().bySession, 'a').settings).toMatchObject({ beOn: false, tpUnit: 'r', slValue: DEFAULT_SCALPER.slValue })
  })
})


describe('seeding from the session file', () => {
  it('seed loads a saved state without it being an edit, and re-normalizes it', () => {
    state().seed('a', { armed: true, settings: { ...DEFAULT_SCALPER, slOn: false, beOn: true } })
    expect(readScalper(state().bySession, 'a')).toMatchObject({ armed: true, settings: { slOn: false, beOn: false } })
  })
})

describe('the wire form saved in the session file', () => {
  it('round-trips every setting and the armed state', () => {
    const settings = normalizeScalper({ slOn: true, slValue: 60, slUnit: 'percent', tpOn: true, tpValue: 1.5, tpUnit: 'ticks', beOn: true, beMode: 'ticks', beValue: 8 })
    const wire = toScalperConfig(true, settings)
    expect(wire).toEqual({
      armed: true, sl_on: true, sl_value: 60, sl_unit: 'percent', tp_on: true, tp_value: 1.5, tp_unit: 'ticks',
      be_on: true, be_mode: 'ticks', be_value: 8,
    })
    expect(fromScalperConfig(wire)).toEqual({ armed: true, settings })
  })

  it('an impossible saved combination is made coherent on the way in (break-even needs a stop)', () => {
    const wire = { ...toScalperConfig(false, DEFAULT_SCALPER), sl_on: false, be_on: true }
    expect(fromScalperConfig(wire).settings.beOn).toBe(false)
  })
})

describe('migrating what the first G4 kept in browser storage', () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = { ...initial }
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => void (data[k] = v),
      removeItem: (k: string) => void delete data[k],
    }
  }
  const legacy = (bySession: object) => JSON.stringify({ state: { bySession }, version: 0 })
  const entry = { armed: true, settings: { ...DEFAULT_SCALPER, slValue: 25, slUnit: 'percent' } }

  it('reads the old entry for this session, normalized, and nothing when there is none', () => {
    const storage = fakeStorage({ [LEGACY_SCALPER_KEY]: legacy({ a: entry }) })
    expect(readLegacyScalper('a', storage)).toMatchObject({ armed: true, settings: { slValue: 25, slUnit: 'percent' } })
    expect(readLegacyScalper('b', storage)).toBeNull()
    expect(readLegacyScalper('a', fakeStorage())).toBeNull()
  })

  it('reading does not remove it (a failed save must lose nothing); dropping removes only that session', () => {
    const storage = fakeStorage({ [LEGACY_SCALPER_KEY]: legacy({ a: entry, b: entry }) })
    readLegacyScalper('a', storage)
    expect(readLegacyScalper('a', storage)).not.toBeNull()
    dropLegacyScalper('a', storage)
    expect(readLegacyScalper('a', storage)).toBeNull()
    expect(readLegacyScalper('b', storage)).not.toBeNull()
    dropLegacyScalper('b', storage)
    expect(storage.data[LEGACY_SCALPER_KEY]).toBeUndefined()
  })

  it('survives corrupt or missing storage', () => {
    expect(readLegacyScalper('a', fakeStorage({ [LEGACY_SCALPER_KEY]: '{not json' }))).toBeNull()
    expect(() => dropLegacyScalper('a', fakeStorage({ [LEGACY_SCALPER_KEY]: '{not json' }))).not.toThrow()
  })
})
