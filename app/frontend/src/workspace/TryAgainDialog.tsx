// FXR_V2_SPEC.md section 6 (G8): "Try again" after a failed prop session -- a new
// session with the SAME rules (balance, assets, commissions, rule set, discipline
// lock, checklist), where only the start is chosen: a date or a random one. The
// request is built by chart/sessionSetup.ts's buildRetryRequest (tested).
import { useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useCreateBtSession, useSessionSetupOptions } from '../api/hooks'
import type { BacktestSessionDetail } from '../api/types'
import { useModalFocus } from '../components/useModalFocus'
import { sessionDisplayName } from '../chart/sessionEnd'
import {
  DEFAULT_START_TIME,
  MAX_RANDOM_LENGTH_DAYS,
  assetsLabel,
  buildRetryRequest,
  combinedRange,
  describeRules,
  originalLengthDays,
  rangeHint,
  randomLengthError,
  resolveWindow,
  rulesLabel,
} from '../chart/sessionSetup'
import { ET_LABEL, addDaysIso, etClock, fmtEtLongDate, fmtIsoDateLong } from '../timeFormat'

const GHOST_BUTTON =
  'h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'
const CHIP =
  'h-7 rounded px-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

export default function TryAgainDialog({
  session,
  onClose,
  onCreated,
}: {
  session: BacktestSessionDetail
  onClose: () => void
  onCreated: (sessionId: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, true)
  const { data: options } = useSessionSetupOptions(true)
  const create = useCreateBtSession()

  const length = originalLengthDays(session)
  const assets = useMemo(() => (session.assets.length > 0 ? session.assets : [session.instrument]), [session.assets, session.instrument])
  const [mode, setMode] = useState<'pick' | 'random'>('pick')
  // The original window is the starting suggestion; the choice is the user's.
  const [startDate, setStartDate] = useState(() => etClock(session.start_time).date)
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME)
  const [endDate, setEndDate] = useState(() => addDaysIso(etClock(session.start_time).date, length))
  const [days, setDays] = useState(String(length))

  const range = combinedRange(options?.ranges, assets)
  const window = useMemo(
    () =>
      resolveWindow({
        startDate,
        startTime,
        endDate,
        range,
        asset: assetsLabel(assets),
        dataOf: assets.length > 1 ? `the shared ${assetsLabel(assets)}` : undefined,
      }),
    [startDate, startTime, endDate, range, assets],
  )
  const lengthError = mode === 'random' ? randomLengthError(Number(days)) : undefined
  const blocker = !options
    ? 'Loading the data range…'
    : mode === 'random'
      ? (lengthError ?? null)
      : !startDate
        ? 'Choose a start date.'
        : (window.errors.start ?? window.errors.end ?? null)
  const rules = session.account.prop_rules ?? null

  const submit = () => {
    if (blocker || create.isPending || !options) return
    const start =
      mode === 'random'
        ? ({ kind: 'random', days: Number(days) } as const)
        : window.window
          ? ({ kind: 'pick', window: window.window } as const)
          : null
    if (!start) return
    const base = sessionDisplayName(session, fmtEtLongDate)
    create.mutate(buildRetryRequest(session, start, options.presets, `${base} · retry`), { onSuccess: (s) => onCreated(s.id) })
  }

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Try again"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="propbt-settings-content flex max-h-[80vh] flex-col"
      >
        <div className="flex flex-none items-center justify-between gap-3 px-4 py-3">
          <h2 className="text-base font-medium text-text">Try again</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={`${GHOST_BUTTON} flex w-7 items-center justify-center px-0`}>
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
          <div className="flex flex-col gap-1 text-xs" data-testid="retry-summary">
            <span className="text-text">
              Same rules as before · {rulesLabel(session.account.prop_ruleset)} · {assetsLabel(assets)} · ${session.account.starting_balance.toLocaleString('en-US')}
            </span>
            {rules && <span className="text-text-muted">{describeRules(rules).join(' · ')}</span>}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1" role="group" aria-label="Start">
              <button
                type="button"
                aria-pressed={mode === 'pick'}
                onClick={() => setMode('pick')}
                className={`${CHIP} ${mode === 'pick' ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'}`}
              >
                Pick a start
              </button>
              <button
                type="button"
                aria-pressed={mode === 'random'}
                onClick={() => setMode('random')}
                className={`${CHIP} ${mode === 'random' ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'}`}
              >
                Random start
              </button>
            </div>

            {mode === 'pick' ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <span className="micro-label">Start date</span>
                  <div className="flex gap-2">
                    <input type="date" aria-label="Start date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="propbt-input min-w-0 flex-1" />
                    <input
                      type="text"
                      aria-label={`Start time (${ET_LABEL})`}
                      value={startTime}
                      maxLength={5}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="propbt-input w-16"
                    />
                  </div>
                  <span className="text-[11px] text-text-muted">
                    {window.errors.start ?? (startDate ? `${fmtIsoDateLong(startDate)} · ${rangeHint(range)}` : rangeHint(range))}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="micro-label">End date</span>
                  <input type="date" aria-label="End date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="propbt-input w-full" />
                  <span className="text-[11px] text-text-muted">{window.errors.end ?? 'Leave empty to replay without an end'}</span>
                </div>
              </div>
            ) : (
              <div className="flex max-w-48 flex-col gap-1">
                <span className="micro-label">Length (days)</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_RANDOM_LENGTH_DAYS}
                  aria-label="Length in days"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className="propbt-input w-full"
                />
                <span className="text-[11px] text-text-muted">{lengthError ?? 'The start is picked at random inside the data and not shown.'}</span>
              </div>
            )}
          </div>

          {create.isError && (
            <p className="text-xs text-negative-fg" role="alert">
              {(create.error as Error).message}
            </p>
          )}
        </div>

        <div className="flex flex-none items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="min-w-0 truncate text-xs text-text-muted">{blocker ?? ''}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={GHOST_BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={blocker !== null || create.isPending}
              className="h-7 rounded bg-accent px-3 text-xs text-on-accent transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {create.isPending ? 'Creating…' : 'Start new session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
