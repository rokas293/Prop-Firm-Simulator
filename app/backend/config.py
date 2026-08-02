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
