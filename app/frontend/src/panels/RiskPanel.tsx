import { useRef } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import RiskChart, { type RiskChartHandle } from '../chart/RiskChart'
import { useDailyRisk, useEquity, useRun } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { CHART_PANEL_ID } from '../workspace/panelIds'
import { fmtUsdWhole as fmtUsd } from '../format'
import EmptyState from '../components/EmptyState'
import Skeleton from '../components/Skeleton'
import { useThemeStore, useThemeBase } from '../state/themeStore'
import { hexToRgba } from '../chart/color'
import type { DailyRiskPoint } from '../api/types'

// High enough that a multi-year run's change-detection-compressed equity
// (see bundle_reader._compress_equity) fits without falling back to stride
// decimation -- so every daily-lock trigger bar is guaranteed present, not
// just the breach bar (which the backend always protects regardless).
const RISK_EQUITY_MAX_POINTS = 30000


// Visualization buckets against the MLL's cushion, not a prop rule itself.
// "Close" is the muted base token -- a quiet middle bucket that adds no
// extra semantic hue beyond positive/negative (DESIGN_LANGUAGE s2).
function riskColor(d: DailyRiskPoint, positive: string, negative: string, warning: string): string {
  if (d.breached) return negative
  if (d.min_distance_to_mll_usd <= 200) return negative
  if (d.min_distance_to_mll_usd <= 750) return warning
  return positive
}

// A standalone dockable panel: the MLL/daily-loss/breach view + day strip.
export default function RiskPanel({ containerApi }: IDockviewPanelProps) {
  const runId = useUiStore((s) => s.selectedRunId)
  const jumpToTradingDay = useUiStore((s) => s.jumpToTradingDay)
  const chartRef = useRef<RiskChartHandle>(null)
  const colors = useThemeStore((s) => s.colors)
  const base = useThemeBase()

  const { data: run } = useRun(runId)
  const { data: equity } = useEquity(runId, RISK_EQUITY_MAX_POINTS)
  const { data: dailyRisk } = useDailyRisk(runId)

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  // FXR_SPEC.md phase F6: the MLL / daily-loss / target view is the prop
  // rule engine's output -- a manual session only has one if it ran under a
  // ruleset (and a pooled all-sessions scope has no single account to judge).
  if (run?.source === 'manual' && !run.prop_ruleset) {
    return (
      <EmptyState
        title="No prop ruleset on this scope"
        hint={
          run.session_ids && run.session_ids.length > 1
            ? 'Prop risk is per account. Open a single Topstep session from the Sessions list.'
            : 'Start a session with "Topstep $50k Combine rules" to see the trailing MLL, daily loss floor and profit target here.'
        }
      />
    )
  }

  // POLISH_ROADMAP Phase P6 / DESIGN_AUDIT.md P1: skeleton while EITHER
  // fetch is still in flight, not just while BOTH are -- this was `&&`,
  // which meant a fast dailyRisk response (small payload) let the panel
  // fall through to the real render while the much larger equity fetch
  // (max_points up to 30000) was still pending, showing an empty legend +
  // blank chart + empty day-strip for several seconds instead of this
  // skeleton. Confirmed live: the equity fetch alone measured 2-4.6s.
  if (equity === undefined || dailyRisk === undefined) {
    return (
      <div className="flex h-full w-full flex-col gap-3 p-4">
        <Skeleton className="h-6" />
        <Skeleton className="min-h-0 flex-1" />
        <Skeleton className="h-10" />
      </div>
    )
  }

  const breachDay = dailyRisk?.find((d) => d.breached) ?? null

  const jumpToDay = (tradingDay: string) => {
    jumpToTradingDay(tradingDay)
    containerApi.getPanel(CHART_PANEL_ID)?.api.setActive()
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-4 px-4 py-2 text-xs text-text-muted">
        <Legend swatch={colors.accent} label="Equity" line />
        <Legend swatch={colors.negative} label="Trailing MLL floor" dashed />
        <Legend swatch={base.textMuted} label="Daily loss floor" dotted />
        <Legend swatch={colors.positive} label="Profit target" dashed />
        <Legend swatch={hexToRgba(colors.negative, 0.35)} label="Distance-to-breach band" />
        {breachDay && (
          <span className="ml-auto text-negative">
            Breached {breachDay.trading_day} (<span className="tabular-nums">{fmtUsd(breachDay.min_distance_to_mll_usd)}</span>)
          </span>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <RiskChart ref={chartRef} equity={equity ?? []} dailyRisk={dailyRisk ?? []} fitOnData={run?.source === 'manual'} />
        <span className="pointer-events-none absolute bottom-1 right-2 z-10 text-[11px] font-medium tracking-wide text-text-muted">ET</span>
      </div>

      <div className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
          <span title="Click a day to jump the chart">Daily risk – worst distance to MLL each trading day</span>
          <div className="flex items-center gap-3">
            <Legend swatch={colors.positive} label="Safe" small />
            <Legend swatch={base.textMuted} label="Close" small />
            <Legend swatch={colors.negative} label="Breach / near-breach" small />
          </div>
        </div>
        <div className="flex h-4 w-full gap-px overflow-hidden rounded">
          {(dailyRisk ?? []).map((d) => (
            <button
              key={d.trading_day}
              onClick={() => jumpToDay(d.trading_day)}
              title={`${d.trading_day} – min distance to MLL: ${fmtUsd(d.min_distance_to_mll_usd)}${
                d.daily_locked ? ' – daily loss lock triggered' : ''
              }${d.breached ? ' – BREACHED' : ''} – ${d.trades} trade${d.trades === 1 ? '' : 's'}`}
              className="relative min-w-1 flex-1 cursor-pointer transition-opacity hover:opacity-75"
              style={{ background: hexToRgba(riskColor(d, colors.positive, colors.negative, base.textMuted), 0.5) }}
            >
              {d.daily_locked && (
                <span className="absolute inset-x-0 top-0 h-1 bg-text-muted" title="Daily loss lock triggered" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Legend({
  swatch,
  label,
  line,
  dashed,
  dotted,
  small,
}: {
  swatch: string
  label: string
  line?: boolean
  dashed?: boolean
  dotted?: boolean
  small?: boolean
}) {
  return (
    <span className="flex items-center gap-1">
      <span
        className={small ? 'inline-block h-2 w-2 rounded-sm' : 'inline-block h-0.5 w-4'}
        style={{
          background: line || small ? swatch : 'transparent',
          borderTop: !line && !small ? `2px ${dashed ? 'dashed' : dotted ? 'dotted' : 'solid'} ${swatch}` : undefined,
        }}
      />
      {label}
    </span>
  )
}
