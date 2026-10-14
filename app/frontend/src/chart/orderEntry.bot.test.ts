// G10: the Autopilot bot's lines on the chart are read-only: shown with the engine's own
// numbers, never closable or draggable from here.
import { describe, expect, it } from 'vitest'
import { getContractSpec } from './simBroker'
import { labelSegments } from './orderEntry'

const MNQ = getContractSpec('MNQ')

describe("the Autopilot bot's lines are read-only", () => {
  const base = { side: 'long' as const, entryPrice: 20000, contracts: 1, spec: MNQ, bot: true }

  it('the position line is tagged BOT and carries no close button', () => {
    const segs = labelSegments({ ...base, role: 'position', pnlUsd: 12.5 }, 20000)
    expect(segs.map((s) => s.text)).toEqual(['BOT LONG 1', '+$12.50'])
    expect(segs.some((s) => s.key === 'close' || s.key === 'grip')).toBe(false)
  })

  it('its stop and target show the readout and the size, with no grip and no x', () => {
    const sl = labelSegments({ ...base, role: 'sl' }, 19990)
    expect(sl.map((s) => s.key)).toEqual(['tag', 'body', 'qty'])
    expect(sl[0].text).toBe('BOT SL')
    expect(labelSegments({ ...base, role: 'tp' }, 20015)[0].text).toBe('BOT TP')
    expect(labelSegments({ ...base, role: 'tp' }, 20015).map((s) => s.key)).toEqual(['tag', 'body', 'qty'])
  })

  it('a manual line of the same role is unchanged', () => {
    const manual = labelSegments({ ...base, bot: undefined, role: 'position', pnlUsd: 12.5 }, 20000)
    expect(manual.map((s) => s.key)).toEqual(['tag', 'body', 'close'])
    const sl = labelSegments({ ...base, bot: undefined, role: 'sl' }, 19990)
    expect(sl.map((s) => s.key)).toEqual(['grip', 'tag', 'body', 'qty', 'close'])
  })
})
