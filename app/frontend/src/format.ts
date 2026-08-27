// Shared display-formatting helpers -- pure string formatting of
// already-computed numbers, no financial math (VIZ_SPEC section 0). Used by
// DashboardPanel and CompassPanel (POLISH_ROADMAP Phase P5) so a $ or R
// value always reads identically wherever it's shown.
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `${(v * 100).toFixed(1)}%`
}

export function fmtR(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `${v.toFixed(2)}R`
}
