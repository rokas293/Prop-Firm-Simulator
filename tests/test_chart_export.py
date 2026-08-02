from __future__ import annotations

import json
import re

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules
from propbt.engine.backtester import run_backtest
from propbt.reporting.chart_export import export_trade_review
from propbt.reporting.metrics import pair_trades, summarize
from propbt.strategy.session_open import ContinuationConfig, SessionOpenContinuation
from tests.test_session_open import sessions_cfg  # noqa: F401 -- reuse fixture
from tests.test_session_open import ny_bars


def _tp_trade_setup():
    """Same fixture shape as test_session_open.py's end-to-end TP test:
    one LONG continuation trade that fills at 5006 and takes profit at
    5021 (sl=10, rr=1.5 -> tp=15)."""
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5002, 4999, 5005),
        (1, 5006, 5008, 5004, 5007),
        (2, 5007, 5025, 5010, 5020),
        (3, 5020, 5021, 5015, 5018),
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.5)
    return df, cfg


def test_trade_carries_sl_tp_price(sessions_cfg):
    df, cfg = _tp_trade_setup()
    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)
    trades = pair_trades(result.fills)
    assert len(trades) == 1
    assert trades[0].sl_price == pytest.approx(5006 - 10)
    assert trades[0].tp_price == pytest.approx(5006 + 15)


def _extract_embedded_data(html: str) -> dict:
    m = re.search(r"const DATA = (\{.*?\});\n", html, re.DOTALL)
    assert m is not None, "embedded DATA blob not found in report HTML"
    return json.loads(m.group(1))


def test_export_trade_review_structure(sessions_cfg, tmp_path):
    df, cfg = _tp_trade_setup()
    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)
    trades = pair_trades(result.fills)
    summary = summarize(trades, result.combine)

    out = tmp_path / "review.html"
    path = export_trade_review(df, trades, "MES", sessions_cfg, out, start="2025-03-11", end="2025-03-11", summary=summary)

    assert path == out
    assert path.exists()
    html = path.read_text(encoding="utf-8")
    assert html.startswith("<!doctype html>")
    assert "</script>" in html
    assert "MES" in html

    data = _extract_embedded_data(html)
    assert len(data["trades"]) == 1
    t = data["trades"][0]
    assert t["side"] == "long"
    assert t["sl_price"] == pytest.approx(4996)
    assert t["tp_price"] == pytest.approx(5021)
    assert t["exit_type"] == "take_profit"
    assert t["leg"] == "continuation"

    assert len(data["days"]) == 1
    day_key = next(iter(data["days"]))
    bars = data["days"][day_key]["bars"]
    assert len(bars) == len(df)
    # bar format: [ts_ms, o, h, l, c, v]
    assert bars[0][1] == df.iloc[0]["open"]


def test_export_trade_review_with_no_trades_does_not_crash(sessions_cfg, tmp_path):
    df, _ = _tp_trade_setup()
    out = tmp_path / "empty_review.html"
    path = export_trade_review(df, [], "MES", sessions_cfg, out)
    html = path.read_text(encoding="utf-8")
    data = _extract_embedded_data(html)
    assert data["trades"] == []
    assert data["days"] == {}


def test_export_trade_review_creates_parent_dirs(sessions_cfg, tmp_path):
    df, _ = _tp_trade_setup()
    out = tmp_path / "nested" / "dir" / "review.html"
    path = export_trade_review(df, [], "MES", sessions_cfg, out)
    assert path.exists()


def test_summary_html_embedded_when_provided(sessions_cfg, tmp_path):
    df, cfg = _tp_trade_setup()
    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)
    trades = pair_trades(result.fills)
    summary = summarize(trades, result.combine)

    out = tmp_path / "review.html"
    path = export_trade_review(df, trades, "MES", sessions_cfg, out, summary=summary)
    html = path.read_text(encoding="utf-8")
    assert "Overall" in html
    assert "leg: continuation" in html
