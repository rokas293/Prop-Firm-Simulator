"""G9b: drawings, named layouts and style templates persisted with the session.

The drawings service only needs a session directory to exist, so most tests make a
bare one -- they do not depend on market data."""
from __future__ import annotations

import json

import pandas as pd
import pytest

from propbt.config import load_data_paths


@pytest.fixture()
def dclient(client, tmp_path, monkeypatch):
    root = tmp_path / "bt_sessions"
    root.mkdir()
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(root))
    client.sessions_root = root  # type: ignore[attr-defined]
    return client


def _fake_session(client, session_id: str) -> str:
    d = client.sessions_root / session_id
    d.mkdir()
    (d / "session.json").write_text("{}", encoding="utf-8")
    return session_id


def _line(oid: str, **extra) -> dict:
    return {"id": oid, "name": "segment", "points": [{"timestamp": 1000, "value": 100.5}, {"timestamp": 2000, "value": 101.25}], **extra}


def _layout(lid: str, name: str, **over) -> dict:
    body = {
        "id": lid,
        "name": name,
        "indicators": {"vwap": True, "ema20": True},
        "candle_type": "heikin_ashi",
        "timeframe": "15min",
        "drawings": {"MNQ": [_line("d1")]},
        "shared_visible": True,
    }
    body.update(over)
    return body


def _url(sid: str) -> str:
    return f"/api/bt-sessions/{sid}/drawings"


# --- a session's own drawings -----------------------------------------------------

def test_a_new_session_has_no_drawings(dclient):
    sid = _fake_session(dclient, "S1")
    assert dclient.get(_url(sid)).json() == {
        "drawings": {}, "layouts": [], "shared_visible": False, "imported_from_browser": False,
    }


def test_drawings_round_trip_verbatim_and_survive_a_reload(dclient):
    sid = _fake_session(dclient, "S1")
    mine = _line("a1", styles={"line": {"color": "#ff0000", "size": 3}}, lock=True, visible=False, extendDataText="note")
    r = dclient.patch(_url(sid), json={"drawings": {"MNQ": [mine]}})
    assert r.status_code == 200
    assert r.json()["drawings"]["MNQ"] == [mine]
    # A fresh read from disk: every field the chart wrote came back untouched.
    assert dclient.get(_url(sid)).json()["drawings"] == {"MNQ": [mine]}
    on_disk = json.loads((dclient.sessions_root / sid / "drawings.json").read_text(encoding="utf-8"))
    assert on_disk["drawings"]["MNQ"] == [mine]


def test_patch_replaces_only_the_instruments_sent(dclient):
    sid = _fake_session(dclient, "S1")
    dclient.patch(_url(sid), json={"drawings": {"MNQ": [_line("m1")], "MES": [_line("e1")]}})
    got = dclient.patch(_url(sid), json={"drawings": {"MNQ": [_line("m2"), _line("m3")]}}).json()
    assert [o["id"] for o in got["drawings"]["MNQ"]] == ["m2", "m3"]
    assert [o["id"] for o in got["drawings"]["MES"]] == ["e1"]
    # An empty list clears one instrument.
    got = dclient.patch(_url(sid), json={"drawings": {"MNQ": []}}).json()
    assert got["drawings"]["MNQ"] == [] and len(got["drawings"]["MES"]) == 1


def test_sessions_are_isolated_from_each_other(dclient):
    a, b = _fake_session(dclient, "A"), _fake_session(dclient, "B")
    dclient.patch(_url(a), json={"drawings": {"MNQ": [_line("a1")]}, "layouts": [_layout("l1", "Open")], "shared_visible": True})
    got = dclient.get(_url(b)).json()
    assert got["drawings"] == {} and got["layouts"] == [] and got["shared_visible"] is False
    dclient.patch(_url(b), json={"drawings": {"MNQ": [_line("b1")]}})
    assert [o["id"] for o in dclient.get(_url(a)).json()["drawings"]["MNQ"]] == ["a1"]
    assert [o["id"] for o in dclient.get(_url(b)).json()["drawings"]["MNQ"]] == ["b1"]


def test_unknown_or_unsafe_session_ids_are_404(dclient):
    assert dclient.get(_url("nope")).status_code == 404
    assert dclient.patch(_url("nope"), json={"shared_visible": True}).status_code == 404


def test_only_the_fields_sent_change(dclient):
    sid = _fake_session(dclient, "S1")
    dclient.patch(_url(sid), json={"layouts": [_layout("l1", "Open")], "shared_visible": True, "drawings": {"MNQ": [_line("a1")]}})
    got = dclient.patch(_url(sid), json={"shared_visible": False}).json()
    assert got["shared_visible"] is False and len(got["layouts"]) == 1 and len(got["drawings"]["MNQ"]) == 1


def test_malformed_drawings_are_rejected_and_change_nothing(dclient):
    sid = _fake_session(dclient, "S1")
    dclient.patch(_url(sid), json={"drawings": {"MNQ": [_line("a1")]}})
    assert dclient.patch(_url(sid), json={"drawings": {"MNQ": [{"name": "segment"}]}}).status_code == 422
    assert dclient.patch(_url(sid), json={"drawings": {"../x": [_line("a2")]}}).status_code == 400
    assert [o["id"] for o in dclient.get(_url(sid)).json()["drawings"]["MNQ"]] == ["a1"]


def test_saving_drawings_does_not_touch_session_json(dclient):
    sid = _fake_session(dclient, "S1")
    path = dclient.sessions_root / sid / "session.json"
    before = path.read_bytes()
    dclient.patch(_url(sid), json={"drawings": {"MNQ": [_line("a1")]}})
    assert path.read_bytes() == before


# --- layouts ------------------------------------------------------------------------

def test_layouts_persist_with_their_snapshot(dclient):
    sid = _fake_session(dclient, "S1")
    lay = _layout("l1", "  London open ")
    got = dclient.patch(_url(sid), json={"layouts": [lay]}).json()["layouts"]
    assert got[0]["name"] == "London open"
    assert got[0]["candle_type"] == "heikin_ashi" and got[0]["timeframe"] == "15min"
    assert got[0]["indicators"]["vwap"] is True and got[0]["indicators"]["atr14"] is False
    assert got[0]["drawings"]["MNQ"][0]["id"] == "d1" and got[0]["shared_visible"] is True
    assert dclient.get(_url(sid)).json()["layouts"] == got


def test_layouts_are_per_session_and_replaced_as_a_list(dclient):
    a, b = _fake_session(dclient, "A"), _fake_session(dclient, "B")
    dclient.patch(_url(a), json={"layouts": [_layout("l1", "One"), _layout("l2", "Two")]})
    assert dclient.get(_url(b)).json()["layouts"] == []
    got = dclient.patch(_url(a), json={"layouts": [_layout("l2", "Two")]}).json()["layouts"]
    assert [l["id"] for l in got] == ["l2"]


def test_a_blank_layout_name_is_rejected(dclient):
    sid = _fake_session(dclient, "S1")
    assert dclient.patch(_url(sid), json={"layouts": [_layout("l1", "   ")]}).status_code == 422


# --- the shared layer and the style templates ----------------------------------------

def _tpl(tid: str, name: str, color: str = "#ff0000", width: float = 2) -> dict:
    return {"id": tid, "name": name, "color": color, "width": width}


def test_shared_layer_is_kept_per_instrument(dclient):
    assert dclient.get("/api/drawings").json()["shared"] == {}
    dclient.patch("/api/drawings", json={"shared": {"MNQ": [_line("m1")], "MES": [_line("e1")]}})
    got = dclient.patch("/api/drawings", json={"shared": {"MNQ": [_line("m1"), _line("m2")]}}).json()
    assert [o["id"] for o in got["shared"]["MNQ"]] == ["m1", "m2"]
    assert [o["id"] for o in got["shared"]["MES"]] == ["e1"]
    assert dclient.get("/api/drawings").json()["shared"] == got["shared"]
    assert (dclient.sessions_root / "_drawings.json").exists()


def test_shared_layer_is_not_inside_any_session_and_sessions_do_not_write_it(dclient):
    sid = _fake_session(dclient, "S1")
    dclient.patch("/api/drawings", json={"shared": {"MNQ": [_line("old")]}})
    # A session turning the layer on, and drawing its own, never touches the shared layer.
    dclient.patch(_url(sid), json={"shared_visible": True, "drawings": {"MNQ": [_line("mine")]}})
    assert [o["id"] for o in dclient.get("/api/drawings").json()["shared"]["MNQ"]] == ["old"]
    assert [o["id"] for o in dclient.get(_url(sid)).json()["drawings"]["MNQ"]] == ["mine"]


def test_style_templates_and_the_default_for_new_drawings(dclient):
    dclient.patch("/api/drawings", json={"style_templates": [_tpl("t1", "Key level"), _tpl("t2", "Target", "#00ff00", 1)]})
    got = dclient.patch("/api/drawings", json={"new_drawing_template_id": "t2"}).json()
    assert got["new_drawing_template_id"] == "t2" and len(got["style_templates"]) == 2
    # Removing the default's template clears the default; a name replaces its older template.
    got = dclient.patch("/api/drawings", json={"style_templates": [_tpl("t1", "Key level")]}).json()
    assert got["new_drawing_template_id"] is None
    got = dclient.patch("/api/drawings", json={"style_templates": [_tpl("t1", "Key level"), _tpl("t9", "key LEVEL", "#0000ff")]}).json()
    assert [t["id"] for t in got["style_templates"]] == ["t9"]
    assert dclient.patch("/api/drawings", json={"style_templates": [_tpl("t1", "x", width=0)]}).status_code == 422


def test_workspace_setting_a_default_that_does_not_exist_is_ignored(dclient):
    assert dclient.patch("/api/drawings", json={"new_drawing_template_id": "ghost"}).json()["new_drawing_template_id"] is None


# --- the one-off browser import ------------------------------------------------------

def _legacy(**over) -> dict:
    body = {
        "shared": {"MNQ": [_line("old1"), _line("old2")]},
        "style_templates": [_tpl("t1", "Key level")],
        "new_drawing_template_id": "t1",
        "sessions": {
            "S1": {"drawings": {"MNQ": [_line("a1"), _line("a2")], "MES": [_line("e1")]},
                   "layouts": [_layout("l1", "Open")], "shared_visible": True},
            "S2": {"drawings": {"MNQ": [_line("b1")]}, "layouts": [], "shared_visible": False},
        },
    }
    body.update(over)
    return body


def test_import_moves_everything_and_reports_what_it_took(dclient):
    _fake_session(dclient, "S1"), _fake_session(dclient, "S2")
    r = dclient.post("/api/drawings/import-browser", json=_legacy())
    assert r.status_code == 200
    assert r.json() == {"sessions_imported": ["S1", "S2"], "sessions_missing": [], "workspace_imported": True}
    s1 = dclient.get(_url("S1")).json()
    assert [o["id"] for o in s1["drawings"]["MNQ"]] == ["a1", "a2"] and [o["id"] for o in s1["drawings"]["MES"]] == ["e1"]
    assert [l["id"] for l in s1["layouts"]] == ["l1"] and s1["shared_visible"] is True
    assert [o["id"] for o in dclient.get(_url("S2")).json()["drawings"]["MNQ"]] == ["b1"]
    ws = dclient.get("/api/drawings").json()
    assert [o["id"] for o in ws["shared"]["MNQ"]] == ["old1", "old2"]
    assert [t["name"] for t in ws["style_templates"]] == ["Key level"] and ws["new_drawing_template_id"] == "t1"


def test_import_twice_duplicates_nothing(dclient):
    _fake_session(dclient, "S1"), _fake_session(dclient, "S2")
    dclient.post("/api/drawings/import-browser", json=_legacy())
    first = (dclient.get(_url("S1")).json(), dclient.get("/api/drawings").json())
    again = dclient.post("/api/drawings/import-browser", json=_legacy())
    assert again.json()["sessions_imported"] == ["S1", "S2"]  # still "yours to forget"
    assert (dclient.get(_url("S1")).json(), dclient.get("/api/drawings").json()) == first


def test_a_repeat_import_never_resurrects_a_drawing_deleted_since(dclient):
    """The crash window: the server took the data but the browser kept its copy."""
    _fake_session(dclient, "S1")
    dclient.post("/api/drawings/import-browser", json=_legacy(sessions={"S1": _legacy()["sessions"]["S1"]}))
    dclient.patch(_url("S1"), json={"drawings": {"MNQ": [_line("a2")]}, "layouts": []})
    dclient.patch("/api/drawings", json={"shared": {"MNQ": []}, "style_templates": []})
    dclient.post("/api/drawings/import-browser", json=_legacy(sessions={"S1": _legacy()["sessions"]["S1"]}))
    got = dclient.get(_url("S1")).json()
    assert [o["id"] for o in got["drawings"]["MNQ"]] == ["a2"] and got["layouts"] == []
    ws = dclient.get("/api/drawings").json()
    assert ws["shared"]["MNQ"] == [] and ws["style_templates"] == []


def test_import_leaves_sessions_this_server_does_not_have_for_the_browser_to_keep(dclient):
    _fake_session(dclient, "S1")
    r = dclient.post("/api/drawings/import-browser", json=_legacy()).json()
    assert r["sessions_imported"] == ["S1"] and r["sessions_missing"] == ["S2"]
    # Nothing was created for the missing one.
    assert not (dclient.sessions_root / "S2").exists()


def test_import_never_overwrites_what_the_server_already_holds(dclient):
    sid = _fake_session(dclient, "S1")
    dclient.patch(_url(sid), json={"drawings": {"MNQ": [_line("a1", styles={"line": {"color": "#111111"}}), _line("new")]},
                                   "layouts": [_layout("l9", "Fresh")]})
    dclient.patch("/api/drawings", json={"style_templates": [_tpl("tx", "Key level", "#222222")]})
    dclient.post("/api/drawings/import-browser", json=_legacy(sessions={"S1": _legacy()["sessions"]["S1"]}))
    got = dclient.get(_url(sid)).json()
    assert [o["id"] for o in got["drawings"]["MNQ"]] == ["a1", "new", "a2"]
    assert got["drawings"]["MNQ"][0]["styles"] == {"line": {"color": "#111111"}}  # the server's a1 won
    assert [l["id"] for l in got["layouts"]] == ["l9", "l1"]
    templates = dclient.get("/api/drawings").json()["style_templates"]
    # The name clash keeps both: nothing lost, the imported one is renamed.
    assert {t["id"] for t in templates} == {"tx", "t1"}
    assert len({t["name"].lower() for t in templates}) == 2


def test_import_rejects_unsafe_session_ids_and_instruments(dclient):
    r = dclient.post("/api/drawings/import-browser", json=_legacy(sessions={"../../etc": {"drawings": {}, "layouts": []}}))
    assert r.status_code == 200 and r.json()["sessions_missing"] == ["../../etc"]
    r = dclient.post("/api/drawings/import-browser", json=_legacy(shared={"../x": [_line("q")]}))
    assert r.status_code == 400


# --- through a real session ------------------------------------------------------------

def test_drawings_belong_to_a_real_session_created_through_the_api(dclient):
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")
    created = dclient.post("/api/bt-sessions", json={
        "instrument": "MES", "base_timeframe": "5min",
        "start_time": int(pd.Timestamp("2025-03-10 14:30:00", tz="UTC").timestamp()),
        "starting_balance": 50000.0, "risk_per_trade_percent": 1.0, "quick_quantity": 1, "commission_per_contract": 1.3,
    })
    assert created.status_code == 200
    sid = created.json()["id"]
    dclient.patch(_url(sid), json={"drawings": {"MES": [_line("r1")]}, "layouts": [_layout("l1", "Open")]})
    assert dclient.get(_url(sid)).json()["layouts"][0]["name"] == "Open"
    # The session listing is unaffected by the extra file in the root and in the directory.
    listed = dclient.get("/api/bt-sessions").json()
    assert [s["id"] for s in listed] == [sid]
    assert "drawings" not in listed[0]
