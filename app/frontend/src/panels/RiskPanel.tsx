import { useRef } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import RiskChart, { type RiskChartHandle } from '../chart/RiskChart'
import { useDailyRisk, useEquity } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { CHART_PANEL_ID } from '../workspace/panelIds'
import EmptyState from '../components/EmptyState'
import { useThemeStore } from '../state/themeStore'
import type { DailyRiskPoint } from '../api/types'

// High enough that a multi-year run's change-detection-compressed equity
// (see bundle_reader._compress_equity) fits without falling back to stride
// decimation -- so every daily-lock trigger bar is guaranteed present, not
// just the breach bar (which the backend always protects regardless).
const RISK_EQUITY_MAX_POINTS = 30000

function fmtUsd(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// Visualization buckets against the MLL's cushion, not a prop rule itself.
// "Close" stays a fixed amber caution color -- see RiskChart.tsx's own
// DAILY_LOSS_COLOR/LOCK_COLOR comment (POLISH_ROADMAP Phase P6).
function riskColor(d: DailyRiskPoint, up: string, down: string): string {
  if (d.breached) return down
  if (d.min_distance_to_mll_usd <= 200) return down
  if (d.min_distance_to_mll_usd <= 750) return '#d29922'
  return up
}

// A standalone dockable panel: the MLL/daily-loss/breach view + day strip.
export default function RiskPanel({ containerApi }: IDockviewPanelProps) {
  const runId = useUiStore((s) => s.selectedRunId)
  const jumpToTradingDay = useUiStore((s) => s.jumpToTradingDay)
  const chartRef = useRef<RiskChartHandle>(null)
  const colors = useThemeStore((s) => s.colors)

  const { data: equity } = useEquity(runId, RISK_EQUITY_MAX_POINTS)
  const { data: dailyRisk } = useDailyRisk(runId)

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  const breachDay = dailyRisk?.find((d) => d.breached) ?? null

  const jumpToDay = (tradingDay: string) => {
    jumpToTradingDay(tradingDay)
    containerApi.getPanel(CHART_PANEL_ID)?.api.setActive()
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <Legend swatch={colors.accent} label="Equity" line />
        <Legend swatch={colors.down} label="Trailing MLL floor" dashed />
        <Legend swatch="#d29922" label="Daily loss floor" dotted />
        <Legend swatch={colors.up} label="Profit target" dashed />
        <Legend swatch={`${colors.down}59`} label="Distance-to-breach band" />
        {breachDay && (
          <span className="ml-auto text-accent-red">
            Breached {breachDay.trading_day} ({fmtUsd(breachDay.min_distance_to_mll_usd)})
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <RiskChart ref={chartRef} equity={equity ?? []} dailyRisk={dailyRisk ?? []} />
      </div>

      <div className="border-t border-neutral-800 px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-500">
          <span>Daily risk -- worst distance to MLL each trading day (click a day to jump the chart)</span>
          <div className="flex items-center gap-3">
            <Legend swatch={colors.up} label="Safe" small />
            <Legend swatch="#d29922" label="Close" small />
            <Legend swatch={colors.down} label="Breach / near-breach" small />
          </div>
        </div>
        <div className="flex h-10 w-full gap-px overflow-hidden rounded">
          {(dailyRisk ?? []).map((d) => (
            <button
              key={d.trading_day}
              onClick={() => jumpToDay(d.trading_day)}
              title={`${d.trading_day} -- min distance to MLL: ${fmtUsd(d.min_distance_to_mll_usd)}${
                d.daily_locked ? ' -- daily loss lock triggered' : ''
              }${d.breached ? ' -- BREACHED' : ''} -- ${d.trades} trade${d.trades === 1 ? '' : 's'}`}
              className="relative min-w-[3px] flex-1 cursor-pointer transition-opacity hover:opacity-75"
              style={{ background: riskColor(d, colors.up, colors.down) }}
            >
              {d.daily_locked && (
                <span className="absolute inset-x-0 top-0 h-1 bg-neutral-100" title="Daily loss lock triggered" />
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
    <span className="flex items-center gap-1.5">
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
