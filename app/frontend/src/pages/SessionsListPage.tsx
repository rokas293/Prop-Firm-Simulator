import { useState } from 'react'
import { useBtSessions } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import Skeleton from '../components/Skeleton'
import NewSessionModal from '../components/NewSessionModal'
import { fmtUsd } from '../format'
import { fmtEtDateTime } from '../timeFormat'
import { manualAllRunId, manualRunId } from '../api/types'


// FXR_SPEC.md phase F1's Sessions list -- same shape as RunsListPage
// (loading skeleton, error state, empty state, micro-label headers,
// row-click-to-select), for manual-replay sessions instead of completed
// automated-backtest runs.
export default function SessionsListPage() {
  const { data: sessions, isLoading, isError, error } = useBtSessions()
  const selectSession = useUiStore((s) => s.selectSession)
  const selectRun = useUiStore((s) => s.selectRun)
  const [newSessionOpen, setNewSessionOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-6 w-24" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      </div>
    )
  }
  if (isError) {
    return (
      <div className="p-6">
        <span className="text-negative">Failed to load sessions</span>
        <span className="text-text-muted">: {(error as Error).message}</span>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          {/* FXR_SPEC.md phase F6: every session of one instrument, pooled
              (per instrument -- the chart plots a single price scale). */}
          {(['MNQ', 'MES'] as const)
            .filter((sym) => sessions?.some((s) => s.instrument === sym))
            .map((sym) => (
              <button
                key={sym}
                onClick={() => selectRun(manualAllRunId(sym))}
                title={`Analytics across all ${sym} sessions combined`}
                className="h-8 rounded bg-surface-2 px-3 text-xs text-text hover:bg-surface-2-hover"
              >
                All {sym} analytics
              </button>
            ))}
          <button
            onClick={() => setNewSessionOpen(true)}
            className="h-8 rounded bg-accent px-3 text-xs text-white hover:opacity-90"
          >
            New session
          </button>
        </div>
      </div>

      {!sessions || sessions.length === 0 ? (
        <div className="text-text-muted">No sessions yet. Start one with "New session" above.</div>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="h-8 border-b border-border text-left">
              <th className="micro-label py-1 pr-4 text-left">Instrument</th>
              <th className="micro-label py-1 pr-4 text-left">Timeframe</th>
              <th className="micro-label py-1 pr-4 text-left">Start</th>
              <th className="micro-label py-1 pr-4 text-left">Cursor</th>
              <th className="num micro-label py-1 pr-4">Balance</th>
              <th className="micro-label py-1 pr-4 text-left">Rules</th>
              <th className="micro-label py-1 pr-4 text-left">Status</th>
              <th className="py-1 pr-4"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={session.id}
                onClick={() => selectSession(session.id)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    selectSession(session.id)
                  }
                }}
                className="group h-8 cursor-pointer border-b border-border hover:bg-surface"
              >
                <td className="pr-4 text-text">{session.instrument}</td>
                <td className="pr-4 text-text-muted">{session.base_timeframe}</td>
                <td className="pr-4 text-xs tabular-nums text-text-muted">{fmtEtDateTime(session.start_time)}</td>
                <td className="pr-4 text-xs tabular-nums text-text-muted">{fmtEtDateTime(session.cursor_time)}</td>
                <td className="num pr-4 text-text">{fmtUsd(session.account.balance)}</td>
                <td className="pr-4 text-text-muted">
                  {session.account.prop_ruleset === 'topstep_50k' ? 'Topstep $50k' : '-'}
                  {session.prop_status && (
                    // Semantic colour on the verdict only; an open Combine stays muted.
                    <span
                      className={`ml-2 ${
                        session.prop_status.status === 'passed'
                          ? 'text-positive'
                          : session.prop_status.status === 'failed'
                            ? 'text-negative'
                            : 'text-text-muted'
                      }`}
                    >
                      {session.prop_status.status === 'passed' ? 'Pass' : session.prop_status.status === 'failed' ? 'Fail' : 'Open'}
                    </span>
                  )}
                </td>
                <td className="pr-4">
                  {session.status === 'active' ? (
                    <span className="text-text">ACTIVE</span>
                  ) : (
                    <span className="text-text-muted">ARCHIVED</span>
                  )}
                </td>
                <td className="pr-4 text-right">
                  {/* Revealed on row hover/focus (DESIGN_LANGUAGE.md: controls
                      that could reveal on hover shouldn't be always visible). */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      selectRun(manualRunId(session.id))
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="rounded px-2 py-1 text-xs text-text-muted opacity-0 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    Analytics
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <NewSessionModal open={newSessionOpen} onClose={() => setNewSessionOpen(false)} />
    </div>
  )
}
