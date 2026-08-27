import type {
  AiStatusResponse,
  Bar,
  DailyRiskPoint,
  EquityPoint,
  IndicatorResponse,
  RunMeta,
  RunSummary,
  SessionWindow,
  StatsResponse,
  SummarizeResponse,
  TradeRecord,
} from './types'
import { usePerfStore } from '../state/perfStore'

export type QueryParams = Record<string, string | number | undefined>

function buildQuery<T extends QueryParams>(params?: T): string {
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
}
