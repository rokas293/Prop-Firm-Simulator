import type { Bar, EquityPoint, RunMeta, RunSummary, SessionWindow, StatsResponse, TradeRecord } from './types'

type QueryParams = Record<string, string | number | undefined>

function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

async function request<T>(path: string, params?: QueryParams): Promise<T> {
  const res = await fetch(`/api${path}${buildQuery(params)}`)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${path}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listRuns: () => request<RunSummary[]>('/runs'),
  getRun: (runId: string) => request<RunMeta>(`/runs/${runId}`),
  getTrades: (runId: string, params?: QueryParams) => request<TradeRecord[]>(`/runs/${runId}/trades`, params),
  getEquity: (runId: string, params?: QueryParams) => request<EquityPoint[]>(`/runs/${runId}/equity`, params),
  getStats: (runId: string, scope: 'all' | 'is' | 'oos' = 'all') =>
    request<StatsResponse>(`/runs/${runId}/stats`, { scope }),
  getBars: (params: QueryParams) => request<Bar[]>('/bars', params),
  getSessions: (params: QueryParams) => request<SessionWindow[]>('/sessions', params),
}
