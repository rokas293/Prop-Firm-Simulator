"""G10 refactor gate: the engine must reproduce the reference recorded before
`run_backtest`'s bar loop became a reusable stepper -- fills, rejections, paired
trades, per-bar equity log, run-bundle files and Combine verdicts, with exact
float equality (no tolerance). See tests/engine_golden.py.

`test_historical_run_bundle_reproduces` additionally replays the full default
backtest and compares it with a bundle written by the engine weeks earlier. It
reads `runs/` (git-ignored, so present only on the author's machine) and takes
a couple of minutes, so it is opt-in: PROPBT_SLOW=1.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pandas as pd
import pytest

from propbt.config import PROJECT_ROOT
from tests.engine_golden import CASES, FIXTURE_DIR, data_available, dumps, run_case

HISTORICAL_BUNDLE = PROJECT_ROOT / "runs" / "20260802T180304Z_6b373299"


def _assert_frames_identical(expected: pd.DataFrame, actual: pd.DataFrame, what: str) -> None:
    try:
        pd.testing.assert_frame_equal(expected, actual, check_exact=True)
    except AssertionError as e:  # name the artifact, keep pandas' pointer to the first differing cell
        raise AssertionError(f"{what} differs from the recorded reference:\n{e}") from None


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_engine_reproduces_recorded_reference(case):
    golden_path = FIXTURE_DIR / f"{case.name}.json"
    if not golden_path.exists():
        pytest.fail(f"missing recorded reference {golden_path} (tests/fixtures/record_engine_golden_g10.py)")
    if not data_available(case.symbol):
        pytest.skip(f"no {case.symbol} data file")

    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    out = run_case(case)

    # JSON round-trip so tuples/None/ints compare like the stored file does.
    summary = json.loads(dumps(out["summary"]))
    for key in ("fills", "rejections", "trades", "combine", "equity_curve_n", "equity_curve_sha256", "n_trading_days"):
        assert summary.get(key) == golden["summary"].get(key), f"{case.name}: {key} differs from reference"
    assert summary == golden["summary"]

    _assert_frames_identical(pd.read_parquet(FIXTURE_DIR / f"{case.name}.equity.parquet"), out["equity"], "equity")
    if out["trades"] is not None:
        _assert_frames_identical(pd.read_parquet(FIXTURE_DIR / f"{case.name}.trades.parquet"), out["trades"], "trades.parquet")
    assert out["stats"] == golden["stats"], f"{case.name}: stats.json differs from reference"
    assert out["meta"] == golden["meta"], f"{case.name}: meta.json differs from reference"


def test_reference_covers_the_engine_paths_the_refactor_could_break():
    """The cases are only a gate if, together, they hit every branch of the bar loop."""
    fills, rejections, statuses = [], [], set()
    n_same_bar = 0
    for case in CASES:
        golden = json.loads((FIXTURE_DIR / f"{case.name}.json").read_text(encoding="utf-8"))
        s = golden["summary"]
        fills += s["fills"]
        rejections += [r["reason"] for r in s["rejections"]]
        statuses.add((s["combine"]["status"], s["combine"]["fail_reason"], s["combine"]["target_hit"], s["combine"]["consistency_passed"]))
        for a, b in zip(s["fills"], s["fills"][1:]):
            if a["fill_type"] == "entry" and b["ts"] == a["ts"] and b["fill_type"] != "entry":
                n_same_bar += 1
    kinds = {f["fill_type"] for f in fills}
    assert {"entry", "stop_loss", "take_profit", "daily_lock_flatten", "mll_breach_flatten"} <= kinds
    assert {"position_already_open", "position_limit"} <= set(rejections)
    assert n_same_bar > 0
    assert ("passed", None, True, True) in statuses
    assert ("failed", "mll_breach", False, None) in statuses
    assert ("incomplete", None, True, False) in statuses
    assert any(sym.startswith("news") for sym in {f["reason"].split(":")[0] for f in fills if f["reason"]})


@pytest.mark.skipif(os.environ.get("PROPBT_SLOW") != "1", reason="slow: set PROPBT_SLOW=1")
@pytest.mark.skipif(not HISTORICAL_BUNDLE.exists(), reason="historical run bundle not present (runs/ is git-ignored)")
def test_historical_run_bundle_reproduces(tmp_path):
    import run as run_cli  # the same code path as `python run.py review`
    from propbt.reporting.run_bundle import write_run_bundle
    from propbt.sim.config import load_evaluate_config

    config = str(PROJECT_ROOT / "propbt" / "config" / "strategy.yaml")
    cb = run_cli._run_configured_backtest(config)
    oos = load_evaluate_config(str(PROJECT_ROOT / "propbt" / "config" / "evaluate.yaml")).walk_forward.out_of_sample_start
    meta = write_run_bundle(
        cb.result, cb.trades, cb.sliced_df, cb.symbol, cb.sessions_cfg, cb.prop_cfg,
        config_path=config, run_cfg=cb.run_cfg, news_cfg=cb.news_cfg, is_oos_split_date=oos, runs_dir=str(tmp_path),
    )
    new = tmp_path / meta.run_id
    for name in ("trades.parquet", "equity.parquet"):
        _assert_frames_identical(pd.read_parquet(HISTORICAL_BUNDLE / name), pd.read_parquet(new / name), name)
    assert json.loads((HISTORICAL_BUNDLE / "stats.json").read_text()) == json.loads((new / "stats.json").read_text())
    old_meta = json.loads((HISTORICAL_BUNDLE / "meta.json").read_text())
    new_meta = json.loads((new / "meta.json").read_text())
    for volatile in ("run_id", "created_at"):
        old_meta.pop(volatile), new_meta.pop(volatile)
    assert old_meta == new_meta
