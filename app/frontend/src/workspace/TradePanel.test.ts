import { describe, expect, it } from 'vitest'
import { HISTORY_PAGE_SIZE, historyPage } from './TradePanel'
import { clampPanelHeight, PANEL_MIN_HEIGHT } from '../state/sessionPrefsStore'

describe('historyPage', () => {
  const items = Array.from({ length: 23 }, (_, i) => i + 1)
  it('lists newest first and paginates', () => {
    const p0 = historyPage(items, 0)
    expect(p0.rows[0]).toBe(23)
    expect(p0.rows).toHaveLength(HISTORY_PAGE_SIZE)
    expect(p0.pages).toBe(3)
    expect(historyPage(items, 2).rows).toEqual([3, 2, 1])
  })
  it('clamps the page and always reports at least one page', () => {
    expect(historyPage(items, 99).page).toBe(2)
    expect(historyPage(items, -4).page).toBe(0)
    expect(historyPage([], 0)).toEqual({ rows: [], page: 0, pages: 1 })
  })
})

describe('clampPanelHeight', () => {
  it('stays between the minimum and 60% of the viewport', () => {
    expect(clampPanelHeight(10, 1000)).toBe(PANEL_MIN_HEIGHT)
    expect(clampPanelHeight(900, 1000)).toBe(600)
    expect(clampPanelHeight(240.4, 1000)).toBe(240)
  })
  it('never goes below the minimum on a tiny viewport', () => {
    expect(clampPanelHeight(500, 100)).toBe(PANEL_MIN_HEIGHT)
  })
})
