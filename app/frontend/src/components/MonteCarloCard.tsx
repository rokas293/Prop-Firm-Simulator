import { useMemo, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useMonteCarlo } from '../api/hooks'
import type { TradeQueryParams } from '../state/tradeStore'
import { useThemeStore } from '../state/themeStore'
import { actualRankBand, fanRows } from '../compass/monteCarlo'
import { fmtPct, fmtUsd, fmtUsdWhole } from '../format'
import { AXIS_TICK_STYLE, AXIS_LINE_STYLE, TOOLTIP_CONTENT_STYLE } from '../chart/rechartsTheme'
import Card from './Card'
import MiniStat from './MiniStat'
import Skeleton from './Skeleton'

const N_SIMS = 1000
type Method = 'bootstrap' | 'shuffle'
const METHODS: { key: Method; label: string; hint: string }[] = [
  { key: 'bootstrap', label: 'Resample', hint: 'Draws the same number of trades with replacement: terminal P&L varies.' },
  { key: 'shuffle', label: 'Reorder', hint: 'Shuffles the same trades: terminal P&L is fixed, only the path and drawdown vary.' },
]

// FXR_SPEC.md section D, phase F6: "reuse the engine's Monte Carlo over the
// manual trade sequence". The distribution is computed server-side by
// propbt.sim.monte_carlo.run_trade_sequence_monte_carlo; this only draws it.
// (The engine's other Monte Carlo -- Combine attempts from many start dates --
// needs a strategy to re-run, which a fixed trade list does not have.)
export default function MonteCarloCard({ runId, filters }: { runId: string; filters?: TradeQueryParams }) {
  const [method, setMethod] = useState<Method>('bootstrap')
  const [seed, setSeed] = useState(0)
  const colors = useThemeStore((s) => s.colors)
  const params = useMemo(() => ({ method, n_sims: N_SIMS, seed, ...filters }), [method, seed, filters])
  const { data: mc, isLoading, isError } = useMonteCarlo(runId, params)
  const rows = useMemo(() => (mc ? fanRows(mc) : []), [mc])

  return (
    <Card title="Monte Carlo -- resampled trade sequence">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {METHODS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMethod(m.key)}
            aria-pressed={method === m.key}
            title={m.hint}
            className={`h-7 rounded px-3 text-xs ${
              method === m.key ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            {m.label}
          </button>
        ))}
        <button
          onClick={() => setSeed((s) => s + 1)}
          title="Re-run with a different random seed (the same seed always returns the same distribution)"
          className="h-7 rounded px-3 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
        >
          New seed
        </button>
        <span className="ml-auto text-[11px] tabular-nums text-text-muted">
          {mc ? `${mc.n_trades} trades × ${mc.n_sims.toLocaleString()} sims · seed ${mc.seed}` : ''}
        </span>
      </div>

      {isLoading && <Skeleton className="h-[240px]" />}
      {isError && (
        <p className="py-8 text-center text-xs text-text-muted">
          Nothing to simulate -- this scope has no trades (check the active filters).
        </p>
      )}

      {mc && (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
              <XAxis
                dataKey="trade"
                minTickGap={16}
                tick={AXIS_TICK_STYLE}
                axisLine={AXIS_LINE_STYLE}
                tickLine={AXIS_LINE_STYLE}
                label={{ value: 'Trade #', position: 'insideBottom', offset: -5, fill: 'var(--color-text-muted)', fontSize: 11 }}
              />
              <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} tickFormatter={(v) => fmtUsdWhole(Number(v))} />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelFormatter={(t) => `After trade ${t}`}
                formatter={(v, name) => [Array.isArray(v) ? `${fmtUsd(v[0])} to ${fmtUsd(v[1])}` : fmtUsd(Number(v)), String(name)]}
              />
              <ReferenceLine y={0} stroke="var(--color-border)" />
              {/* Neutral bands (not the accent): the realized line is the one
                  thing on this chart that gets the accent. */}
              <Area dataKey="band90" name="5th-95th pct" stroke="none" fill="var(--color-text-muted)" fillOpacity={0.12} isAnimationActive={false} />
              <Area dataKey="band50" name="25th-75th pct" stroke="none" fill="var(--color-text-muted)" fillOpacity={0.2} isAnimationActive={false} />
              <Line dataKey="median" name="Median" stroke="var(--color-text-muted)" strokeDasharray="4 3" strokeWidth={1} dot={false} isAnimationActive={false} />
              <Line dataKey="actual" name="Realized" stroke={colors.accent} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-1 flex flex-wrap items-center gap-4 text-[11px] text-text-muted">
            <span>Shaded: middle 90% and 50% of simulated paths</span>
            <span>Dashed: median</span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-4" style={{ background: colors.accent }} /> Realized sequence
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Median final P&L" value={fmtUsd(mc.final_pnl_pct['50'])} accent={mc.final_pnl_pct['50'] >= 0} />
            <MiniStat label="5th pct final" value={fmtUsd(mc.final_pnl_pct['5'])} accent={mc.final_pnl_pct['5'] >= 0} />
            <MiniStat label="95th pct final" value={fmtUsd(mc.final_pnl_pct['95'])} accent={mc.final_pnl_pct['95'] >= 0} />
            <MiniStat label="Realized final" value={fmtUsd(mc.actual_final_pnl)} accent={mc.actual_final_pnl >= 0} />
            <MiniStat label="Median max drawdown" value={fmtUsd(mc.max_drawdown_pct['50'])} />
            <MiniStat label="95th pct drawdown" value={fmtUsd(mc.max_drawdown_pct['95'])} />
            <MiniStat label="P(profit)" value={fmtPct(mc.prob_profit)} />
            <MiniStat label={`P(drawdown ≥ ${fmtUsd(mc.drawdown_budget_usd)})`} value={fmtPct(mc.prob_drawdown_breach)} />
          </div>
          <p className="mt-3 text-[11px] text-text-muted">
            The realized final P&amp;L ({fmtUsd(mc.actual_final_pnl)}) sits {actualRankBand(mc)} of the simulated outcomes; its own
            max drawdown was {fmtUsd(mc.actual_max_drawdown)}. Resamples the per-trade P&amp;L only -- it assumes trades are
            independent and the sample is representative, and it is not a Combine-attempt simulation.
          </p>
        </>
      )}
    </Card>
  )
}
