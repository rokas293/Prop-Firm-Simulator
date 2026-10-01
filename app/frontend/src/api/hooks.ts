import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { fetchBarsInWorker } from '../workers/barsWorkerClient'
import type { StatsScope, TradeQueryParams } from '../state/tradeStore'
import type {
  AddScreenshotRequest,
  CreateManualTradeRequest,
  CreateSessionRequest,
  IndicatorName,
  ManualTrade,
  PersistedPosition,
  PersistedWorkingOrder,
  UpdateTradeJournalRequest,
} from './types'

export type { StatsScope }

export function useRuns() {
  return useQuery({ queryKey: ['runs'], queryFn: api.listRuns })
}

// Prefetches a run's heaviest panel payloads on hover in the runs list
// (POLISH_ROADMAP Phase P4) so clicking through to the workspace mostly
// hits warm cache instead of every panel triggering its own fresh round
// trip. Doesn't chase every filtered/scoped variant a panel might request
// (e.g. Dashboard's IS-scoped trades depend on the run's own
// is_oos_split_date, unknown until /runs/{id} itself resolves) -- just the
// unfiltered trades list, the default ('oos') and 'all' stats scopes, and
// the run metadata, which cover the first paint of every panel that opens
// by default.
export function usePrefetchRun() {
  const queryClient = useQueryClient()
  return (runId: string) => {
    void queryClient.prefetchQuery({ queryKey: ['run', runId], queryFn: () => api.getRun(runId) })
    void queryClient.prefetchQuery({ queryKey: ['trades', runId, undefined], queryFn: () => api.getTrades(runId) })
    void queryClient.prefetchQuery({ queryKey: ['trades', runId, {}], queryFn: () => api.getTrades(runId, {}) })
    void queryClient.prefetchQuery({ queryKey: ['stats', runId, 'oos'], queryFn: () => api.getStats(runId, 'oos') })
    void queryClient.prefetchQuery({ queryKey: ['stats', runId, 'all'], queryFn: () => api.getStats(runId, 'all') })
  }
}

export function useRun(runId: string | null) {
  return useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.getRun(runId as string),
    enabled: runId !== null,
  })
}

export function useTrades(runId: string | null, filters?: TradeQueryParams) {
  return useQuery({
    queryKey: ['trades', runId, filters],
    queryFn: () => api.getTrades(runId as string, filters),
    enabled: runId !== null,
  })
}

// Bar fetch + JSON parse happens in a Web Worker, not on the main thread
// (POLISH_ROADMAP Phase P4) -- see workers/barsWorkerClient.ts. react-query
// still owns caching/dedup/loading state exactly as before; only where the
// bytes get fetched and parsed changes.
export function useBars(
  instrument: string | null,
  tf: string,
  from: number | null,
  to: number | null,
  maxPoints = 2000,
) {
  return useQuery({
    queryKey: ['bars', instrument, tf, from, to, maxPoints],
    queryFn: () =>
      fetchBarsInWorker({ instrument: instrument as string, tf, from: from as number, to: to as number, max_points: maxPoints }),
    enabled: instrument !== null && from !== null && to !== null,
  })
}

export function useSessions(instrument: string | null, from: number | null, to: number | null) {
  return useQuery({
    queryKey: ['sessions', instrument, from, to],
    queryFn: () => api.getSessions({ instrument: instrument as string, from: from as number, to: to as number }),
    enabled: instrument !== null && from !== null && to !== null,
  })
}

// `filters` (F6) only does anything for a manual run: the backend narrows the
// stats to the same journal slice (tag/setup/grade/session/hour) the trade
// list is filtered to. Part of the query key, so each slice caches on its own.
export function useStats(runId: string | null, scope: StatsScope, filters?: TradeQueryParams) {
  return useQuery({
    queryKey: filters && Object.values(filters).some((v) => v !== undefined) ? ['stats', runId, scope, filters] : ['stats', runId, scope],
    queryFn: () => api.getStats(runId as string, scope, filters),
    enabled: runId !== null,
  })
}

// FXR_SPEC.md phase F6: Monte Carlo over a run's/session's realized trade
// sequence (propbt.sim.monte_carlo.run_trade_sequence_monte_carlo). Seeded,
// so the same inputs always return the same distribution.
export function useMonteCarlo(
  runId: string | null,
  params: { method: 'bootstrap' | 'shuffle'; n_sims: number; seed: number } & TradeQueryParams,
  enabled = true,
) {
  return useQuery({
    queryKey: ['monte-carlo', runId, params],
    queryFn: () => api.getMonteCarlo(runId as string, params),
    enabled: runId !== null && enabled,
    // A 400 here means "no trades in this scope" -- not worth retrying.
    retry: false,
  })
}

// Equity/drawdown curve, honestly downsampled server-side
// (bundle_reader._compress_equity) -- never scoped by IS/OOS, since it's
// the one continuous trajectory that actually happened (see ChartPage's
// day-window comment for the same "server computes it" principle).
// from/to are optional: omitted (Dashboard/Risk pages) means the full run;
// passed (ChartPage's replay live readout) scopes to just the visible
// window, so the readout doesn't pull hundreds of thousands of rows for a
// single trade's replay.
export function useEquity(runId: string | null, maxPoints = 3000, from?: number | null, to?: number | null) {
  return useQuery({
    queryKey: ['equity', runId, maxPoints, from ?? null, to ?? null],
    queryFn: () =>
      api.getEquity(runId as string, {
        max_points: maxPoints,
        from: from ?? undefined,
        to: to ?? undefined,
      }),
    enabled: runId !== null,
  })
}

// Per-day worst distance-to-MLL, computed server-side over the full
// uncompressed equity series (bundle_reader.list_daily_risk) -- the
// intraday minimum could fall on a bar the /equity endpoint's own
// decimation drops, so this is deliberately a separate, exact aggregate.
export function useDailyRisk(runId: string | null) {
  return useQuery({
    queryKey: ['daily_risk', runId],
    queryFn: () => api.getDailyRisk(runId as string),
    enabled: runId !== null,
  })
}

// Computed server-side by reusing propbt.data.indicators directly (VIZ_SPEC
// section 6/8) -- never recomputed in the browser.
export function useIndicators(
  instrument: string | null,
  tf: string,
  from: number | null,
  to: number | null,
  which: IndicatorName[],
) {
  return useQuery({
    queryKey: ['indicators', instrument, tf, from, to, which],
    queryFn: () =>
      api.getIndicators({
        instrument: instrument as string,
        tf,
        from: from as number,
        to: to as number,
        which: which.join(','),
      }),
    enabled: instrument !== null && from !== null && to !== null && which.length > 0,
  })
}

// Whether the optional "Summarize this run" AI insight is configured on the
// backend (POLISH_ROADMAP Phase P5) -- lets CompassPanel disable/hide the
// button up front instead of only finding out on click. A long staleTime
// is fine: this only flips when the backend's ANTHROPIC_API_KEY changes,
// which never happens mid-session.
export function useAiStatus() {
  return useQuery({ queryKey: ['ai-status'], queryFn: api.getAiStatus, staleTime: 5 * 60 * 1000 })
}

// A button-triggered POST, not data to keep in sync -- a mutation, not a
// query (VIZ_SPEC section 6's contract is otherwise all-GET; see
// client.ts's postRequest comment for why this is the one exception).
// Sends only already-aggregated stats (the scope's StatsResponse), never
// raw trades/bars, to the backend, which forwards them to Claude.
export function useSummarizeRun() {
  return useMutation({
    mutationFn: ({ runId, scope }: { runId: string; scope: StatsScope }) => api.summarizeRun(runId, scope),
  })
}

// FXR_SPEC.md phase F1: manual-backtest sessions. Named useBtSession* (not
// useSession*) throughout -- useSessions above already means trading-
// session windows, an unrelated concept.
export function useBtSessions(includeArchived = false) {
  return useQuery({
    queryKey: ['bt-sessions', includeArchived],
    queryFn: () => api.listBtSessions(includeArchived),
  })
}

export function useBtSession(sessionId: string | null) {
  return useQuery({
    queryKey: ['bt-session', sessionId],
    queryFn: () => api.getBtSession(sessionId as string),
    enabled: sessionId !== null,
  })
}

export function useCreateBtSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSessionRequest) => api.createBtSession(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bt-sessions'] })
    },
  })
}

// Fired on a debounce as replay steps forward (see SessionWorkspace) --
// updates the cached session in place rather than invalidating, so the
// list/detail queries don't refetch on every cursor step.
export function useUpdateBtSessionCursor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      sessionId,
      cursorTime,
      position,
      workingOrders,
    }: {
      sessionId: string
      cursorTime: number
      position?: PersistedPosition | null
      workingOrders?: PersistedWorkingOrder[]
    }) => api.updateBtSessionCursor(sessionId, cursorTime, position ?? null, workingOrders ?? []),
    onSuccess: (updated) => {
      queryClient.setQueryData(['bt-session', updated.id], updated)
    },
  })
}

export function useArchiveBtSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => api.archiveBtSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bt-sessions'] })
    },
  })
}

// FXR_SPEC.md phase F2: journaled manual trades. The session's own trades,
// not to be confused with useTrades (an automated-backtest run's trades).
export function useBtSessionTrades(sessionId: string | null) {
  return useQuery({
    queryKey: ['bt-session-trades', sessionId],
    queryFn: () => api.getBtSessionTrades(sessionId as string),
    enabled: sessionId !== null,
  })
}

// Closing a position: journals the trade AND applies its net PnL to the
// account balance server-side in one round trip (see record_trade in
// bt_session_service.py) -- refreshes both the trades list and the session
// itself (for the new balance), rather than trusting a locally-guessed one.
export function useCreateManualTrade() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, body }: { sessionId: string; body: CreateManualTradeRequest }) =>
      api.createManualTrade(sessionId, body),
    onSuccess: (result, { sessionId }) => {
      queryClient.setQueryData(['bt-session', sessionId], result.session)
      void queryClient.invalidateQueries({ queryKey: ['bt-session-trades', sessionId] })
      // A closed trade can resolve a Topstep Combine -- refresh its verdict.
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['bt-sessions'] })
    },
  })
}

// FXR_SPEC.md section C, phase F5: session-level journal notes.
export function useUpdateBtSessionNotes() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, notes }: { sessionId: string; notes: string }) =>
      api.updateBtSessionNotes(sessionId, notes),
    onSuccess: (updated) => {
      queryClient.setQueryData(['bt-session', updated.id], updated)
    },
  })
}

// Shared by every mutation below that returns the single updated ManualTrade
// (updateTradeJournal/addTradeScreenshot/deleteTradeScreenshot) -- splices
// the server-authoritative trade into the cached list in place rather than
// invalidating, so an edit doesn't flash a refetch.
function spliceUpdatedTrade(queryClient: ReturnType<typeof useQueryClient>, sessionId: string, updated: ManualTrade) {
  queryClient.setQueryData(['bt-session-trades', sessionId], (prev: ManualTrade[] | undefined) =>
    (prev ?? []).map((t) => (t.trade_id === updated.trade_id ? updated : t)),
  )
}

// Notes/tags/setup_name/grade on an already-journaled trade. Screenshots
// are NOT here -- see useAddTradeScreenshot/useDeleteTradeScreenshot below.
export function useUpdateTradeJournal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      sessionId,
      tradeId,
      body,
    }: {
      sessionId: string
      tradeId: number
      body: UpdateTradeJournalRequest
    }) => api.updateTradeJournal(sessionId, tradeId, body),
    onSuccess: (updated, { sessionId }) => spliceUpdatedTrade(queryClient, sessionId, updated),
  })
}

// FXR_SPEC.md section C, phase F5: adds/removes one screenshot at a time,
// each call returning the trade's full, server-authoritative screenshots
// list -- unlike tags (see JournalPanel.tsx's own comment on why THOSE
// draft locally to avoid a lost-update race), these never need a client-
// side "next array" merge: the server always computes the new list itself
// from whatever it has on disk, so there's nothing for two rapid calls to
// race over.
export function useAddTradeScreenshot() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      sessionId,
      tradeId,
      body,
    }: {
      sessionId: string
      tradeId: number
      body: AddScreenshotRequest
    }) => api.addTradeScreenshot(sessionId, tradeId, body),
    onSuccess: (updated, { sessionId }) => spliceUpdatedTrade(queryClient, sessionId, updated),
  })
}

export function useDeleteTradeScreenshot() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      sessionId,
      tradeId,
      screenshotId,
    }: {
      sessionId: string
      tradeId: number
      screenshotId: string
    }) => api.deleteTradeScreenshot(sessionId, tradeId, screenshotId),
    onSuccess: (updated, { sessionId }) => spliceUpdatedTrade(queryClient, sessionId, updated),
  })
}
