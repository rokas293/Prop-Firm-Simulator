from __future__ import annotations

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
