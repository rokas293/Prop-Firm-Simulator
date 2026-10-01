import type {
  AddScreenshotRequest,
  AiStatusResponse,
  Bar,
  BacktestSessionDetail,
  BacktestSessionSummary,
  CreateManualTradeRequest,
  CreateSessionRequest,
  DailyRiskPoint,
  EquityPoint,
  IndicatorResponse,
  ManualTrade,
  PersistedPosition,
  PersistedWorkingOrder,
  RecordTradeResponse,
  RunMeta,
  RunSummary,
  SessionWindow,
  StatsResponse,
  SummarizeResponse,
  TradeRecord,
  UpdateSessionNotesRequest,
  UpdateSessionStateRequest,
  UpdateTradeJournalRequest,
} from './types'
import { usePerfStore } from '../state/perfStore'

export type QueryParams = Record<string, string | number | undefined>

// Exported for direct unit testing (same "pure helper, testable without
// mounting anything" pattern as drawingOverlays.ts's measureLabel) -- every
// API call goes through this, so a query-string bug here would be silent
// and app-wide.
export function buildQuery<T extends QueryParams>(params?: T): string {
  if (!params) return ''
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// Timed for the perf HUD (POLISH_ROADMAP Phase P4) -- recordFetch no-ops
// when the HUD is off (see perfStore.ts), so this costs one timestamp read
// per request in the common case.
async function request<T, P extends QueryParams = QueryParams>(path: string, params?: P): Promise<T> {
  const startedAt = performance.now()
  const res = await fetch(`/api${path}${buildQuery(params)}`)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${path}`)
  }
  const data = (await res.json()) as T
  usePerfStore.getState().recordFetch(path, performance.now() - startedAt)
  return data
}

// The one POST in this API (POLISH_ROADMAP Phase P5's "Summarize this run")
// -- everything else is a read, so this doesn't warrant generalizing
// request() into a full HTTP-method-aware client for a single call site.
async function postRequest<T, P extends QueryParams = QueryParams>(path: string, params?: P): Promise<T> {
  const startedAt = performance.now()
  const res = await fetch(`/api${path}${buildQuery(params)}`, { method: 'POST' })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText} for ${path}`)
  }
  const data = (await res.json()) as T
  usePerfStore.getState().recordFetch(path, performance.now() - startedAt)
  return data
}

// FXR_SPEC.md phase F1 needs JSON request bodies (session create/cursor
// update) -- postRequest above only ever sent query params (its one call
// site, summarizeRun, has no body). A separate pair rather than widening
// postRequest, since every existing call site still expects query-params
// semantics and this shouldn't risk changing them.
async function sendJson<T, B>(path: string, method: 'POST' | 'PATCH', body: B): Promise<T> {
  const startedAt = performance.now()
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText} for ${path}`)
  }
  const data = (await res.json()) as T
  usePerfStore.getState().recordFetch(path, performance.now() - startedAt)
  return data
}

// FXR_SPEC.md section C, phase F5: deleting a screenshot has no body at
// all -- its own tiny method rather than widening sendJson for a no-body
// case.
async function deleteRequest<T>(path: string): Promise<T> {
  const startedAt = performance.now()
  const res = await fetch(`/api${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText} for ${path}`)
  }
  const data = (await res.json()) as T
  usePerfStore.getState().recordFetch(path, performance.now() - startedAt)
  return data
}

export const api = {
  listRuns: () => request<RunSummary[]>('/runs'),
  getRun: (runId: string) => request<RunMeta>(`/runs/${runId}`),
  getTrades: <P extends QueryParams>(runId: string, params?: P) =>
    request<TradeRecord[], P>(`/runs/${runId}/trades`, params),
  getEquity: (runId: string, params?: QueryParams) => request<EquityPoint[]>(`/runs/${runId}/equity`, params),
  getStats: (runId: string, scope: 'all' | 'is' | 'oos' = 'all') =>
    request<StatsResponse>(`/runs/${runId}/stats`, { scope }),
  getBars: (params: QueryParams) => request<Bar[]>('/bars', params),
  getSessions: (params: QueryParams) => request<SessionWindow[]>('/sessions', params),
  getDailyRisk: (runId: string) => request<DailyRiskPoint[]>(`/runs/${runId}/daily_risk`),
  getIndicators: (params: QueryParams) => request<IndicatorResponse>('/indicators', params),
  getAiStatus: () => request<AiStatusResponse>('/ai/status'),
  summarizeRun: (runId: string, scope: 'all' | 'is' | 'oos' = 'oos') =>
    postRequest<SummarizeResponse>(`/runs/${runId}/summarize`, { scope }),
  // FXR_SPEC.md phase F1 -- routed under /bt-sessions, not /sessions
  // (getSessions above is the unrelated trading-session-windows endpoint).
  listBtSessions: (includeArchived = false) =>
    request<BacktestSessionSummary[]>('/bt-sessions', { include_archived: includeArchived ? 'true' : undefined }),
  getBtSession: (sessionId: string) => request<BacktestSessionDetail>(`/bt-sessions/${sessionId}`),
  createBtSession: (body: CreateSessionRequest) => sendJson<BacktestSessionDetail, CreateSessionRequest>('/bt-sessions', 'POST', body),
  // F4: also carries the FULL current position/working-orders snapshot
  // (see UpdateSessionStateRequest's own comment) -- position/workingOrders
  // default to null/[] (flat) so F1/F2 call sites that only care about the
  // cursor don't need to change.
  updateBtSessionCursor: (
    sessionId: string,
    cursorTime: number,
    position: PersistedPosition | null = null,
    workingOrders: PersistedWorkingOrder[] = [],
  ) =>
    sendJson<BacktestSessionDetail, UpdateSessionStateRequest>(`/bt-sessions/${sessionId}/cursor`, 'PATCH', {
      cursor_time: cursorTime,
      position,
      working_orders: workingOrders,
    }),
  archiveBtSession: (sessionId: string) => postRequest<BacktestSessionDetail>(`/bt-sessions/${sessionId}/archive`),
  updateBtSessionNotes: (sessionId: string, notes: string) =>
    sendJson<BacktestSessionDetail, UpdateSessionNotesRequest>(`/bt-sessions/${sessionId}/notes`, 'PATCH', { notes }),
  getBtSessionTrades: (sessionId: string) => request<ManualTrade[]>(`/bt-sessions/${sessionId}/trades`),
  createManualTrade: (sessionId: string, body: CreateManualTradeRequest) =>
    sendJson<RecordTradeResponse, CreateManualTradeRequest>(`/bt-sessions/${sessionId}/trades`, 'POST', body),
  // FXR_SPEC.md section C, phase F5: journal-only fields on an already-
  // recorded trade -- a separate PATCH from createManualTrade above, which
  // is purely the sim broker's durable-storage write (never journal data).
  updateTradeJournal: (sessionId: string, tradeId: number, body: UpdateTradeJournalRequest) =>
    sendJson<ManualTrade, UpdateTradeJournalRequest>(`/bt-sessions/${sessionId}/trades/${tradeId}`, 'PATCH', body),
  // Screenshots are their own endpoints, not part of updateTradeJournal --
  // the backend writes the decoded image to its own file rather than
  // embedding it in trades.json (see AddScreenshotRequest's own comment).
  // Both return the updated ManualTrade (server-authoritative, including
  // the new/remaining screenshots list), same shape as updateTradeJournal.
  addTradeScreenshot: (sessionId: string, tradeId: number, body: AddScreenshotRequest) =>
    sendJson<ManualTrade, AddScreenshotRequest>(`/bt-sessions/${sessionId}/trades/${tradeId}/screenshots`, 'POST', body),
  deleteTradeScreenshot: (sessionId: string, tradeId: number, screenshotId: string) =>
    deleteRequest<ManualTrade>(`/bt-sessions/${sessionId}/trades/${tradeId}/screenshots/${screenshotId}`),
}
