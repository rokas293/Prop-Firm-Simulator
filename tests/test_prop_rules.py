"""Mandatory prop-rule edge-case tests (CLAUDE.md section 3, exactly):
MLL trails then freezes at exactly 52k; intraday breach fails even if EOD
would've been fine; daily loss lock stops trading and resumes next day;
consistency rule blocks a pass where one day is >50% of profit.
"""
from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from propbt.config import load_prop_rules
from propbt.engine.prop_rules import PropRulesTracker


@pytest.fixture
def cfg():
    return load_prop_rules()  # real CLAUDE.md-verified config: 50k/target 3000/mll 2000/daily 1000/consistency 0.5


def ts(d: dt.date) -> pd.Timestamp:
    return pd.Timestamp(d, tz="UTC")


def test_mll_trails_then_freezes_at_exactly_52k(cfg):
    tracker = PropRulesTracker(cfg)
    d1, d2, d3, d4 = (dt.date(2025, 1, 6 + i) for i in range(4))

    tracker.on_bar(ts(d1), d1, balance=50500.0, equity=50500.0)  # day1 running
    assert tracker.mll_floor == 48000.0  # unchanged -- day1 hasn't closed yet
    assert not tracker.mll_frozen

    tracker.on_bar(ts(d2), d2, balance=52500.0, equity=52500.0)  # closes day1 (eod=50500)
    assert tracker.mll_floor == 48500.0  # 50500 - 2000, trailed up
    assert not tracker.mll_frozen

    tracker.on_bar(ts(d3), d3, balance=50500.0, equity=50500.0)  # closes day2 (eod=52500 >= freeze trigger)
    assert tracker.mll_frozen
    assert tracker.mll_floor == 50000.0  # frozen at the FIXED 50000, not the trailed 50500

    tracker.on_bar(ts(d4), d4, balance=51000.0, equity=51000.0)  # closes day3 (eod=50500)
    assert tracker.mll_frozen
    assert tracker.mll_floor == 50000.0  # stays frozen regardless of later EOD swings


def test_intraday_breach_fails_even_if_eod_would_have_been_fine(cfg):
    tracker = PropRulesTracker(cfg)
    d1 = dt.date(2025, 1, 6)
    t1 = ts(d1)
    t2 = t1 + pd.Timedelta(minutes=1)

    # floor starts at 48000. Realized balance (49000) looks fine, but live
    # equity (open unrealized loss) touches 47000, well under the floor.
    status = tracker.on_bar(t1, d1, balance=49000.0, equity=47000.0)
    assert status.newly_failed
    assert status.failed
    assert tracker.fail_reason == "mll_breach"

    # a later bar showing a full recovery must NOT undo the failure --
    # the attempt is already over.
    status2 = tracker.on_bar(t2, d1, balance=51000.0, equity=51000.0)
    assert status2.failed
    assert not status2.newly_failed

    result = tracker.finalize()
    assert result.status == "failed"
    assert result.fail_reason == "mll_breach"


def test_daily_loss_lock_stops_trading_and_resumes_next_day(cfg):
    tracker = PropRulesTracker(cfg)
    d1, d2 = dt.date(2025, 1, 6), dt.date(2025, 1, 7)
    t1 = ts(d1)

    # day starts at 50000; drawdown of exactly -1000 triggers the lock
    status = tracker.on_bar(t1, d1, balance=49000.0, equity=49000.0)
    assert status.newly_daily_locked
    assert status.is_daily_locked
    assert not status.failed  # locks the day, does NOT fail the Combine

    status2 = tracker.on_bar(t1 + pd.Timedelta(minutes=1), d1, balance=49000.0, equity=49000.0)
    assert status2.is_daily_locked
    assert not status2.newly_daily_locked  # already locked today, not a new event

    status3 = tracker.on_bar(ts(d2), d2, balance=49000.0, equity=49000.0)  # next trading day
    assert not status3.is_daily_locked  # resumes
    assert not status3.failed


def test_consistency_rule_blocks_pass_until_diluted(cfg):
    tracker = PropRulesTracker(cfg)
    d1, d2 = dt.date(2025, 1, 6), dt.date(2025, 1, 7)
    t1 = ts(d1)

    tracker.on_bar(t1, d1, balance=52500.0, equity=52500.0)  # day1 running, +2500 so far

    t2 = ts(d2)  # closes day1 -> locked in as a 2500 day
    status_blocked = tracker.on_bar(t2, d2, balance=53000.0, equity=53000.0)  # total profit 3000 -> target hit
    assert tracker.target_hit
    assert tracker.target_hit_ts == t2
    assert tracker.consistency_passed is False  # day1's 2500 is 83% of the 3000 total, way over 50%
    assert not status_blocked.passed
    assert not tracker.passed

    # more profit comes in on day2, diluting day1's share of the total
    t3 = t2 + pd.Timedelta(minutes=1)
    status_still_blocked = tracker.on_bar(t3, d2, balance=54000.0, equity=54000.0)  # total 4000, day2 pnl 1500
    assert tracker.consistency_passed is False  # best=2500 > 50%*4000=2000
    assert not status_still_blocked.passed

    t4 = t3 + pd.Timedelta(minutes=1)
    status_passed = tracker.on_bar(t4, d2, balance=55000.0, equity=55000.0)  # total 5000, day2 pnl 2500
    assert tracker.consistency_passed is True  # best=2500 == 50%*5000=2500 exactly -> passes
    assert status_passed.passed
    assert status_passed.newly_passed
    assert tracker.pass_ts == t4

    result = tracker.finalize()
    assert result.status == "passed"
    assert result.consistency_passed is True
    assert result.target_hit


def test_clean_pass_when_no_single_day_dominates(cfg):
    tracker = PropRulesTracker(cfg)
    days = [dt.date(2025, 1, 6 + i) for i in range(4)]

    # four modest, roughly even days: 900 + 900 + 900 + 900 = 3600 >= target
    balance = 50000.0
    for i, d in enumerate(days):
        balance += 900.0
        status = tracker.on_bar(ts(d) + pd.Timedelta(minutes=i), d, balance=balance, equity=balance)

    assert tracker.target_hit
    assert tracker.consistency_passed is True
    assert status.passed


def test_no_breach_and_no_lock_on_an_uneventful_day(cfg):
    tracker = PropRulesTracker(cfg)
    d1 = dt.date(2025, 1, 6)
    status = tracker.on_bar(ts(d1), d1, balance=50100.0, equity=50100.0)
    assert not status.failed
    assert not status.is_daily_locked
    assert not status.passed

    result = tracker.finalize()
    assert result.status == "incomplete"
    assert len(result.day_logs) == 1
    assert result.day_logs[0].daily_pnl == pytest.approx(100.0)


# ---- G6: configurable loss types and optional rules (FXR_V2_SPEC.md section 4) ----

from dataclasses import replace  # noqa: E402


def custom(**kw):
    base = replace(
        load_prop_rules(),
        mll_type="static",
        mll_freeze_trigger_balance=None,
        mll_freeze_floor=None,
    )
    return replace(base, **kw)


def test_topstep_config_is_eod_trailing_and_unchanged(cfg):
    # The default type is the Topstep one, so every existing caller behaves as before.
    assert cfg.mll_type == "eod_trailing"
    assert cfg.mll_freeze_trigger_balance == 52000.0 and cfg.mll_freeze_floor == 50000.0


def test_static_floor_never_moves():
    tracker = PropRulesTracker(custom())
    d1, d2, d3 = (dt.date(2025, 1, 6 + i) for i in range(3))
    tracker.on_bar(ts(d1), d1, balance=51000.0, equity=51000.0)
    tracker.on_bar(ts(d2), d2, balance=52500.0, equity=52500.0)  # closes day 1 (EOD 51000)
    tracker.on_bar(ts(d3), d3, balance=52500.0, equity=52500.0)  # closes day 2 (EOD 52500)
    assert not tracker.passed  # below the 3000 target
    assert tracker.mll_floor == 48000.0  # start - offset, whatever the balance did
    assert not tracker.mll_frozen
    # ... and it still breaches against live equity.
    st = tracker.on_bar(ts(d3) + pd.Timedelta(minutes=1), d3, balance=52500.0, equity=48000.0)
    assert st.newly_failed and tracker.fail_reason == "mll_breach"


def test_intraday_trailing_floor_follows_the_equity_high_water_mark():
    tracker = PropRulesTracker(custom(mll_type="intraday_trailing"))
    d1 = dt.date(2025, 1, 6)
    t = ts(d1)
    tracker.on_bar(t, d1, balance=50000.0, equity=51200.0)  # open profit: peak 51200
    assert tracker.mll_floor == 49200.0  # trails WITHOUT waiting for the day to close
    tracker.on_bar(t + pd.Timedelta(minutes=1), d1, balance=50000.0, equity=50500.0)
    assert tracker.mll_floor == 49200.0  # never falls back
    # Under an EOD-trailing floor 50500 would be fine (floor 48000); here 49200 binds.
    st = tracker.on_bar(t + pd.Timedelta(minutes=2), d1, balance=50000.0, equity=49200.0)
    assert st.newly_failed and tracker.fail_reason == "mll_breach"


def test_intraday_trailing_is_stricter_than_eod_for_the_same_path():
    path = [(51200.0, 51200.0), (50000.0, 49000.0)]  # (balance, equity): a spike, then a dip
    d1 = dt.date(2025, 1, 6)
    outcomes = {}
    for kind in ("eod_trailing", "intraday_trailing"):
        tr = PropRulesTracker(custom(mll_type=kind))
        for i, (bal, eq) in enumerate(path):
            tr.on_bar(ts(d1) + pd.Timedelta(minutes=i), d1, balance=bal, equity=eq)
        outcomes[kind] = tr.failed
    assert outcomes == {"eod_trailing": False, "intraday_trailing": True}


def test_intraday_trailing_freezes_at_the_start_balance_when_configured():
    tracker = PropRulesTracker(custom(mll_type="intraday_trailing", mll_freeze_trigger_balance=52000.0, mll_freeze_floor=50000.0))
    d1 = dt.date(2025, 1, 6)
    tracker.on_bar(ts(d1), d1, balance=50000.0, equity=53500.0)
    assert tracker.mll_frozen and tracker.mll_floor == 50000.0  # not 51500
    tracker.on_bar(ts(d1) + pd.Timedelta(minutes=1), d1, balance=50000.0, equity=60000.0)
    assert tracker.mll_floor == 50000.0


def test_no_daily_loss_limit_never_locks():
    tracker = PropRulesTracker(custom(daily_loss_limit=None))
    d1 = dt.date(2025, 1, 6)
    st = tracker.on_bar(ts(d1), d1, balance=49500.0, equity=48500.0)  # -1500 on the day
    assert not st.is_daily_locked


def test_no_consistency_rule_passes_on_target_alone():
    tracker = PropRulesTracker(custom(consistency_max_pct=None))
    d1 = dt.date(2025, 1, 6)
    st = tracker.on_bar(ts(d1), d1, balance=53000.0, equity=53000.0)  # the whole profit on one day
    assert st.newly_passed and tracker.consistency_passed is True
