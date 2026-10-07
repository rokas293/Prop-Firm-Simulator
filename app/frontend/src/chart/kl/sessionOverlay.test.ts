import { describe, expect, it, vi } from 'vitest'
import {
  FAIR_VALUE_GROUP,
  SESSION_BAND_GROUP,
  buildFairValueOverlay,
  buildSessionBandOverlay,
  ensureSessionBandOverlayRegistered,
  revealedSessionBands,
  sessionColor,
  type SessionBand,
} from './sessionOverlay'

const band: SessionBand = { start: 1000, end: 2000, session: 'asia', fairValue: 14750.25 }

describe('sessionColor', () => {
  it('gives each known session its own color and falls back for an unknown one', () => {
    expect(sessionColor('asia')).not.toBe(sessionColor('london'))
    expect(sessionColor('london')).not.toBe(sessionColor('ny'))
    expect(sessionColor('made-up')).toBeTruthy()
  })
})

describe('buildSessionBandOverlay', () => {
  it('converts start/end to ms and carries the session color as extendData', () => {
    const overlay = buildSessionBandOverlay(band)
    expect(overlay.groupId).toBe(SESSION_BAND_GROUP)
    expect(overlay.points).toEqual([
      { timestamp: 1_000_000, value: 0 },
      { timestamp: 2_000_000, value: 0 },
    ])
    expect(overlay.extendData).toBe(sessionColor('asia'))
  })
})

describe('buildFairValueOverlay', () => {
  it('builds a horizontalSegment with both points at the fair value price', () => {
    const overlay = buildFairValueOverlay(band)!
    expect(overlay.name).toBe('horizontalSegment')
    expect(overlay.groupId).toBe(FAIR_VALUE_GROUP)
    expect(overlay.points).toEqual([
      { timestamp: 1_000_000, value: 14750.25 },
      { timestamp: 2_000_000, value: 14750.25 },
    ])
  })

  it('returns null when the session has no fair value', () => {
    expect(buildFairValueOverlay({ ...band, fairValue: null })).toBeNull()
  })

  // klinecharts' built-in horizontalSegment uses the interactive `line`
  // figure, whose DEFAULT right-click behavior is to delete the overlay
  // outright unless onRightClick calls preventDefault -- without this, a
  // stray right-click on the fair-value line would silently delete it.
  it('suppresses klinecharts\' default right-click-deletes-the-overlay behavior', () => {
    const overlay = buildFairValueOverlay(band)!
    const preventDefault = vi.fn()
    overlay.onRightClick?.({ preventDefault } as never)
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})

describe('ensureSessionBandOverlayRegistered', () => {
  it('does not throw, including when called more than once (idempotent)', () => {
    expect(() => {
      ensureSessionBandOverlayRegistered()
      ensureSessionBandOverlayRegistered()
    }).not.toThrow()
  })
})

describe('revealedSessionBands (no look-ahead on the replay chart)', () => {
  const asia: SessionBand = { start: 100, end: 400, session: 'asia', fairValue: 20000, fairValueTime: 160 }
  const london: SessionBand = { start: 400, end: 700, session: 'london', fairValue: 20100, fairValueTime: 460 }
  const ny: SessionBand = { start: 700, end: 1000, session: 'ny', fairValue: 20200, fairValueTime: 760 }
  const all = [asia, london, ny]

  it('hides a session that has not started, with its fair value', () => {
    expect(revealedSessionBands(all, 50)).toEqual([])
    expect(revealedSessionBands(all, 399).map((b) => b.session)).toEqual(['asia'])
    expect(revealedSessionBands(all, 400).map((b) => b.session)).toEqual(['asia', 'london'])
  })

  it('shows a started session without its fair value until the cursor reaches the time it was determined', () => {
    expect(revealedSessionBands(all, 150)[0].fairValue).toBeNull()
    expect(revealedSessionBands(all, 160)[0].fairValue).toBe(20000)
    expect(revealedSessionBands(all, 450)[1].fairValue).toBeNull()
  })

  it('treats a fair value with no known time as unknown until the session ends', () => {
    const undated: SessionBand = { start: 100, end: 400, session: 'asia', fairValue: 1 }
    expect(revealedSessionBands([undated], 399)[0].fairValue).toBeNull()
    expect(revealedSessionBands([undated], 400)[0].fairValue).toBe(1)
  })

  it('leaves a session without a fair value alone and never invents one', () => {
    const none: SessionBand = { start: 100, end: 400, session: 'asia', fairValue: null }
    expect(revealedSessionBands([none], 200)).toEqual([none])
  })

  it('no input at any cursor ever exposes a fair value from the future (randomised)', () => {
    for (let cursor = 0; cursor < 1100; cursor += 7) {
      for (const b of revealedSessionBands(all, cursor)) {
        expect(b.start).toBeLessThanOrEqual(cursor)
        if (b.fairValue !== null) expect(b.fairValueTime!).toBeLessThanOrEqual(cursor)
      }
    }
  })
})
