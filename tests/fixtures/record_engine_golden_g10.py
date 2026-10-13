"""Records the G10 engine reference (tests/fixtures/engine_golden_g10/).

Run ONCE, with the engine as it stood before `run_backtest`'s bar loop was
extracted into a stepper (the recorded files carry the git HEAD they came
from). It is not part of the test run: re-recording after the refactor would
defeat the gate. Usage, from the repo root:

    python -m tests.fixtures.record_engine_golden_g10 [case_name ...]
"""
from __future__ import annotations

import subprocess
import sys
import time

from tests.engine_golden import CASES, CASES_BY_NAME, FIXTURE_DIR, data_available, dumps, run_case


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # pragma: no cover -- provenance is best-effort
        return "unknown"


def main(names: list[str]) -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    provenance = {
        "git_head": _git("rev-parse", "HEAD"),
        "git_dirty_engine_files": _git("status", "--porcelain", "--", "propbt"),
        "recorded_with": "monolithic run_backtest loop (pre-G10 stepper extraction)",
    }
    cases = [CASES_BY_NAME[n] for n in names] if names else CASES
    for case in cases:
        if not data_available(case.symbol):
            print(f"SKIP {case.name}: no {case.symbol} data file")
            continue
        t0 = time.time()
        out = run_case(case)
        base = FIXTURE_DIR / case.name
        payload = {"provenance": provenance, "summary": out["summary"], "stats": out["stats"], "meta": out["meta"]}
        base.with_suffix(".json").write_text(dumps(payload), encoding="utf-8")
        out["equity"].to_parquet(FIXTURE_DIR / f"{case.name}.equity.parquet", index=False)
        if out["trades"] is not None:
            out["trades"].to_parquet(FIXTURE_DIR / f"{case.name}.trades.parquet", index=False)
        s = out["summary"]
        print(
            f"{case.name:30s} {time.time() - t0:5.1f}s fills={len(s['fills']):4d} rej={len(s['rejections']):3d} "
            f"bars={s['equity_curve_n']:6d} -> {s['combine']['status']} {s['combine']['fail_reason']} "
            f"bal={s['combine']['final_balance']:.2f}"
        )


if __name__ == "__main__":
    main(sys.argv[1:])
