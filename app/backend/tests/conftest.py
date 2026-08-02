"""Backend test fixtures: build a small, deterministic run bundle with the
real engine (not hand-rolled JSON) so endpoint tests exercise the real
read path, then point PROPBT_RUNS_DIR at it.
"""
from __future__ import annotations

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from propbt.config import load_contracts, load_prop_rules, load_sessions
from propbt.data.sessions import tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades
from propbt.reporting.run_bundle import write_run_bundle
from propbt.strategy.session_open import ContinuationConfig, SessionOpenContinuation, SessionOpenRunConfig

# Same deterministic scenario as tests/test_run_bundle.py's mae_mfe_setup:
# LONG continuation trade, entry 5006, dips to 4997 (above the 4996 SL),
# then TP at 5021 exactly. Hand-verified: mae_points=9, mfe_points=19,
# pnl_usd = (5021-5006)*5*1 - commission = 75 - 1.30 = 73.70, r_multiple = 73.70/50 = 1.474.
KNOWN_BARS = [
    (-1, 5000, 5000, 5000, 5000),
    (0, 5000, 5002, 4999, 5005),
    (1, 5006, 5008, 5004, 5007),
    (2, 5007, 5009, 4997, 5001),
    (3, 5001, 5025, 5000, 5020),
]


def _make_ohlcv(idx, opens, highs, lows, closes, volumes) -> pd.DataFrame:
    df_idx = pd.DatetimeIndex(idx, name="ts_event", tz="UTC")
    return pd.DataFrame(
        {
            "open": pd.array(opens, dtype="float64"), "high": pd.array(highs, dtype="float64"),
            "low": pd.array(lows, dtype="float64"), "close": pd.array(closes, dtype="float64"),
            "volume": pd.array(volumes, dtype="uint64"),
        },
        index=df_idx,
    )


def _known_bars_df(day: str = "2025-03-11") -> pd.DataFrame:
    base = pd.Timestamp(f"{day} 13:30:00", tz="UTC")
    idx = [base + pd.Timedelta(minutes=m) for m, *_ in KNOWN_BARS]
    opens = [o for _, o, h, l, c in KNOWN_BARS]
    highs = [h for _, o, h, l, c in KNOWN_BARS]
    lows = [l for _, o, h, l, c in KNOWN_BARS]
    closes = [c for _, o, h, l, c in KNOWN_BARS]
    volumes = [100] * len(idx)
    return _make_ohlcv(idx, opens, highs, lows, closes, volumes)


@pytest.fixture(scope="session")
def known_trade_run(tmp_path_factory):
    """Writes one real run bundle from a hand-verified scenario. Returns
    (run_id, runs_dir, price_df) for tests to assert against."""
    runs_dir = tmp_path_factory.mktemp("runs")
    config_dir = tmp_path_factory.mktemp("config")

    df = _known_bars_df()
    sessions_cfg = load_sessions()
    contracts = load_contracts()
    prop_cfg = load_prop_rules()

    cont_cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                                   observation_window_minutes=1, contracts=1, sl_points=10, rr=1.5)
    strategy = SessionOpenContinuation(cont_cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)
    session_by_ts = tag_sessions(df, sessions_cfg)["session"]
    trades = pair_trades(result.fills, session_by_ts, {"continuation": 10 * contracts["MES"].point_value})

    config_path = config_dir / "fixture_strategy.yaml"
    config_path.write_text("symbol: MES\n# fixture config for backend tests\n", encoding="utf-8")
    run_cfg = SessionOpenRunConfig(symbol="MES", start="2025-03-11", end="2025-03-11",
                                    continuation=cont_cfg, mean_reversion=None)

    meta = write_run_bundle(
        result, trades, df, "MES", sessions_cfg, prop_cfg,
        config_path=config_path, run_cfg=run_cfg, news_cfg=None,
        is_oos_split_date="2025-06-01", runs_dir=runs_dir, config_name="fixture",
    )
    return meta.run_id, runs_dir, df


@pytest.fixture()
def client(known_trade_run, monkeypatch):
    run_id, runs_dir, _ = known_trade_run
    monkeypatch.setenv("PROPBT_RUNS_DIR", str(runs_dir))
    from app.backend.main import app
    return TestClient(app)
