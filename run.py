"""CLI entry point. `python run.py --help` for commands."""
from __future__ import annotations

import datetime as dt
from typing import List

import typer

from propbt.config import load_contracts, load_execution, load_prop_rules, load_sessions
from propbt.data.loader import compute_integrity_report, estimate_roll_days, load_ohlcv
from propbt.data.sessions import fair_value, session_anchor_utc, session_windows, tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades, summarize
from propbt.reporting.plots import save_evaluation_plots
from propbt.sim.config import load_evaluate_config
from propbt.sim.walk_forward import run_walk_forward
from propbt.strategy.combined import build_combined_strategy_factory
from propbt.strategy.news_spike import load_news_spike_config
from propbt.strategy.session_open import load_session_open_config

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
    config: str = typer.Option(..., "--config", help="Path to a strategy run config, e.g. propbt/config/strategy.yaml"),
) -> None:
    """Run whichever legs are enabled in the config -- session-open
    (continuation and/or mean-reversion) and/or news-spike (continuation
    and/or mean-reversion around high-impact events) -- over the configured
    date range and print trade count, win rate, expectancy ($ and R),
    per-session and per-leg breakdowns, and the Topstep Combine result."""
    run_cfg = load_session_open_config(config)
    news_cfg = load_news_spike_config(config)
    symbol = run_cfg.symbol

    contracts = load_contracts()
    if symbol not in contracts:
        typer.echo(f"Unknown symbol {symbol!r}. Known: {sorted(contracts)}")
        raise typer.Exit(code=1)
    if run_cfg.continuation is None and run_cfg.mean_reversion is None and news_cfg is None:
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

    strategy = build_combined_strategy_factory(
        run_cfg, sessions_cfg, news_cfg, news_start=run_cfg.start, news_end=run_cfg.end,
    )()

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
    if news_cfg is not None and news_cfg.continuation is not None:
        nc = news_cfg.continuation
        risk_dollars_by_leg["news_continuation"] = nc.sl_points * spec.point_value * nc.contracts
    if news_cfg is not None and news_cfg.mean_reversion is not None:
        nm = news_cfg.mean_reversion
        risk_dollars_by_leg["news_mean_reversion"] = nm.sl_points * spec.point_value * nm.contracts

    trades = pair_trades(result.fills, session_by_ts, risk_dollars_by_leg)
    summary = summarize(trades, result.combine)

    typer.echo(f"=== Session-open + news-spike backtest: {symbol}  {run_cfg.start} -> {run_cfg.end} ===")
    typer.echo(f"config: {config}")
    if run_cfg.continuation is not None:
        cc = run_cfg.continuation
        typer.echo(
            f"continuation:       sessions={list(cc.sessions)} method={cc.direction_method} "
            f"window={cc.observation_window_minutes}min sl={cc.sl_points}pt rr={cc.rr} "
            f"(tp={cc.tp_points}pt) contracts={cc.contracts}"
        )
    if run_cfg.mean_reversion is not None:
        mc = run_cfg.mean_reversion
        typer.echo(
            f"mean_reversion:     sessions={list(mc.sessions)} mode={mc.direction_mode} "
            f"max_trades={mc.max_trades_per_session} compression={mc.compression_method}"
            f"({mc.compression_lookback_bars}bars<={mc.compression_threshold_points}pt) "
            f"swing_w={mc.swing_lookback_bars} sl={mc.sl_points}pt rr={mc.rr} "
            f"(tp={mc.tp_points}pt) contracts={mc.contracts}"
        )
    if news_cfg is not None:
        typer.echo(
            f"news:               events={news_cfg.events_path.name} "
            f"high_impact_only={news_cfg.high_impact_only} impact_values={list(news_cfg.impact_values)} "
            f"window={news_cfg.event_window_minutes}min"
        )
        if news_cfg.continuation is not None:
            nc = news_cfg.continuation
            typer.echo(
                f"  news_continuation:   method={nc.direction_method} window={nc.observation_window_minutes}min "
                f"sl={nc.sl_points}pt rr={nc.rr} (tp={nc.tp_points}pt) contracts={nc.contracts}"
            )
        if news_cfg.mean_reversion is not None:
            nm = news_cfg.mean_reversion
            typer.echo(
                f"  news_mean_reversion: mode={nm.direction_mode} max_trades={nm.max_trades_per_event} "
                f"compression={nm.compression_method}({nm.compression_lookback_bars}bars<={nm.compression_threshold_points}pt) "
                f"swing_w={nm.swing_lookback_bars} sl={nm.sl_points}pt rr={nm.rr} "
                f"(tp={nm.tp_points}pt) contracts={nm.contracts}"
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


def _format_mc(mc, label: str) -> List[str]:
    lines = [f"--- {label} ---"]
    lines.append(f"  attempts: {mc.n_attempts}   passed: {mc.n_passed}   failed: {mc.n_failed}   incomplete: {mc.n_incomplete}")
    lines.append(f"  PASS RATE: {mc.pass_rate:.1%}   (of resolved attempts only: {mc.resolved_pass_rate:.1%})")
    if mc.days_to_pass:
        d = sorted(mc.days_to_pass)
        median = d[len(d) // 2]
        lines.append(f"  days-to-pass: min={min(d)} median={median} max={max(d)}  (n={len(d)})")
    else:
        lines.append("  days-to-pass: n/a (no passed attempts)")
    if mc.fail_reasons:
        reasons = ", ".join(f"{k}={v}" for k, v in mc.fail_reasons.items())
        lines.append(f"  fail reasons: {reasons}")
    return lines


@app.command()
def evaluate(
    config: str = typer.Option(..., "--config", help="Path to an evaluate config, e.g. propbt/config/evaluate.yaml"),
) -> None:
    """Monte Carlo + walk-forward evaluation (CLAUDE.md sections 6-7): a
    small in-sample parameter grid, robust-neighbor selection (not just
    best-single-point), then ONE evaluation of the selected config on the
    out-of-sample holdout -- which is always the headline number, printed
    clearly separated from (and after) the in-sample result it was chosen
    from. Commissions, slippage, and no-look-ahead are structurally always
    on (see engine/broker.py, engine/backtester.py) -- there is no "clean"
    mode to accidentally report instead."""
    eval_cfg = load_evaluate_config(config)
    run_cfg = load_session_open_config(eval_cfg.strategy_config_path)
    news_cfg = load_news_spike_config(eval_cfg.strategy_config_path)
    symbol = run_cfg.symbol

    contracts = load_contracts()
    if symbol not in contracts:
        typer.echo(f"Unknown symbol {symbol!r}. Known: {sorted(contracts)}")
        raise typer.Exit(code=1)

    prop_cfg = load_prop_rules()
    sessions_cfg = load_sessions()
    exec_cfg = load_execution()
    wf_cfg = eval_cfg.walk_forward
    mc_cfg = eval_cfg.monte_carlo

    df = load_ohlcv(symbol)

    typer.echo(f"=== Evaluate: {symbol} ===")
    typer.echo(f"strategy config: {eval_cfg.strategy_config_path}")
    typer.echo(f"in-sample:     {run_cfg.start} -> {run_cfg.end}")
    typer.echo(f"out-of-sample: {wf_cfg.out_of_sample_start} -> {wf_cfg.out_of_sample_end}  (never used for tuning)")
    typer.echo(
        f"frictions: commissions={dict(prop_cfg.commissions)}  slippage={exec_cfg.slippage_ticks} ticks  "
        f"no-look-ahead=structural (always on) -- CLAUDE.md section 7"
    )
    typer.echo(
        f"monte carlo: method={mc_cfg.method} stride_days={mc_cfg.stride_days} warmup_days={mc_cfg.warmup_days} "
        f"max_calendar_days={mc_cfg.max_calendar_days}"
    )
    typer.echo(
        f"grid: {wf_cfg.param_grid}  ({wf_cfg.n_attempts_per_grid_point} attempts/point in-sample, "
        f"{wf_cfg.n_attempts_out_of_sample} attempts out-of-sample)"
    )

    result = run_walk_forward(
        base_run_config=run_cfg, param_grid=wf_cfg.param_grid, df=df, symbol=symbol,
        contracts=contracts, prop_rules_config=prop_cfg, sessions_config=sessions_cfg,
        out_of_sample_start=wf_cfg.out_of_sample_start, out_of_sample_end=wf_cfg.out_of_sample_end,
        news_config=news_cfg, n_attempts_per_grid_point=wf_cfg.n_attempts_per_grid_point,
        n_attempts_out_of_sample=wf_cfg.n_attempts_out_of_sample, sample_method=mc_cfg.method,
        stride_days=mc_cfg.stride_days, seed=mc_cfg.seed, slippage_ticks=exec_cfg.slippage_ticks,
        warmup_days=mc_cfg.warmup_days, max_calendar_days=mc_cfg.max_calendar_days,
    )

    typer.echo("\n--- In-sample parameter grid (robust-neighbor scoring, CLAUDE.md section 7) ---")
    for point in result.grid:
        marker = " <== selected" if point.overrides == result.selected_overrides else ""
        typer.echo(
            f"  {point.overrides}  pass_rate={point.monte_carlo.pass_rate:.1%}  "
            f"robustness_score={point.robustness_score:.1%}{marker}"
        )

    typer.echo(f"\nselected config: {result.selected_overrides}")
    typer.echo(f"free parameters: {result.n_free_parameters}   in-sample trades backing it: {result.n_in_sample_trades}")
    if result.parameter_budget_warning:
        typer.echo(f"WARNING: {result.parameter_budget_warning}")

    typer.echo("")
    for line in _format_mc(result.in_sample, "IN-SAMPLE (selection basis -- not the headline number)"):
        typer.echo(line)
    typer.echo("")
    for line in _format_mc(result.out_of_sample, "OUT-OF-SAMPLE (HEADLINE NUMBER)"):
        typer.echo(line)

    representative_curve = None
    if result.out_of_sample.attempts:
        representative_curve = max(result.out_of_sample.attempts, key=lambda a: len(a.equity_curve)).equity_curve
    saved = save_evaluation_plots(
        result.in_sample, result.out_of_sample, eval_cfg.plots_dir,
        representative_equity_curve=representative_curve, start_balance=prop_cfg.start_balance,
    )
    typer.echo(f"\nplots saved to: {eval_cfg.plots_dir}")
    for p in saved:
        typer.echo(f"  {p.name}")


if __name__ == "__main__":
    app()
