import { describe, expect, it } from 'vitest'
import { positionCapMessage } from './positionCap'

describe('positionCapMessage', () => {
  it('allows anything up to and including the cap', () => {
    expect(positionCapMessage(5, 5, 'Order')).toBeNull()
    expect(positionCapMessage(1, 5, 'Order')).toBeNull()
  })

  it('rejects the first contract over the cap with a message naming the size and the limit', () => {
    const msg = positionCapMessage(6, 5, 'Market order')
    expect(msg).toContain('Market order of 6 contracts')
    expect(msg).toContain('5-contract Topstep position limit')
  })

  it('never caps an account with no limit (practice session, or a missing field)', () => {
    expect(positionCapMessage(50, null, 'Order')).toBeNull()
    expect(positionCapMessage(50, undefined, 'Order')).toBeNull()
  })
})
