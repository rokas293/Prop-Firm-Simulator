import { beforeEach, describe, expect, it } from 'vitest'
import { usePerfStore } from './perfStore'

beforeEach(() => {
  usePerfStore.setState({ enabled: false, fetchSamples: [], renderSamples: [] })
})

describe('perfStore', () => {
  it('starts disabled with empty sample buffers', () => {
    const s = usePerfStore.getState()
    expect(s.enabled).toBe(false)
    expect(s.fetchSamples).toEqual([])
    expect(s.renderSamples).toEqual([])
  })

  it('toggle flips enabled', () => {
    usePerfStore.getState().toggle()
    expect(usePerfStore.getState().enabled).toBe(true)
    usePerfStore.getState().toggle()
    expect(usePerfStore.getState().enabled).toBe(false)
  })

  it('recordFetch/recordRender are no-ops while disabled', () => {
    usePerfStore.getState().recordFetch('/bars', 12)
    usePerfStore.getState().recordRender('Chart', 'mount', 5)
    expect(usePerfStore.getState().fetchSamples).toEqual([])
    expect(usePerfStore.getState().renderSamples).toEqual([])
  })

  it('records once enabled', () => {
    usePerfStore.getState().toggle()
    usePerfStore.getState().recordFetch('/trades', 42)
    usePerfStore.getState().recordRender('Trade List', 'update', 8)
    expect(usePerfStore.getState().fetchSamples).toMatchObject([{ path: '/trades', ms: 42 }])
    expect(usePerfStore.getState().renderSamples).toMatchObject([{ id: 'Trade List', phase: 'update', ms: 8 }])
  })

  it('caps the ring buffer at 40 samples, dropping the oldest', () => {
    usePerfStore.getState().toggle()
    for (let i = 0; i < 45; i++) usePerfStore.getState().recordFetch(`/p${i}`, i)
    const samples = usePerfStore.getState().fetchSamples
    expect(samples).toHaveLength(40)
    expect(samples[0].path).toBe('/p5') // the first 5 were pushed out
    expect(samples[samples.length - 1].path).toBe('/p44')
  })
})
