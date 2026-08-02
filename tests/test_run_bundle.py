from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules
from propbt.data.sessions import tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.engine.events import FillType, Side
from propbt.reporting.metrics import Trade, pair_trades
from propbt.reporting.run_bundle import (
    _mae_mfe,
    build_equity_frame,
    build_trades_frame,
    compute_run_stats,
    generate_run_id,
    hash_config_file,
    list_run_ids,
    read_equity,
    read_meta,
    read_stats,
    read_trades,
    write_run_bundle,
)
from propbt.strategy.session_open import ContinuationConfig, SessionOpenContinuation
from tests.conftest import make_ohlcv
from tests.test_session_open import ny_bars, sessions_cfg  # noqa: F401 -- reuse fixture/helper


# --- a scenario with hand-computed MAE/MFE ------------------------------

MAE_MFE_BARS = [
    (-1, 5000, 5000, 5000, 5000),   # fair value
    (0, 5000, 5002, 4999, 5005),    # decision bar: LONG (close 5005 > fair value 5000)
    (1, 5006, 5008, 5004, 5007),    # entry fills at open=5006; SL=4996, TP=5021
    (2, 5007, 5009, 4997, 5001),    # dips to 4997 (adverse, but above SL) then partial recovery
    (3, 5001, 5025, 5000, 5020),    # high 5025 breaches TP -> exits at 5021 exactly
]


@pytest.fixture
def mae_mfe_setup(sessions_cfg):
    df = ny_bars("2025-03-11", MAE_MFE_BARS)
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.5)
    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)
    session_by_ts = tag_sessions(df, sessions_cfg)["session"]
    trades = pair_trades(result.fills, session_by_ts)
    return df, result, trades, contracts, prop_cfg


def test_mae_mfe_hand_computed_values(mae_mfe_setup):
    df, result, trades, _, _ = mae_mfe_setup
    assert len(trades) == 1
    t = trades[0]
    assert t.entry_price == 5006
    assert t.sl_price == 4996

    mae_points, mfe_points, mae_r, mfe_r, bars_held = _mae_mfe(df, t)
    # window = bars 1,2,3 (entry through exit): lows [5004,4997,5000] -> min 4997; highs [5008,5009,5025] -> max 5025
    assert mae_points == pytest.approx(5006 - 4997)   # 9
    assert mfe_points == pytest.approx(5025 - 5006)   # 19
    assert mae_r == pytest.approx(9 / 10)
    assert mfe_r == pytest.approx(19 / 10)
    assert bars_held == 3


def test_mae_mfe_short_side():
    idx = pd.date_range("2025-03-11 14:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 100, 100], [103, 106, 101], [98, 95, 97], [100, 96, 98], [1, 1, 1])
    trade = Trade(
        symbol="MES", side=Side.SHORT, contracts=1,
        entry_ts=idx[0], entry_price=100.0, exit_ts=idx[2], exit_price=98.0,
        exit_type=FillType.TAKE_PROFIT, commission=0.0, realized_pnl=10.0,
        session="ny", leg="continuation", risk_dollars=50.0, sl_price=105.0, tp_price=95.0,
    )
    mae_points, mfe_points, mae_r, mfe_r, bars_held = _mae_mfe(df, trade)
    # short: adverse = price rising above entry -> max high (106) - entry (100) = 6
    # favorable = price falling below entry -> entry (100) - min low (95) = 5
    assert mae_points == pytest.approx(6.0)
    assert mfe_points == pytest.approx(5.0)
    assert mae_r == pytest.approx(6.0 / 5.0)   # risk_points = |100-105| = 5
    assert mfe_r == pytest.approx(5.0 / 5.0)
    assert bars_held == 3


def test_mae_mfe_no_sl_gives_none_r():
    idx = pd.date_range("2025-03-11 14:00", periods=2, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 100], [102, 103], [99, 98], [100, 100], [1, 1])
    trade = Trade(
        symbol="MES", side=Side.LONG, contracts=1,
        entry_ts=idx[0], entry_price=100.0, exit_ts=idx[1], exit_price=100.0,
        exit_type=FillType.DAILY_LOCK_FLATTEN, commission=0.0, realized_pnl=0.0,
        session="ny", leg="continuation", risk_dollars=None, sl_price=None, tp_price=None,
    )
    _, _, mae_r, mfe_r, _ = _mae_mfe(df, trade)
    assert mae_r is None
    assert mfe_r is None


# --- build_trades_frame: no divergence from the in-memory trades ------------

def test_build_trades_frame_matches_in_memory_trades_exactly(mae_mfe_setup, sessions_cfg):
    df, result, trades, contracts, prop_cfg = mae_mfe_setup
    trades_df = build_trades_frame(trades, df, "MES", sessions_cfg)

    assert len(trades_df) == len(trades) == 1
    row = trades_df.iloc[0]
    t = trades[0]

    assert row["entry_time"] == t.entry_ts
    assert row["exit_time"] == t.exit_ts
    assert row["side"] == t.side.value
    assert row["leg"] == t.leg
    assert row["entry_price"] == t.entry_price
    assert row["exit_price"] == t.exit_price
    assert row["sl_price"] == t.sl_price
    assert row["tp_price"] == t.tp_price
    assert row["pnl_usd"] == pytest.approx(t.realized_pnl)
    assert row["r_multiple"] == pytest.approx(t.r_multiple)
    assert row["commission_usd"] == pytest.approx(t.commission)
    assert row["size_contracts"] == t.contracts
    assert row["exit_type"] == "tp"  # FillType.TAKE_PROFIT -> "tp"


def test_build_trades_frame_empty_has_correct_columns(sessions_cfg):
    from propbt.reporting.run_bundle import TRADE_COLUMNS
    df = build_trades_frame([], pd.DataFrame(), "MES", sessions_cfg)
    assert list(df.columns) == TRADE_COLUMNS
    assert len(df) == 0


def test_news_leg_trades_get_session_news(sessions_cfg):
    idx = pd.date_range("2025-03-11 14:00", periods=1, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100], [101], [99], [100], [1])
    trade = Trade(
        symbol="MES", side=Side.LONG, contracts=1,
        entry_ts=idx[0], entry_price=100.0, exit_ts=idx[0], exit_price=100.0,
        exit_type=FillType.TAKE_PROFIT, commission=0.0, realized_pnl=0.0,
        session="ny", leg="news_continuation", risk_dollars=None, sl_price=None, tp_price=None,
    )
    trades_df = build_trades_frame([trade], df, "MES", sessions_cfg)
    assert trades_df.iloc[0]["session"] == "news"
    assert trades_df.iloc[0]["leg"] == "news_continuation"  # leg itself untouched


# --- build_equity_frame ------------------------------------------------------

def test_build_equity_frame_derives_open_pnl_and_floors(mae_mfe_setup):
    df, result, trades, contracts, prop_cfg = mae_mfe_setup
    equity_df = build_equity_frame(result.equity_log, prop_cfg)

    assert len(equity_df) == len(result.equity_log) > 0
    row0 = equity_df.iloc[0]
    log0 = result.equity_log[0]
    assert row0["balance"] == log0.balance
    assert row0["equity"] == log0.equity
    assert row0["open_pnl"] == pytest.approx(log0.equity - log0.balance)
    assert row0["mll_floor"] == log0.mll_floor
    assert row0["daily_loss_floor"] == pytest.approx(log0.day_start_balance - prop_cfg.daily_loss_limit)
    assert row0["target_level"] == pytest.approx(prop_cfg.start_balance + prop_cfg.profit_target)
    assert bool(row0["breached"]) == log0.breached
    assert bool(row0["daily_locked"]) == log0.daily_locked


def test_equity_log_does_not_change_existing_equity_curve(mae_mfe_setup):
    """The additive equity_log field must not alter the pre-existing
    equity_curve/fills/combine results (VIZ_SPEC: don't touch strategy
    logic or change backtest results)."""
    df, result, trades, contracts, prop_cfg = mae_mfe_setup
    assert len(result.equity_curve) == len(result.equity_log)
    for (ts_a, eq_a), log_row in zip(result.equity_curve, result.equity_log):
        assert ts_a == log_row.ts
        assert eq_a == log_row.equity
    assert result.combine.status == "passed" or result.combine.status == "incomplete"


# --- stats -------------------------------------------------------------------

def test_compute_run_stats_overall_and_breakdowns(mae_mfe_setup, sessions_cfg):
    df, result, trades, contracts, prop_cfg = mae_mfe_setup
    trades_df = build_trades_frame(trades, df, "MES", sessions_cfg)
    stats = compute_run_stats(trades_df, result.combine)

    assert stats["overall"]["trades"] == 1
    assert stats["overall"]["net_pnl_usd"] == pytest.approx(trades[0].realized_pnl)
    assert stats["overall"]["win_rate"] == 1.0
    assert "continuation" in stats["by_leg"]
    assert stats["by_leg"]["continuation"]["trades"] == 1
    assert "ny" in stats["by_session"]
    assert stats["result"]["status"] == result.combine.status


def test_compute_run_stats_empty_trades():
    from propbt.reporting.run_bundle import TRADE_COLUMNS
    empty = pd.DataFrame(columns=TRADE_COLUMNS)
    stats = compute_run_stats(empty)
    assert stats["overall"]["trades"] == 0
    assert stats["overall"]["win_rate"] is None
    assert stats["by_leg"] == {}


# --- write_run_bundle / read_* round trip + no-divergence -------------------

def test_write_and_read_bundle_round_trip(mae_mfe_setup, sessions_cfg, tmp_path):
    df, result, trades, contracts, prop_cfg = mae_mfe_setup
    from propbt.strategy.session_open import SessionOpenRunConfig, ContinuationConfig as CC

    config_path = tmp_path / "fake_strategy.yaml"
    config_path.write_text("symbol: MES\n", encoding="utf-8")
    run_cfg = SessionOpenRunConfig(
        symbol="MES", start="2025-03-11", end="2025-03-11",
        continuation=CC(sessions=("ny",), direction_method="close_vs_fair_value",
                         observation_window_minutes=1, contracts=1, sl_points=10, rr=1.5),
        mean_reversion=None,
    )

    meta = write_run_bundle(
        result, trades, df, "MES", sessions_cfg, prop_cfg,
        config_path=config_path, run_cfg=run_cfg, news_cfg=None,
        is_oos_split_date="2025-06-01", runs_dir=tmp_path / "runs",
    )

    runs_dir = tmp_path / "runs"
    assert meta.run_id in list_run_ids(runs_dir)

    meta_dict = read_meta(meta.run_id, runs_dir)
    assert meta_dict["instrument"] == "MES"
    assert meta_dict["is_oos_split_date"] == "2025-06-01"
    assert meta_dict["result"]["passed"] == (result.combine.status == "passed")
    assert meta_dict["params_count"] > 0

    trades_read = read_trades(meta.run_id, runs_dir)
    assert len(trades_read) == len(trades)
    # NO DIVERGENCE: re-derive trades fresh from the in-memory fills and
    # compare against what got persisted -- must match exactly.
    assert trades_read.iloc[0]["entry_price"] == trades[0].entry_price
    assert trades_read.iloc[0]["exit_price"] == trades[0].exit_price
    assert trades_read.iloc[0]["pnl_usd"] == pytest.approx(trades[0].realized_pnl)
    assert trades_read.iloc[0]["r_multiple"] == pytest.approx(trades[0].r_multiple)
    assert pd.Timestamp(trades_read.iloc[0]["entry_time"]) == trades[0].entry_ts
    assert pd.Timestamp(trades_read.iloc[0]["exit_time"]) == trades[0].exit_ts

    equity_read = read_equity(meta.run_id, runs_dir)
    assert len(equity_read) == len(result.equity_log)

    stats_read = read_stats(meta.run_id, runs_dir)
    assert stats_read["overall"]["trades"] == 1


def test_write_run_bundle_run_id_stable_for_same_config_content(tmp_path):
    config_path = tmp_path / "strategy.yaml"
    config_path.write_text("symbol: MES\n", encoding="utf-8")
    h1 = hash_config_file(config_path)
    h2 = hash_config_file(config_path)
    assert h1 == h2
    run_id = generate_run_id(h1)
    assert h1[:8] in run_id


def test_list_run_ids_empty_when_no_runs_dir(tmp_path):
    assert list_run_ids(tmp_path / "does_not_exist") == []
