import { describe, expect, it } from 'vitest'
import { buildQuery } from './client'

describe('buildQuery', () => {
  it('returns an empty string for undefined params', () => {
    expect(buildQuery(undefined)).toBe('')
  })

  it('returns an empty string for an empty params object', () => {
    expect(buildQuery({})).toBe('')
  })

  it('builds a leading-? query string from simple params', () => {
    expect(buildQuery({ scope: 'oos' })).toBe('?scope=oos')
  })

  it('joins multiple params with &', () => {
    const result = buildQuery({ from: 100, to: 200 })
    expect(result).toBe('?from=100&to=200')
  })

  it('omits keys whose value is undefined, keeping the rest', () => {
    const result = buildQuery({ leg: 'continuation', session: undefined, side: 'long' })
    expect(result).toBe('?leg=continuation&side=long')
  })

  it('returns an empty string when every value is undefined', () => {
    expect(buildQuery({ leg: undefined, session: undefined })).toBe('')
  })

  it('URL-encodes both keys and values', () => {
    const result = buildQuery({ 'weird key': 'a value/with?special&chars' })
    expect(result).toBe('?weird%20key=a%20value%2Fwith%3Fspecial%26chars')
  })

  it('stringifies numeric values', () => {
    expect(buildQuery({ max_points: 5000 })).toBe('?max_points=5000')
  })
})
