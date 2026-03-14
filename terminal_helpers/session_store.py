# -*- coding: utf-8 -*-
"""Shared session state for terminal sessions. Lives outside the API handler so state survives dynamic module reloads."""

from threading import RLock
from typing import Any

_SESSIONS: dict[int, dict[str, Any]] = {}
_COUNTER = 0
_STATE_LOCK = RLock()


def get_sessions() -> dict[int, dict[str, Any]]:
    with _STATE_LOCK:
        return dict(_SESSIONS)


def next_session_id() -> int:
    global _COUNTER
    with _STATE_LOCK:
        current = _COUNTER
        _COUNTER = current + 1
        return current


def add_session(session_id: int, entry: dict[str, Any]):
    with _STATE_LOCK:
        _SESSIONS[session_id] = entry


def get_session(session_id: int | None) -> dict[str, Any] | None:
    if session_id is None:
        return None
    with _STATE_LOCK:
        return _SESSIONS.get(session_id)


def remove_session(session_id: int | None):
    if session_id is None:
        return
    with _STATE_LOCK:
        _SESSIONS.pop(session_id, None)


def reset_state():
    global _COUNTER
    with _STATE_LOCK:
        _SESSIONS.clear()
        _COUNTER = 0
