from __future__ import annotations

import base64

import pandas as pd
import pytest

from propbt.config import load_data_paths


def _skip_if_no_mes_data():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")


@pytest.fixture()
def bt_client(client, tmp_path, monkeypatch):
    """The shared `client` fixture (conftest.py) already points
    PROPBT_RUNS_DIR at a fixture run bundle unrelated to sessions -- this
    additionally isolates bt-sessions storage to its own tmp dir, read
    fresh per request (get_bt_sessions_dir), so tests never touch the
    real bt_sessions/ directory."""
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(tmp_path / "bt_sessions"))
    return client


def _valid_start_time() -> int:
    return int(pd.Timestamp("2025-03-10 14:30:00", tz="UTC").timestamp())


def _create(bt_client, **overrides):
    body = {
        "instrument": "MES",
        "base_timeframe": "5min",
        "start_time": _valid_start_time(),
        "starting_balance": 50000.0,
        "risk_per_trade_percent": 1.0,
        "default_contracts": 1,
        "commission_per_contract": 1.3,
    }
    body.update(overrides)
    return bt_client.post("/api/bt-sessions", json=body)


def test_create_session_defaults_and_shape(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client)
    assert r.status_code == 200
    data = r.json()
    assert data["instrument"] == "MES"
    assert data["base_timeframe"] == "5min"
    assert data["status"] == "active"
    assert data["start_time"] == _valid_start_time()
    # A freshly created session's cursor sits exactly on its own anchor --
    # nothing has replayed yet.
    assert data["cursor_time"] == data["start_time"]
    assert data["account"]["starting_balance"] == 50000.0
    assert data["account"]["balance"] == 50000.0
    assert data["account"]["risk_per_trade_percent"] == 1.0
    assert data["account"]["risk_per_trade_usd"] is None
    assert data["id"]


def test_create_session_rejects_instrument_outside_mnq_mes(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client, instrument="ZN")
    assert r.status_code == 400
    r2 = _create(bt_client, instrument="EURUSD")
    assert r2.status_code == 400


def test_create_session_rejects_bad_timeframe(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client, base_timeframe="30min")
    assert r.status_code == 400


def test_create_session_rejects_start_time_outside_data_range(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client, start_time=0)  # 1970 -- long before any real data
    assert r.status_code == 400


def test_create_session_requires_start_time_or_random(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client, start_time=None, random_start=False)
    assert r.status_code == 400


def test_create_session_random_start_lands_inside_data_range(bt_client):
    _skip_if_no_mes_data()
    from app.backend.services import bar_service

    lo, hi = bar_service.get_instrument_range("MES")
    r = _create(bt_client, start_time=None, random_start=True)
    assert r.status_code == 200
    data = r.json()
    assert lo <= data["start_time"] <= hi
    assert data["cursor_time"] == data["start_time"]


def test_create_session_rejects_both_risk_fields_set(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client, risk_per_trade_percent=1.0, risk_per_trade_usd=500.0)
    assert r.status_code == 400


def test_create_session_rejects_neither_risk_field_set(bt_client):
    _skip_if_no_mes_data()
    r = _create(bt_client, risk_per_trade_percent=None)
    assert r.status_code == 400


def test_get_session_roundtrips(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    r = bt_client.get(f"/api/bt-sessions/{created['id']}")
    assert r.status_code == 200
    assert r.json() == created


def test_get_unknown_session_404(bt_client):
    r = bt_client.get("/api/bt-sessions/does-not-exist")
    assert r.status_code == 404


def test_list_sessions_excludes_archived_by_default(bt_client):
    _skip_if_no_mes_data()
    a = _create(bt_client).json()
    b = _create(bt_client).json()
    bt_client.post(f"/api/bt-sessions/{a['id']}/archive")

    r = bt_client.get("/api/bt-sessions")
    assert r.status_code == 200
    ids = {s["id"] for s in r.json()}
    assert ids == {b["id"]}

    r_all = bt_client.get("/api/bt-sessions", params={"include_archived": True})
    ids_all = {s["id"] for s in r_all.json()}
    assert ids_all == {a["id"], b["id"]}


def test_list_sessions_shape_includes_account_for_the_list_ui(bt_client):
    _skip_if_no_mes_data()
    _create(bt_client)
    r = bt_client.get("/api/bt-sessions")
    assert r.status_code == 200
    row = r.json()[0]
    for key in ("id", "instrument", "base_timeframe", "start_time", "cursor_time", "status", "account"):
        assert key in row
    assert "balance" in row["account"]


# --- the F1 verification scenario itself: create, "reload" (a fresh GET,
# simulating a new page load), resume (PATCH the cursor as replay steps
# forward), reload again, confirm the exact cursor/account state survives.

def test_resume_restores_exact_cursor_and_account_state(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client, starting_balance=25000.0, default_contracts=3).json()
    session_id = created["id"]

    # Simulate stepping replay forward a few bars, then reload before the
    # very last step to make sure an EARLIER save didn't leave a stale value.
    first_step_time = created["start_time"] + 5 * 60
    r1 = bt_client.patch(f"/api/bt-sessions/{session_id}/cursor", json={"cursor_time": first_step_time})
    assert r1.status_code == 200
    assert r1.json()["cursor_time"] == first_step_time

    # "Reload" -- a fresh GET must see the SAME cursor that was just saved,
    # not the original start_time.
    reloaded = bt_client.get(f"/api/bt-sessions/{session_id}").json()
    assert reloaded["cursor_time"] == first_step_time
    assert reloaded["account"]["starting_balance"] == 25000.0
    assert reloaded["account"]["default_contracts"] == 3

    # Advance further and confirm the SAVE -> RESUME round trip holds again
    # at a second, different cursor -- not just "whatever the first save was".
    second_step_time = created["start_time"] + 20 * 60
    bt_client.patch(f"/api/bt-sessions/{session_id}/cursor", json={"cursor_time": second_step_time})
    resumed_again = bt_client.get(f"/api/bt-sessions/{session_id}").json()
    assert resumed_again["cursor_time"] == second_step_time
    assert resumed_again["cursor_time"] != first_step_time
    # Account state (untouched by F1, no trading yet) is byte-identical
    # across every resume.
    assert resumed_again["account"] == created["account"]


def test_update_cursor_rejects_time_before_session_start(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    r = bt_client.patch(
        f"/api/bt-sessions/{created['id']}/cursor",
        json={"cursor_time": created["start_time"] - 3600},
    )
    assert r.status_code == 400


def test_update_cursor_unknown_session_404(bt_client):
    r = bt_client.patch("/api/bt-sessions/does-not-exist/cursor", json={"cursor_time": 0})
    assert r.status_code == 404


# --- FXR_SPEC.md phase F4's MUST-FIX: the open position and working
# orders persist WITH the session (via the same cursor PATCH), so a
# mid-trade reload restores them instead of silently losing the trade.

def _position_payload(**overrides):
    body = {
        "side": "long",
        "contracts": 2,
        "entry_price": 5010.0,
        "entry_time": _valid_start_time() + 600,
        "risk_usd": 500.0,
        "sl_price": 5000.0,
        "tp_price": 5030.0,
        "auto_breakeven": False,
        "trailing_points": None,
    }
    body.update(overrides)
    return body


def _working_order_payload(**overrides):
    body = {
        "id": "order-1",
        "side": "short",
        "order_type": "stop",
        "price": 4990.0,
        "contracts": 1,
        "sl_price": None,
        "tp_price": None,
        "risk_usd": 250.0,
        "placed_time": _valid_start_time() + 600,
    }
    body.update(overrides)
    return body


def test_fresh_session_starts_flat_with_no_position_or_orders(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    assert created["position"] is None
    assert created["working_orders"] == []


def test_update_cursor_persists_position_and_survives_reload(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    cursor_time = created["start_time"] + 600
    r = bt_client.patch(
        f"/api/bt-sessions/{created['id']}/cursor",
        json={"cursor_time": cursor_time, "position": _position_payload()},
    )
    assert r.status_code == 200
    assert r.json()["position"] == _position_payload()

    # The actual "reload" check: a FRESH GET (simulating a new page load)
    # must see the exact same position, not just the PATCH's own response.
    reloaded = bt_client.get(f"/api/bt-sessions/{created['id']}").json()
    assert reloaded["position"] == _position_payload()
    assert reloaded["cursor_time"] == cursor_time


def test_update_cursor_persists_working_orders_and_survives_reload(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    cursor_time = created["start_time"] + 600
    bt_client.patch(
        f"/api/bt-sessions/{created['id']}/cursor",
        json={"cursor_time": cursor_time, "working_orders": [_working_order_payload()]},
    )
    reloaded = bt_client.get(f"/api/bt-sessions/{created['id']}").json()
    assert reloaded["working_orders"] == [_working_order_payload()]
    assert reloaded["position"] is None  # unaffected, still flat


def test_update_cursor_with_no_position_field_clears_it_back_to_flat(bt_client):
    # Every cursor update carries the FULL current broker state (no partial
    # patch semantics) -- a step taken after closing out must clear a
    # previously-persisted position, not leave the stale one behind.
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    t1 = created["start_time"] + 300
    bt_client.patch(f"/api/bt-sessions/{created['id']}/cursor", json={"cursor_time": t1, "position": _position_payload()})
    assert bt_client.get(f"/api/bt-sessions/{created['id']}").json()["position"] is not None

    t2 = created["start_time"] + 600
    bt_client.patch(f"/api/bt-sessions/{created['id']}/cursor", json={"cursor_time": t2})
    reloaded = bt_client.get(f"/api/bt-sessions/{created['id']}").json()
    assert reloaded["position"] is None
    assert reloaded["working_orders"] == []
    assert reloaded["cursor_time"] == t2


def test_update_cursor_position_carries_auto_breakeven_and_trailing_toggles(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    payload = _position_payload(auto_breakeven=True, trailing_points=8.0)
    bt_client.patch(
        f"/api/bt-sessions/{created['id']}/cursor",
        json={"cursor_time": created["start_time"] + 300, "position": payload},
    )
    reloaded = bt_client.get(f"/api/bt-sessions/{created['id']}").json()
    assert reloaded["position"]["auto_breakeven"] is True
    assert reloaded["position"]["trailing_points"] == 8.0


def test_archive_session(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    r = bt_client.post(f"/api/bt-sessions/{created['id']}/archive")
    assert r.status_code == 200
    assert r.json()["status"] == "archived"

    # Archiving doesn't delete it -- still directly fetchable.
    r2 = bt_client.get(f"/api/bt-sessions/{created['id']}")
    assert r2.status_code == 200
    assert r2.json()["status"] == "archived"


def test_archive_unknown_session_404(bt_client):
    r = bt_client.post("/api/bt-sessions/does-not-exist/archive")
    assert r.status_code == 404


# --- FXR_SPEC.md phase F2: manual trades journaled from the sim broker.
# The frontend computes fills/pnl/r deterministically (chart/simBroker.ts's
# own mandatory test covers THAT); these tests cover the backend's job --
# durable storage plus the account-balance update -- not fill math.

def _manual_trade_body(**overrides):
    body = {
        "entry_time": _valid_start_time(),
        "exit_time": _valid_start_time() + 600,
        "instrument": "MES",
        "side": "long",
        "size_contracts": 1,
        "entry_price": 5000.0,
        "exit_price": 5010.0,
        "exit_type": "manual_close",
        "pnl_usd": 48.7,  # (5010-5000)*5*1 - commission(1.3)
        "r_multiple": 0.0974,
        "commission_usd": 1.3,
        "mae_points": 1.0,
        "mfe_points": 10.0,
        "mae_r": 0.02,
        "mfe_r": 0.2,
        "bars_held": 3,
    }
    body.update(overrides)
    return body


def test_record_trade_journals_and_returns_trade_plus_session(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body())
    assert r.status_code == 200
    data = r.json()
    assert data["trade"]["trade_id"] == 1
    assert data["trade"]["session_id"] == session["id"]
    assert data["trade"]["source"] == "manual"
    assert data["trade"]["pnl_usd"] == 48.7
    assert data["session"]["account"]["balance"] == pytest.approx(50000.0 + 48.7)


def test_record_trade_applies_net_pnl_to_balance_cumulatively(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client, starting_balance=10000.0).json()
    bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(pnl_usd=100.0))
    r2 = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(pnl_usd=-40.0))
    assert r2.json()["session"]["account"]["balance"] == pytest.approx(10000.0 + 100.0 - 40.0)

    fetched = bt_client.get(f"/api/bt-sessions/{session['id']}").json()
    assert fetched["account"]["balance"] == pytest.approx(10060.0)


def test_record_trade_assigns_incrementing_trade_ids_per_session(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r1 = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body())
    r2 = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body())
    assert r1.json()["trade"]["trade_id"] == 1
    assert r2.json()["trade"]["trade_id"] == 2


def test_record_trade_rejects_instrument_mismatch(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client, instrument="MES").json()
    r = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(instrument="MNQ"))
    assert r.status_code == 400


def test_record_trade_rejects_bad_side(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(side="up"))
    assert r.status_code == 400


def test_record_trade_unknown_session_404(bt_client):
    r = bt_client.post("/api/bt-sessions/does-not-exist/trades", json=_manual_trade_body())
    assert r.status_code == 404


def test_list_trades_empty_for_a_fresh_session(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.get(f"/api/bt-sessions/{session['id']}/trades")
    assert r.status_code == 200
    assert r.json() == []


def test_list_trades_returns_them_in_recorded_order(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(pnl_usd=10.0))
    bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(pnl_usd=-5.0))
    r = bt_client.get(f"/api/bt-sessions/{session['id']}/trades")
    trades = r.json()
    assert [t["trade_id"] for t in trades] == [1, 2]
    assert [t["pnl_usd"] for t in trades] == [10.0, -5.0]


def test_list_trades_unknown_session_404(bt_client):
    r = bt_client.get("/api/bt-sessions/does-not-exist/trades")
    assert r.status_code == 404


def test_record_trade_survives_reload(bt_client):
    # The F2 counterpart to F1's exact-cursor-resume test: a journaled
    # trade and the balance it produced must both still be there on a
    # fresh GET, not just in the POST's own response.
    _skip_if_no_mes_data()
    session = _create(bt_client, starting_balance=50000.0).json()
    bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body(pnl_usd=250.0))

    reloaded_session = bt_client.get(f"/api/bt-sessions/{session['id']}").json()
    assert reloaded_session["account"]["balance"] == pytest.approx(50250.0)

    reloaded_trades = bt_client.get(f"/api/bt-sessions/{session['id']}/trades").json()
    assert len(reloaded_trades) == 1
    assert reloaded_trades[0]["pnl_usd"] == 250.0


# --- FXR_SPEC.md section C, phase F5: journaling on top of the auto-logged
# trade -- notes/tags/setup_name/grade/screenshots, plus session-level notes.

def test_fresh_trade_has_empty_journal_fields(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    assert trade["notes"] == ""
    assert trade["tags"] == []
    assert trade["setup_name"] is None
    assert trade["grade"] is None
    assert trade["screenshots"] == []


def test_update_trade_journal_sets_notes_tags_grade_setup(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]

    r = bt_client.patch(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}",
        json={"notes": "Clean break & retest", "tags": ["break_retest", "news_continuation"], "setup_name": "Break & Retest", "grade": "A"},
    )
    assert r.status_code == 200
    updated = r.json()
    assert updated["notes"] == "Clean break & retest"
    assert updated["tags"] == ["break_retest", "news_continuation"]
    assert updated["setup_name"] == "Break & Retest"
    assert updated["grade"] == "A"


def test_update_trade_journal_partial_patch_leaves_other_fields_untouched(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    bt_client.patch(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}",
        json={"notes": "First note", "tags": ["a"], "grade": "B"},
    )
    # A later PATCH that only sets the setup name must not null out the
    # notes/tags/grade set above -- exclude_unset, not exclude_none.
    r = bt_client.patch(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}",
        json={"setup_name": "Break & Retest"},
    )
    assert r.status_code == 200
    updated = r.json()
    assert updated["notes"] == "First note"
    assert updated["tags"] == ["a"]
    assert updated["grade"] == "B"
    assert updated["setup_name"] == "Break & Retest"


def test_update_trade_journal_rejects_bad_grade(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    r = bt_client.patch(f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}", json={"grade": "Z"})
    assert r.status_code == 400


def test_update_trade_journal_unknown_trade_404(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.patch(f"/api/bt-sessions/{session['id']}/trades/999", json={"notes": "x"})
    assert r.status_code == 404


def test_update_trade_journal_unknown_session_404(bt_client):
    r = bt_client.patch("/api/bt-sessions/does-not-exist/trades/1", json={"notes": "x"})
    assert r.status_code == 404


def test_trade_journal_survives_reload(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    bt_client.patch(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}",
        json={"notes": "Survives reload", "tags": ["A-setup"], "grade": "A"},
    )
    reloaded = bt_client.get(f"/api/bt-sessions/{session['id']}/trades").json()
    assert reloaded[0]["notes"] == "Survives reload"
    assert reloaded[0]["tags"] == ["A-setup"]
    assert reloaded[0]["grade"] == "A"


# --- FXR_SPEC.md section C, phase F5: screenshots. Stored as their own file
# under the session's screenshots/ dir (never embedded in trades.json --
# see Screenshot's own comment on app/backend/models.py for why), served
# back through GET .../screenshots/{filename}.

# A real, tiny (1x1 transparent) PNG -- valid base64-encoded image bytes,
# not just an arbitrary string, since add_trade_screenshot actually decodes
# and writes it to disk.
_TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
_TINY_PNG_DATA_URL = f"data:image/png;base64,{_TINY_PNG_B64}"


def test_add_trade_screenshot_returns_trade_with_new_screenshot(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]

    r = bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "entry"},
    )
    assert r.status_code == 200
    updated = r.json()
    assert len(updated["screenshots"]) == 1
    shot = updated["screenshots"][0]
    assert shot["moment"] == "entry"
    assert "data_url" not in shot
    assert shot["url"].startswith(f"/api/bt-sessions/{session['id']}/screenshots/")


def test_add_trade_screenshot_does_not_embed_bytes_in_trades_json(bt_client, tmp_path):
    # The whole point of moving screenshots to their own files: trades.json
    # itself must stay small, never growing with the image payload.
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "entry"},
    )
    trades_json = (tmp_path / "bt_sessions" / session["id"] / "trades.json").read_text(encoding="utf-8")
    assert _TINY_PNG_B64 not in trades_json
    screenshots_dir = tmp_path / "bt_sessions" / session["id"] / "screenshots"
    assert screenshots_dir.is_dir()
    assert len(list(screenshots_dir.iterdir())) == 1


def test_add_trade_screenshot_rejects_non_image_data_url(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    r = bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots",
        json={"data_url": "not-a-data-url", "moment": "entry"},
    )
    assert r.status_code == 400


def test_add_trade_screenshot_unknown_trade_404(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/999/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "entry"},
    )
    assert r.status_code == 404


def test_add_trade_screenshot_unknown_session_404(bt_client):
    r = bt_client.post(
        "/api/bt-sessions/does-not-exist/trades/1/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "entry"},
    )
    assert r.status_code == 404


def test_get_screenshot_serves_the_actual_bytes(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    added = bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "entry"},
    ).json()
    url = added["screenshots"][0]["url"]

    r = bt_client.get(url)
    assert r.status_code == 200
    assert r.content == base64.b64decode(_TINY_PNG_B64)


def test_get_screenshot_unknown_filename_404(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.get(f"/api/bt-sessions/{session['id']}/screenshots/does-not-exist.png")
    assert r.status_code == 404


def test_delete_trade_screenshot_removes_it_and_the_file(bt_client, tmp_path):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    added = bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "entry"},
    ).json()
    screenshot_id = added["screenshots"][0]["id"]

    r = bt_client.delete(f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots/{screenshot_id}")
    assert r.status_code == 200
    assert r.json()["screenshots"] == []

    screenshots_dir = tmp_path / "bt_sessions" / session["id"] / "screenshots"
    assert list(screenshots_dir.iterdir()) == []


def test_delete_trade_screenshot_unknown_id_404(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    r = bt_client.delete(f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots/does-not-exist")
    assert r.status_code == 404


def test_screenshot_survives_reload(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    trade = bt_client.post(f"/api/bt-sessions/{session['id']}/trades", json=_manual_trade_body()).json()["trade"]
    added = bt_client.post(
        f"/api/bt-sessions/{session['id']}/trades/{trade['trade_id']}/screenshots",
        json={"data_url": _TINY_PNG_DATA_URL, "moment": "exit"},
    ).json()
    url = added["screenshots"][0]["url"]

    reloaded_trades = bt_client.get(f"/api/bt-sessions/{session['id']}/trades").json()
    assert reloaded_trades[0]["screenshots"][0]["url"] == url
    assert reloaded_trades[0]["screenshots"][0]["moment"] == "exit"
    r = bt_client.get(url)
    assert r.status_code == 200
    assert r.content == base64.b64decode(_TINY_PNG_B64)


def test_fresh_session_has_no_notes(bt_client):
    _skip_if_no_mes_data()
    created = _create(bt_client).json()
    assert created["notes"] is None


def test_update_session_notes_survives_reload(bt_client):
    _skip_if_no_mes_data()
    session = _create(bt_client).json()
    r = bt_client.patch(f"/api/bt-sessions/{session['id']}/notes", json={"notes": "Choppy overnight session, mostly fine."})
    assert r.status_code == 200
    assert r.json()["notes"] == "Choppy overnight session, mostly fine."

    reloaded = bt_client.get(f"/api/bt-sessions/{session['id']}").json()
    assert reloaded["notes"] == "Choppy overnight session, mostly fine."


def test_update_session_notes_unknown_session_404(bt_client):
    r = bt_client.patch("/api/bt-sessions/does-not-exist/notes", json={"notes": "x"})
    assert r.status_code == 404


# --- FXR_SPEC.md section F, phase F7b: the discipline lock ("no rewind past a
# placed trade"). Sessions live in the bt_client fixture's tmp dir.

def _patch_cursor(bt_client, session_id, cursor_time, **extra):
    return bt_client.patch(f"/api/bt-sessions/{session_id}/cursor", json={"cursor_time": cursor_time, **extra})


def test_discipline_lock_defaults_off_and_is_reported(bt_client):
    _skip_if_no_mes_data()
    off = _create(bt_client).json()
    assert off["discipline_lock"] is False
    assert off["lock_floor_time"] is None
    on = _create(bt_client, discipline_lock=True).json()
    assert on["discipline_lock"] is True
    assert on["lock_floor_time"] is None


def test_discipline_lock_allows_free_rewind_until_a_trade_is_placed(bt_client):
    _skip_if_no_mes_data()
    s = _create(bt_client, discipline_lock=True).json()
    t0 = s["start_time"]
    assert _patch_cursor(bt_client, s["id"], t0 + 1200).status_code == 200
    # Still flat -- stepping back (even to the anchor) is fine.
    r = _patch_cursor(bt_client, s["id"], t0 + 300)
    assert r.status_code == 200
    assert r.json()["lock_floor_time"] is None


def test_discipline_lock_blocks_rewind_past_a_placed_position(bt_client):
    _skip_if_no_mes_data()
    s = _create(bt_client, discipline_lock=True).json()
    placed_at = s["start_time"] + 900
    r = _patch_cursor(bt_client, s["id"], placed_at, position=_position_payload())
    assert r.status_code == 200
    assert r.json()["lock_floor_time"] == placed_at

    # Forward and same-bar saves are fine; anything before the floor is refused.
    assert _patch_cursor(bt_client, s["id"], placed_at + 300, position=_position_payload()).status_code == 200
    assert _patch_cursor(bt_client, s["id"], placed_at).status_code == 200
    back = _patch_cursor(bt_client, s["id"], placed_at - 300)
    assert back.status_code == 400
    assert "discipline lock" in back.json()["detail"]
    # Refused means unchanged on disk.
    assert bt_client.get(f"/api/bt-sessions/{s['id']}").json()["cursor_time"] == placed_at


def test_discipline_lock_floor_survives_cancelling_a_working_order(bt_client):
    _skip_if_no_mes_data()
    s = _create(bt_client, discipline_lock=True).json()
    placed_at = s["start_time"] + 600
    order = {
        "id": "o1", "side": "long", "order_type": "limit", "price": 5000.0, "contracts": 1,
        "sl_price": None, "tp_price": None, "risk_usd": None, "placed_time": placed_at,
    }
    assert _patch_cursor(bt_client, s["id"], placed_at, working_orders=[order]).json()["lock_floor_time"] == placed_at
    # Cancelled (no order, no position) -- the floor stays: the trade was placed.
    after_cancel = _patch_cursor(bt_client, s["id"], placed_at + 300).json()
    assert after_cancel["lock_floor_time"] == placed_at
    assert _patch_cursor(bt_client, s["id"], placed_at - 300).status_code == 400


def test_session_without_discipline_lock_can_always_rewind(bt_client):
    _skip_if_no_mes_data()
    s = _create(bt_client).json()
    placed_at = s["start_time"] + 900
    assert _patch_cursor(bt_client, s["id"], placed_at, position=_position_payload()).json()["lock_floor_time"] is None
    assert _patch_cursor(bt_client, s["id"], s["start_time"]).status_code == 200
