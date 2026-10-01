// Topstep's position limit (propbt/config/prop_rules.yaml max_open_contracts,
// surfaced on the session as account.max_contracts): a session created with
// Topstep rules can never hold more contracts than the cap in one position.
// The sim broker lives in the browser, so every order path (quick Buy/Sell,
// the New Trade ticket, right-click limit/stop) checks here BEFORE creating
// anything; the backend re-checks on persist as a backstop.
export function positionCapMessage(
  contracts: number,
  cap: number | null | undefined,
  what: string,
): string | null {
  if (cap === null || cap === undefined || contracts <= cap) return null
  return `${what} of ${contracts} contracts is over this session's ${cap}-contract Topstep position limit. Reduce the size (or widen the stop distance so auto-sizing fits) and try again.`
}
