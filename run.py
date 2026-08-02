"""CLI entry point. `python run.py --help` for commands."""
from __future__ import annotations

import datetime as dt

import typer

from propbt.config import load_contracts, load_execution, load_prop_rules, load_sessions
from propbt.data.loader import compute_integrity_report, estimate_roll_days, load_ohlcv
from propbt.data.sessions import fair_value, session_anchor_utc, session_windows, tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades, summarize
from propbt.strategy.session_open import build_strategy, load_session_open_config

app = typer.Typer(add_completion=False)


@app.callback()
def _main() -> None:
    """propbt CLI. Run a subcommand, e.g. `inspect`."""


@app.command()
def inspect(
    symbol: str = typer.Option(..., "--symbol", help="MES, MNQ, or ZN"),
    date: str = typer.Option(..., "--date", help="Trading day, YYYY-MM-DD (America/New_York)"),
) -> None:
    """Print a trading day's session anchors, fair values, and a scoped
    data-integrity summary (gaps, duplicate timestamps, roll flags)."""
    contracts = load_contracts()
    sessions_cfg = load_sessions()
    if symbol not in contracts:
        typer.echo(f"Unknown symbol {symbol!r}. Known: {sorted(contracts)}")
        raise typer.Exit(code=1)

    target_day = dt.date.fromisoformat(date)
    df = load_ohlcv(symbol)

    spec = contracts[symbol]
    typer.echo(f"=== {symbol} -- trading day {target_day} ===")
    typer.echo(f"Contract spec: point_value=${spec.point_value}, tick_size={spec.tick_size}, "
               f"tick_value=${spec.tick_value}, micro={spec.is_micro}")

    typer.echo("\n--- Sessions & fair value ---")
    windows = session_windows(target_day, sessions_cfg)
    for name in sorted(sessions_cfg.anchors, key=lambda n: session_anchor_utc(target_day, n, sessions_cfg)):
        anchor_utc = session_anchor_utc(target_day, name, sessions_cfg)
        anchor_ny = anchor_utc.tz_convert(sessions_cfg.timezone)
        win_start, win_end = windows[name]
        fv = fair_value(df, anchor_utc)
        if fv is None:
            typer.echo(f"  {name:14s} anchor {anchor_ny} (UTC {anchor_utc})  -- no prior data")
            continue
        fv_ts, fv_close = fv
        typer.echo(
            f"  {name:14s} anchor {anchor_ny} (UTC {anchor_utc})\n"
            f"  {'':14s} fair value = {fv_close} (bar @ {fv_ts}, NY {fv_ts.tz_convert(sessions_cfg.timezone)})\n"
            f"  {'':14s} window     = {win_start} -> {win_end}"
        )

    typer.echo("\n--- Data integrity (this trading day only) ---")
    day_start = min(w[0] for w in windows.values())
    day_end = max(w[1] for w in windows.values())
    day_df = df.loc[(df.index >= day_start) & (df.index < day_end)]
    report = compute_integrity_report(day_df, symbol=symbol)
    typer.echo(f"  bars: {report.n_rows}")
    typer.echo(f"  duplicate timestamps: {report.n_duplicate_timestamps}")
    typer.echo(f"  monotonic: {report.is_monotonic}")
    typer.echo(
        f"  gaps: total={report.gaps.total} maintenance_halt={report.gaps.maintenance_halt} "
        f"weekend_holiday={report.gaps.weekend_holiday} other={report.gaps.other}"
    )
    if report.gaps.other > 0:
        typer.echo(f"    other gaps:\n{report.gaps.other_gaps.to_string()}")
    nulls = {k: v for k, v in report.n_nulls.items() if v > 0}
    typer.echo(f"  nulls: {nulls if nulls else 'none'}")
    typer.echo(
        f"  ohlc anomalies: high<low={report.n_bad_high_low} "
        f"high<max(o,c)={report.n_bad_high_open_close} low>min(o,c)={report.n_bad_low_open_close}"
    )

    typer.echo("\n--- Roll flags (ESTIMATED -- calendar heuristic, not ground truth) ---")
    roll_days = estimate_roll_days(df)
    nearby = [r for r in roll_days if abs((r.date() - target_day).days) <= 5]
    if nearby:
        typer.echo(f"  within 5 days of an estimated roll date: {[r.date().isoformat() for r in nearby]}")
    else:
        typer.echo("  no estimated roll date within 5 days")


@app.command()
def backtest(
    config: str = typer.Option(..., "--config", help="Path to a strategy run config, e.g. propbt/config/continuation.yaml"),
) -> None:
    """Run the session-open legs (continuation and/or mean-reversion, per
    which are enabled in the config) over the configured date range and
    print trade count, win rate, expectancy ($ and R), per-session and
    per-leg breakdowns, and the Topstep Combine result."""
    run_cfg = load_session_open_config(config)
    symbol = run_cfg.symbol

    contracts = load_contracts()
    if symbol not in contracts:
        typer.echo(f"Unknown symbol {symbol!r}. Known: {sorted(contracts)}")
        raise typer.Exit(code=1)
    if run_cfg.continuation is None and run_cfg.mean_reversion is None:
        typer.echo("No legs enabled in config -- nothing to run")
        raise typer.Exit(code=1)

    prop_cfg = load_prop_rules()
    sessions_cfg = load_sessions()
    exec_cfg = load_execution()

    df = load_ohlcv(symbol)
    sliced = df.loc[run_cfg.start: run_cfg.end]
    if len(sliced) == 0:
        typer.echo(f"No data in range {run_cfg.start} -> {run_cfg.end}")
        raise typer.Exit(code=1)

    session_by_ts = tag_sessions(sliced, sessions_cfg)["session"]

    strategy = build_strategy(run_cfg, sessions_cfg)
    result = run_backtest(
        sliced, symbol=symbol, strategy=strategy, contracts=contracts,
        prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=exec_cfg.slippage_ticks,
    )

    spec = contracts[symbol]
    risk_dollars_by_leg = {}
    if run_cfg.continuation is not None:
        cc = run_cfg.continuation
        risk_dollars_by_leg["continuation"] = cc.sl_points * spec.point_value * cc.contracts
    if run_cfg.mean_reversion is not None:
        mc = run_cfg.mean_reversion
        risk_dollars_by_leg["mean_reversion"] = mc.sl_points * spec.point_value * mc.contracts

    trades = pair_trades(result.fills, session_by_ts, risk_dollars_by_leg)
    summary = summarize(trades, result.combine)

    typer.echo(f"=== Session-open backtest: {symbol}  {run_cfg.start} -> {run_cfg.end} ===")
    typer.echo(f"config: {config}")
    if run_cfg.continuation is not None:
        cc = run_cfg.continuation
        typer.echo(
            f"continuation:    sessions={list(cc.sessions)} method={cc.direction_method} "
            f"window={cc.observation_window_minutes}min sl={cc.sl_points}pt rr={cc.rr} "
            f"(tp={cc.tp_points}pt) contracts={cc.contracts}"
        )
    if run_cfg.mean_reversion is not None:
        mc = run_cfg.mean_reversion
        typer.echo(
            f"mean_reversion:  sessions={list(mc.sessions)} mode={mc.direction_mode} "
            f"max_trades={mc.max_trades_per_session} compression={mc.compression_method}"
            f"({mc.compression_lookback_bars}bars<={mc.compression_threshold_points}pt) "
            f"swing_w={mc.swing_lookback_bars} sl={mc.sl_points}pt rr={mc.rr} "
            f"(tp={mc.tp_points}pt) contracts={mc.contracts}"
        )
    typer.echo(f"slippage={exec_cfg.slippage_ticks}ticks")

    o = summary.overall
    typer.echo("\n--- Overall ---")
    typer.echo(f"  trades: {o.n_trades}")
    if o.n_trades:
        typer.echo(f"  win rate: {o.win_rate:.1%}")
        typer.echo(f"  expectancy: ${o.expectancy_dollars:,.2f}  ({o.expectancy_r:.3f}R)")
    else:
        typer.echo("  win rate / expectancy: n/a (no trades)")

    typer.echo("\n--- Per-leg ---")
    if summary.by_leg:
        for name, s in summary.by_leg.items():
            typer.echo(
                f"  {name:16s} trades={s.n_trades:4d}  win_rate={s.win_rate:.1%}  "
                f"expectancy=${s.expectancy_dollars:,.2f} ({s.expectancy_r:.3f}R)"
            )
    else:
        typer.echo("  (no trades)")

    typer.echo("\n--- Per-session ---")
    if summary.by_session:
        for name, s in summary.by_session.items():
            typer.echo(
                f"  {name:8s} trades={s.n_trades:4d}  win_rate={s.win_rate:.1%}  "
                f"expectancy=${s.expectancy_dollars:,.2f} ({s.expectancy_r:.3f}R)"
            )
    else:
        typer.echo("  (no trades)")

    c = result.combine
    typer.echo("\n--- Topstep Combine result ---")
    typer.echo(f"  status: {c.status.upper()}" + (f"  reason={c.fail_reason}" if c.fail_reason else ""))
    typer.echo(f"  target_hit={c.target_hit}  consistency_passed={c.consistency_passed}")
    typer.echo(f"  final_balance=${c.final_balance:,.2f}")
    typer.echo(f"  trading days simulated: {len(c.day_logs)}")
    typer.echo(f"  order rejections: {len(result.rejections)}")


if __name__ == "__main__":
    app()
