// FXR_V2_SPEC.md section 6 (G7): the economic calendar popover on the chart toolbar --
// the scheduled high-impact events of one ET day (the cursor's day to start with,
// stepped with the arrows) and the Show events switch for the chart's markers.
//
// It lists the SCHEDULE only: when, which event, how important. A later day is as
// available as today -- what is public in advance -- and nothing about an outcome
// exists in the data or is shown.
import { useEffect, useRef, useState } from 'react'
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react'
import { useNewsEvents } from '../api/hooks'
import { groupNewsByTime } from '../chart/kl/newsOverlay'
import Switch from '../components/Switch'
import { POPOVER_SHELL } from '../components/popoverStyles'
import { addDaysIso, etClock, etDayEndUnix, etDayStartUnix, fmtEtTime, fmtIsoDateLong } from '../timeFormat'
import { IconButton } from './SessionTopBar'

const NAV =
  'flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

export interface NewsCalendarProps {
  // The replay cursor (unix seconds): the day the popover opens on.
  cursorTime: number | null
  showEvents: boolean
  onShowEventsChange: (v: boolean) => void
  // Minutes either side of an event closed to entries; null when the session has no news rule.
  windowMinutes: number | null
}

export default function NewsCalendarMenu({ cursorTime, showEvents, onShowEventsChange, windowMinutes }: NewsCalendarProps) {
  const [open, setOpen] = useState(false)
  const [day, setDay] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const cursorDay = cursorTime !== null ? etClock(cursorTime).date : null
  const shown = day ?? cursorDay
  const from = open && shown ? etDayStartUnix(shown) : null
  const to = open && shown ? etDayEndUnix(shown) : null
  const { data: events, isError } = useNewsEvents(from, to)
  const groups = events ? groupNewsByTime(events) : []

  return (
    <div ref={ref} className="relative">
      <IconButton
        label="Economic calendar"
        onClick={() => {
          if (!open) setDay(null)
          setOpen((v) => !v)
        }}
        pressed={open}
        expanded={open}
        haspopup="dialog"
      >
        <CalendarClock size={16} aria-hidden />
      </IconButton>
      {open && shown && (
        <div role="dialog" aria-label="Economic calendar" className={`${POPOVER_SHELL} absolute right-0 top-9 z-30 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3`}>
          <div className="flex items-center justify-between">
            <button type="button" aria-label="Previous day" className={NAV} onClick={() => setDay(addDaysIso(shown, -1))}>
              <ChevronLeft size={16} aria-hidden />
            </button>
            <span className="text-text" aria-live="polite">
              {fmtIsoDateLong(shown)}
            </span>
            <button type="button" aria-label="Next day" className={NAV} onClick={() => setDay(addDaysIso(shown, 1))}>
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>
          <ul className="flex flex-col gap-2" aria-label="Scheduled events">
            {isError ? (
              <li className="text-text-muted">The calendar could not be loaded.</li>
            ) : !events ? (
              <li className="text-text-muted">Loading…</li>
            ) : groups.length === 0 ? (
              <li className="text-text-muted">No high-impact events scheduled.</li>
            ) : (
              groups.flatMap((g) =>
                g.map((e, i) => (
                  <li key={`${e.time}-${e.event}-${i}`} className="flex items-baseline gap-3">
                    <span className="w-12 flex-none tabular-nums text-text-muted">{i === 0 ? fmtEtTime(e.time) : ''}</span>
                    <span className="min-w-0 flex-1 text-text">{e.event}</span>
                  </li>
                )),
              )
            )}
          </ul>
          <p className="text-text-muted">
            Times are Eastern. Results aren't shown.
            {windowMinutes !== null ? ` This session closes entries ${windowMinutes} min either side.` : ''}
          </p>
          <div className="flex items-center justify-between">
            <span className="text-text">Show events on the chart</span>
            <Switch checked={showEvents} onChange={onShowEventsChange} label="Show events" tone="neutral" />
          </div>
        </div>
      )}
    </div>
  )
}
