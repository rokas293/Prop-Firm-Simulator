"""Chart drawings, named layouts and drawing-style templates (FXR_V2_SPEC.md
section 7, G9b) -- persisted on disk, beside the session they belong to:

    bt_sessions/<session_id>/drawings.json   the session's own drawings per
                                              instrument, its named layouts, and
                                              whether it shows the shared layer
    bt_sessions/_drawings.json                the shared layer (per instrument),
                                              the style templates, which template
                                              new drawings use

Drawings are the user's own visual notes: nothing here touches trades, P&L or
prop-rule state, so the file holds them verbatim (see models.StoredOverlay).

They live in their own files, not in session.json: a drag of a trendline would
otherwise rewrite the whole session (account, positions, ...) and every session
listing would carry every drawing.

The one-off browser import (`import_browser_data`) moves what the first G9 kept
in localStorage onto the server. It is idempotent per target (a flag in each
file), so a crash between the server accepting it and the browser forgetting its
copy can never duplicate anything on the next load.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Dict, List

from app.backend import models
from app.backend.config import get_bt_sessions_dir
from app.backend.services.bt_session_service import SessionNotFound

# The shared file sits in the sessions root. list_sessions only reads directories
# that hold a session.json, so a plain file there is never mistaken for a session.
WORKSPACE_FILENAME = "_drawings.json"
SESSION_FILENAME = "drawings.json"

# Session ids come from the URL or from an import payload; never let one name a
# path outside the sessions directory.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_INSTRUMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$")

# Read-modify-write of two small files, called from FastAPI's thread pool.
_LOCK = threading.RLock()


class InvalidDrawings(ValueError):
    """Bad instrument key or similar -- a 400."""


def _session_dir(session_id: str) -> Path:
    if not _SESSION_ID_RE.match(session_id):
        raise SessionNotFound(session_id)
    return get_bt_sessions_dir() / session_id


def _session_exists(session_id: str) -> bool:
    try:
        return (_session_dir(session_id) / "session.json").exists()
    except SessionNotFound:
        return False


def _check_instruments(*maps: Dict[str, list]) -> None:
    for m in maps:
        for instrument in m:
            if not _INSTRUMENT_RE.match(instrument):
                raise InvalidDrawings(f"bad instrument key {instrument!r}")


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _union_overlays(
    current: Dict[str, List[models.StoredOverlay]], incoming: Dict[str, List[models.StoredOverlay]]
) -> Dict[str, List[models.StoredOverlay]]:
    """Per instrument: what is already there, then incoming drawings whose id is not."""
    merged = {k: list(v) for k, v in current.items()}
    for instrument, overlays in incoming.items():
        have = merged.setdefault(instrument, [])
        seen = {o.id for o in have}
        for o in overlays:
            if o.id not in seen:
                have.append(o)
                seen.add(o.id)
    return merged


def _dedupe_by_id(items: list) -> list:
    """Last one wins, position of the first kept (a re-save replaces in place)."""
    out: dict = {}
    for item in items:
        out[item.id] = item
    return list(out.values())


# --- one session ----------------------------------------------------------------

def _load_session(session_id: str) -> models.SessionDrawings:
    return models.SessionDrawings.model_validate(_read_json(_session_dir(session_id) / SESSION_FILENAME))


def _save_session(session_id: str, doc: models.SessionDrawings) -> None:
    _write_atomic(_session_dir(session_id) / SESSION_FILENAME, json.dumps(doc.model_dump(), indent=2))


def get_session_drawings(session_id: str) -> models.SessionDrawings:
    if not _session_exists(session_id):
        raise SessionNotFound(session_id)
    return _load_session(session_id)


def update_session_drawings(session_id: str, req: models.UpdateSessionDrawingsRequest) -> models.SessionDrawings:
    with _LOCK:
        if not _session_exists(session_id):
            raise SessionNotFound(session_id)
        doc = _load_session(session_id)
        sent = req.model_fields_set
        if "drawings" in sent and req.drawings is not None:
            _check_instruments(req.drawings)
            for instrument, overlays in req.drawings.items():
                doc.drawings[instrument] = _dedupe_by_id(overlays)
        if "layouts" in sent and req.layouts is not None:
            _check_instruments(*(l.drawings for l in req.layouts))
            doc.layouts = _dedupe_by_id(req.layouts)
        if "shared_visible" in sent and req.shared_visible is not None:
            doc.shared_visible = req.shared_visible
        _save_session(session_id, doc)
        return doc


# --- the shared layer and the templates ------------------------------------------

def _load_workspace() -> models.WorkspaceDrawings:
    return models.WorkspaceDrawings.model_validate(_read_json(get_bt_sessions_dir() / WORKSPACE_FILENAME))


def _save_workspace(doc: models.WorkspaceDrawings) -> None:
    _write_atomic(get_bt_sessions_dir() / WORKSPACE_FILENAME, json.dumps(doc.model_dump(), indent=2))


def get_workspace_drawings() -> models.WorkspaceDrawings:
    return _load_workspace()


def _clean_templates(templates: List[models.StyleTemplate]) -> List[models.StyleTemplate]:
    """Unique ids, and a name is unique (case-insensitively): saving under a name
    already used replaces that template, as the picker's own save does."""
    by_id = _dedupe_by_id(templates)
    by_name: dict = {}
    for t in by_id:
        by_name[t.name.lower()] = t
    return [t for t in by_id if by_name[t.name.lower()] is t]


def update_workspace_drawings(req: models.UpdateWorkspaceDrawingsRequest) -> models.WorkspaceDrawings:
    with _LOCK:
        doc = _load_workspace()
        sent = req.model_fields_set
        if "shared" in sent and req.shared is not None:
            _check_instruments(req.shared)
            for instrument, overlays in req.shared.items():
                doc.shared[instrument] = _dedupe_by_id(overlays)
        if "style_templates" in sent and req.style_templates is not None:
            doc.style_templates = _clean_templates(req.style_templates)
        if "new_drawing_template_id" in sent:
            doc.new_drawing_template_id = req.new_drawing_template_id
        # A default that names no template is no default.
        if doc.new_drawing_template_id not in {t.id for t in doc.style_templates}:
            doc.new_drawing_template_id = None
        _save_workspace(doc)
        return doc


# --- the one-off browser import --------------------------------------------------

def import_browser_data(payload: models.BrowserDrawingsImport) -> models.BrowserDrawingsImportResult:
    """Moves the first G9's browser-storage data onto the server, once.

    Each target (the shared file, and every session's file) takes its import once:
    the flag is written together with the data, and a repeat finds the flag set
    and changes nothing -- it just reports the target as imported, so the browser
    can drop its copy. Where the target already holds something (the user got in
    before the import finished), nothing there is overwritten: drawings are
    unioned by id, layouts and templates by id."""
    with _LOCK:
        _check_instruments(payload.shared, *(s.drawings for s in payload.sessions.values()))
        result = models.BrowserDrawingsImportResult()

        ws = _load_workspace()
        if not ws.imported_from_browser:
            ws.shared = _union_overlays(ws.shared, payload.shared)
            known = {t.id for t in ws.style_templates}
            names = {t.name.lower() for t in ws.style_templates}
            for t in payload.style_templates:
                if t.id in known:
                    continue
                name = t.name
                while name.lower() in names:
                    name = f"{name} (imported)"
                names.add(name.lower())
                known.add(t.id)
                ws.style_templates.append(t.model_copy(update={"name": name[:80]}))
            if ws.new_drawing_template_id is None and payload.new_drawing_template_id in known:
                ws.new_drawing_template_id = payload.new_drawing_template_id
            ws.imported_from_browser = True
            _save_workspace(ws)
        result.workspace_imported = True

        for session_id, incoming in payload.sessions.items():
            if not _session_exists(session_id):
                result.sessions_missing.append(session_id)
                continue
            doc = _load_session(session_id)
            if not doc.imported_from_browser:
                doc.drawings = _union_overlays(doc.drawings, incoming.drawings)
                have = {l.id for l in doc.layouts}
                doc.layouts.extend(l for l in incoming.layouts if l.id not in have)
                doc.shared_visible = doc.shared_visible or incoming.shared_visible
                doc.imported_from_browser = True
                _save_session(session_id, doc)
            result.sessions_imported.append(session_id)
        return result
