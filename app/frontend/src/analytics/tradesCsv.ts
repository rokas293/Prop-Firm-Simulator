// FXR_V2_SPEC.md section 7 (G9): where the trades CSV comes from. The server lays the file
// out (services/trades_csv.py); the frontend only links to it.
export function tradesCsvUrl(sessionId: string | null): string {
  return sessionId ? `/api/bt-sessions/${encodeURIComponent(sessionId)}/trades.csv` : '/api/bt-sessions/export.csv'
}
