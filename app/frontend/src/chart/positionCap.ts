// Topstep's position limit (propbt/config/prop_rules.yaml position_limit.max_open_contracts,
// surfaced on the session as account.max_contracts): a session created with
// Topstep rules can never hold more contracts than the cap.
//
// ONE NUMBER FOR THE ACCOUNT, counted across every instrument (FXR_V2_SPEC.md G7).
// That yaml's own comment: "Flat count across ALL instruments -- Topstep does NOT
// give micros a 10:1 discount. 5 MES, 5 MNQ, or 5 ZN (or any mix) all max this
// out" (docs/DATA_AND_RULES.md section 3). So 3 MNQ + 2 MES is 5 contracts: at
// the cap, and a sixth in either instrument is refused.
//
// The sim broker lives in the browser, so every order path (quick Buy/Sell,
// the Place Order dialog, right-click limit/stop) checks here BEFORE creating
// anything, a resting order is checked again when it would fill
// (simBroker.advanceSession), and the backend re-checks on persist as a backstop.
import type { InstrumentBook } from './simBroker'

// Contracts open in every instrument but `except` (the one an order is being placed in).
export function openContractsElsewhere(books: Record<string, InstrumentBook>, except?: string): number {
  let total = 0
  for (const [instrument, book] of Object.entries(books)) {
    if (instrument !== except && book.position) total += book.position.contracts
  }
  return total
}

// The contracts an order may still add: the cap less what is open in the OTHER
// instruments (null = uncapped). What the dialog sizes and bounds against.
export function capRoom(cap: number | null | undefined, openElsewhere: number): number | null {
  if (cap === null || cap === undefined) return null
  return Math.max(0, cap - openElsewhere)
}

export function positionCapMessage(
  contracts: number,
  cap: number | null | undefined,
  what: string,
  openElsewhere = 0,
  elsewhereLabel = '',
): string | null {
  if (cap === null || cap === undefined || contracts + openElsewhere <= cap) return null
  if (openElsewhere === 0) {
    return `${what} of ${contracts} contracts is over this session's ${cap}-contract position limit. Reduce the size (or widen the stop distance so auto-sizing fits) and try again.`
  }
  return `${what} of ${contracts} would make ${contracts + openElsewhere} open${elsewhereLabel ? ` (${openElsewhere} already in ${elsewhereLabel})` : ''}, over the ${cap}-contract limit that every instrument shares.`
}
