// "New session" flow (FXR_SPEC.md phase F1) -- same overlay/content-box
// convention as SettingsPanel (.propbt-cmdk-overlay backdrop, a fixed
// centered content box, useModalFocus for focus trapping), since this is
// occasional setup, not a dockable panel.
import { useRef, useState } from 'react'
import { useModalFocus } from './useModalFocus'
import { useCreateBtSession } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import type { Timeframe } from '../state/uiStore'
import { ET_LABEL, etWallTimeToUnix } from '../timeFormat'

const INSTRUMENTS = ['MNQ', 'MES'] as const
const TOPSTEP_BALANCE = 50000
const TIMEFRAMES: Timeframe[] = ['1min', '5min', '15min', '1h']

// datetime-local has no timezone of its own -- it is read as Eastern Time
// (the zone every displayed time and the session rules use), and converted
// to the UTC unix seconds the API stores.
const localInputToUnixSeconds = etWallTimeToUnix

export default function NewSessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null)
  useModalFocus(contentRef, open)
  const selectSession = useUiStore((s) => s.selectSession)
  const createSession = useCreateBtSession()

  const [instrument, setInstrument] = useState<(typeof INSTRUMENTS)[number]>('MES')
  const [baseTimeframe, setBaseTimeframe] = useState<Timeframe>('5min')
  const [startTimeInput, setStartTimeInput] = useState('')
  const [randomStart, setRandomStart] = useState(false)
  const [startingBalance, setStartingBalance] = useState(50000)
  const [riskPercent, setRiskPercent] = useState(1)
  const [defaultContracts, setDefaultContracts] = useState(1)
  const [commission, setCommission] = useState(1.3)
  // FXR_SPEC.md phase F6: run the session as a Topstep $50k Combine sim --
  // the rule engine (target/MLL/daily loss/consistency) judges the session's
  // trades in its analytics. Locks the balance to the ruleset's own $50k;
  // the backend rejects any other balance.
  const [topstep, setTopstep] = useState(false)

  if (!open) return null

  const startTime = randomStart ? null : localInputToUnixSeconds(startTimeInput)
  const canSubmit = randomStart || startTime !== null

  const handleCreate = () => {
    if (!canSubmit) return
    createSession.mutate(
      {
        instrument,
        base_timeframe: baseTimeframe,
        start_time: startTime,
        random_start: randomStart,
        starting_balance: topstep ? TOPSTEP_BALANCE : startingBalance,
        risk_per_trade_percent: riskPercent,
        default_contracts: defaultContracts,
        commission_per_contract: commission,
        prop_ruleset: topstep ? 'topstep_50k' : null,
      },
      {
        onSuccess: (session) => {
          selectSession(session.id)
          onClose()
        },
      },
    )
  }

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div
        ref={contentRef}
        className="propbt-settings-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New session"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-medium text-text">New session</h2>
          <button onClick={onClose} className="h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text">
            Esc to close
          </button>
        </div>

        <div className="flex flex-col gap-6 px-4 py-4">
          <div>
            <div className="micro-label mb-2">Instrument</div>
            <div className="flex gap-2">
              {INSTRUMENTS.map((sym) => (
                <button
                  key={sym}
                  onClick={() => setInstrument(sym)}
                  aria-pressed={instrument === sym}
                  className={`h-7 rounded px-3 text-xs ${
                    instrument === sym ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                  }`}
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="micro-label mb-2">Base timeframe</div>
            <div className="flex gap-2">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setBaseTimeframe(tf)}
                  aria-pressed={baseTimeframe === tf}
                  className={`h-7 rounded px-3 text-xs ${
                    baseTimeframe === tf ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="micro-label mb-2">Start</div>
            <div className="flex items-center gap-3">
              <input
                type="datetime-local"
                value={startTimeInput}
                onChange={(e) => setStartTimeInput(e.target.value)}
                disabled={randomStart}
                className="propbt-input"
              />
              <span className="text-xs text-text-muted">{ET_LABEL}</span>
              <label className="ml-auto flex items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" checked={randomStart} onChange={(e) => setRandomStart(e.target.checked)} />
                Random start
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="micro-label">Starting balance</span>
              <input
                type="text"
                inputMode="numeric"
                value={(topstep ? TOPSTEP_BALANCE : startingBalance).toLocaleString('en-US')}
                disabled={topstep}
                onChange={(e) => setStartingBalance(Number(e.target.value.replace(/[^0-9]/g, '')))}
                className="propbt-input"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro-label">Risk per trade (%)</span>
              <input
                type="number"
                step="0.1"
                value={riskPercent}
                onChange={(e) => setRiskPercent(Number(e.target.value))}
                className="propbt-input"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro-label">Default contracts</span>
              <input
                type="number"
                min={1}
                value={defaultContracts}
                onChange={(e) => setDefaultContracts(Number(e.target.value))}
                className="propbt-input"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro-label">Commission / contract</span>
              <input
                type="number"
                step="0.01"
                value={commission}
                onChange={(e) => setCommission(Number(e.target.value))}
                className="propbt-input"
              />
            </label>
          </div>

          <label className="flex items-start gap-2 text-xs text-text-muted">
            <input type="checkbox" checked={topstep} onChange={(e) => setTopstep(e.target.checked)} className="mt-1" />
            <span>
              <span className="text-text">Topstep $50k Combine rules</span>
              <br />
              Judges this session against the profit target, trailing max loss, daily loss limit and consistency rule.
              Locks the balance to $50,000.
            </span>
          </label>

          {createSession.isError && (
            <div className="text-xs text-negative-fg">{(createSession.error as Error).message}</div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <button onClick={onClose} className="h-7 rounded bg-surface-2 px-3 text-xs text-text hover:bg-surface-2-hover">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!canSubmit || createSession.isPending}
              className="h-7 rounded bg-accent px-3 text-xs text-on-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {createSession.isPending ? 'Creating…' : 'Create session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
