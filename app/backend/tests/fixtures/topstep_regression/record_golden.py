"""Records golden.json from the code as it currently stands. Used once, on the
pre-G6 engine; see build_fixtures.py. Usage: python record_golden.py"""
import json
import os
from pathlib import Path

HERE = Path(__file__).parent
os.environ["PROPBT_BT_SESSIONS_DIR"] = str(HERE / "sessions")

from app.backend.services import manual_analytics as ma  # noqa: E402
from app.backend.services import bt_session_service as bts  # noqa: E402


def snapshot(sid: str) -> dict:
    run_id = ma.MANUAL_PREFIX + sid
    stats = ma.get_stats(run_id)
    eq = ma.build_equity_frame(run_id)
    risk = ma.list_daily_risk(run_id)
    return {
        "status": ma.prop_status(sid).model_dump(),
        "result": stats.result.model_dump() if stats.result else None,
        "overall": stats.overall.model_dump(),
        "equity": json.loads(eq.to_json(orient="records", date_format="epoch")),
        "daily_risk": [r.model_dump() for r in risk],
    }


if __name__ == "__main__":
    out = {s.id: snapshot(s.id) for s in bts.list_sessions(include_archived=True)}
    (HERE / "golden.json").write_text(json.dumps(out, indent=1, sort_keys=True), encoding="utf-8")
    for k, v in out.items():
        print(k, v["status"]["status"], v["status"]["fail_reason"], v["status"]["trades_to_result"], len(v["equity"]))
