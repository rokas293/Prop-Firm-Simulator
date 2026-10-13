"""FXR_V2_SPEC.md section 7 (G9): the trades CSV, and "the journal never deletes
trades"."""
from __future__ import annotations

import csv
import io

import pytest

from app.backend.services import trades_csv
from app.backend.tests.test_bt_sessions import _create, _manual_trade_body, _skip_if_no_mes_data, _valid_start_time

from app.backend.tests.test_bt_sessions import bt_client  # noqa: F401  (fixture)


def _rows(text: str):
    return list(csv.DictReader(io.StringIO(text)))


def _session_with_trades(bt_client, name):
    session = _create(bt_client, name=name).json()
    sid = session["id"]
    t0 = _valid_start_time()
    bodies = [
        _manual_trade_body(
            entry_time=t0, exit_time=t0 + 600, entry_sl_price=4995.0, entry_tp_price=5015.0,
            sl_price=5000.0, tp_price=5015.0, tags=["breakout", "ny-open"], checklist=["Trend agrees", "Stop set"],
            notes="Good fill, clean entry",
        ),
        _manual_trade_body(
            entry_time=t0 + 1200, exit_time=t0 + 1800, side="short", size_contracts=2, entry_price=5010.0,
            exit_price=5012.0, pnl_usd=-22.6, r_multiple=-0.45, commission_usd=2.6, exit_type="stop_loss",
            mae_points=2.0, mfe_points=0.5, mae_r=0.4, mfe_r=0.1, notes="=SUM(A1)",
        ),
    ]
    for b in bodies:
        assert bt_client.post(f"/api/bt-sessions/{sid}/trades", json=b).status_code == 200
    bt_client.patch(f"/api/bt-sessions/{sid}/trades/1", json={"setup_name": "ORB", "grade": "A"})
    return sid


def _assert_matches(rows, trades_by_session):
    expected = [(sid, t) for sid, trades in trades_by_session for t in trades]
    assert len(rows) == len(expected)
    for row, (sid, t) in zip(rows, expected):
        assert row["session_id"] == sid
        assert int(row["trade_id"]) == t["trade_id"]
        assert row["instrument"] == t["instrument"]
        assert row["side"] == t["side"]
        assert int(row["quantity"]) == t["size_contracts"]
        assert row["entry_time_et"] == trades_csv.fmt_et(t["entry_time"])
        assert row["exit_time_et"] == trades_csv.fmt_et(t["exit_time"])
        for col, key in [
            ("entry_price", "entry_price"), ("exit_price", "exit_price"), ("entry_sl_price", "entry_sl_price"),
            ("entry_tp_price", "entry_tp_price"), ("sl_price_at_close", "sl_price"), ("tp_price_at_close", "tp_price"),
            ("pnl_usd", "pnl_usd"), ("commission_usd", "commission_usd"), ("r_multiple", "r_multiple"),
            ("mae_points", "mae_points"), ("mfe_points", "mfe_points"), ("mae_r", "mae_r"), ("mfe_r", "mfe_r"),
        ]:
            if t[key] is None:
                assert row[col] == ""
            else:
                assert float(row[col]) == pytest.approx(t[key])
        assert row["exit_type"] == t["exit_type"]
        assert row["tags"] == "; ".join(t["tags"])
        assert row["setup"] == (t["setup_name"] or "")
        assert row["grade"] == (t["grade"] or "")
        assert row["checklist_ticked"] == "; ".join(t["checklist"])
        # Free text is exported as-is except that a formula leader is neutralised.
        notes = t["notes"]
        assert row["notes"] == ("'" + notes if notes[:1] in "=+-@" and notes else notes)


def test_session_csv_matches_trade_list(bt_client):
    _skip_if_no_mes_data()
    sid = _session_with_trades(bt_client, "CSV session")
    trades = bt_client.get(f"/api/bt-sessions/{sid}/trades").json()
    r = bt_client.get(f"/api/bt-sessions/{sid}/trades.csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert f"trades-{sid}.csv" in r.headers["content-disposition"]
    rows = _rows(r.text)
    assert list(rows[0].keys()) == trades_csv.COLUMNS
    assert [row["session_name"] for row in rows] == ["CSV session"] * 2
    _assert_matches(rows, [(sid, trades)])
    # 2025-03-10 14:30 UTC is 10:30 EDT (DST began 2025-03-09).
    assert rows[0]["entry_time_et"] == "2025-03-10 10:30:00"
    assert rows[0]["exit_time_et"] == "2025-03-10 10:40:00"
    assert rows[0]["checklist_ticked"] == "Trend agrees; Stop set"
    assert rows[0]["setup"] == "ORB" and rows[0]["grade"] == "A"
    assert rows[1]["notes"] == "'=SUM(A1)"


def test_all_sessions_csv_matches_every_trade_list_including_archived(bt_client):
    _skip_if_no_mes_data()
    a = _session_with_trades(bt_client, "First")
    b = _session_with_trades(bt_client, "Second")
    assert bt_client.post(f"/api/bt-sessions/{b}/archive").status_code == 200
    r = bt_client.get("/api/bt-sessions/export.csv")
    assert r.status_code == 200
    rows = _rows(r.text)
    by_id = {sid: bt_client.get(f"/api/bt-sessions/{sid}/trades").json() for sid in (a, b)}
    # Sessions in creation order, each session's trades in journal order.
    order = sorted((a, b), key=lambda sid: bt_client.get(f"/api/bt-sessions/{sid}").json()["created_at"])
    _assert_matches(rows, [(sid, by_id[sid]) for sid in order])
    assert {row["session_id"] for row in rows} == {a, b}


def test_csv_for_unknown_session_is_404(bt_client):
    assert bt_client.get("/api/bt-sessions/nope/trades.csv").status_code == 404


def test_empty_export_is_just_the_header(bt_client):
    text = bt_client.get("/api/bt-sessions/export.csv").text
    assert text.strip() == ",".join(trades_csv.COLUMNS)


def test_journal_never_deletes_trades(bt_client):
    _skip_if_no_mes_data()
    sid = _session_with_trades(bt_client, "Keep")
    # No delete route on a trade; archiving a session keeps every trade.
    assert bt_client.delete(f"/api/bt-sessions/{sid}/trades/1").status_code == 405
    assert bt_client.delete(f"/api/bt-sessions/{sid}/trades").status_code == 405
    assert len(bt_client.get(f"/api/bt-sessions/{sid}/trades").json()) == 2
    bt_client.post(f"/api/bt-sessions/{sid}/archive")
    assert len(bt_client.get(f"/api/bt-sessions/{sid}/trades").json()) == 2
    from app.backend.main import app

    trade_deletes = [
        r for r in app.routes
        if "DELETE" in (getattr(r, "methods", None) or ())
        and r.path.startswith("/api/bt-sessions")
        and r.path.rstrip("/").split("/")[-1] != "{screenshot_id}"
    ]
    assert trade_deletes == []
