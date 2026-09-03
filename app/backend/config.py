"""Backend settings. `PROPBT_RUNS_DIR` lets tests (and anyone else) point
at a different runs/ directory without touching the real one -- read fresh
each call, not cached, so tests can flip it mid-session.
"""
from __future__ import annotations

import os
from pathlib import Path

from propbt.reporting.run_bundle import DEFAULT_RUNS_DIR


def get_runs_dir() -> Path:
    override = os.environ.get("PROPBT_RUNS_DIR")
    return Path(override) if override else DEFAULT_RUNS_DIR


# FXR_SPEC.md section 2/6: manual-backtest sessions get their own top-level
# directory, sibling to runs/ -- same "one directory per id" durability
# shape (see bt_session_service.py), but a completely separate id space
# from automated-backtest runs. PROPBT_BT_SESSIONS_DIR mirrors
# PROPBT_RUNS_DIR's env-override-for-tests pattern.
DEFAULT_BT_SESSIONS_DIR = DEFAULT_RUNS_DIR.parent / "bt_sessions"


def get_bt_sessions_dir() -> Path:
    override = os.environ.get("PROPBT_BT_SESSIONS_DIR")
    return Path(override) if override else DEFAULT_BT_SESSIONS_DIR
