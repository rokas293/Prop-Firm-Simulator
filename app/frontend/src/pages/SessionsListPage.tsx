import { useState } from 'react'
import { useBtSessions } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import Skeleton from '../components/Skeleton'
import NewSessionModal from '../components/NewSessionModal'
import { fmtUsd } from '../format'

function fmtDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

// FXR_SPEC.md phase F1's Sessions list -- same shape as RunsListPage
// (loading skeleton, error state, empty state, micro-label headers,
// row-click-to-select), for manual-replay sessions instead of completed
// automated-backtest runs.
export default function SessionsListPage() {
  const { data: sessions, isLoading, isError, error } = useBtSessions()
  const selectSession = useUiStore((s) => s.selectSession)
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
        <button
          onClick={() => setNewSessionOpen(true)}
          className="h-8 rounded bg-accent px-3 text-xs text-white hover:opacity-90"
        >
          New session
        </button>
      </div>

      {!sessions || sessions.length === 0 ? (
        <div className="text-text-muted">No sessions yet. Start one with "New session" above.</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="micro-label py-1 pr-4 text-left">Instrument</th>
              <th className="micro-label py-1 pr-4 text-left">Timeframe</th>
              <th className="micro-label py-1 pr-4 text-left">Start</th>
              <th className="micro-label py-1 pr-4 text-left">Cursor</th>
              <th className="num micro-label py-1 pr-4">Balance</th>
              <th className="micro-label py-1 pr-4 text-left">Status</th>
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
                className="cursor-pointer border-b border-border hover:bg-surface"
              >
                <td className="py-1 pr-4 text-text">{session.instrument}</td>
                <td className="py-1 pr-4 text-text-muted">{session.base_timeframe}</td>
                <td className="py-1 pr-4 font-mono text-xs text-text-muted">{fmtDate(session.start_time)}</td>
                <td className="py-1 pr-4 font-mono text-xs text-text-muted">{fmtDate(session.cursor_time)}</td>
                <td className="num py-1 pr-4 text-text">{fmtUsd(session.account.balance)}</td>
                <td className="py-1 pr-4">
                  {session.status === 'active' ? (
                    <span className="text-positive">ACTIVE</span>
                  ) : (
                    <span className="text-text-muted">ARCHIVED</span>
                  )}
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
