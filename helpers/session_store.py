# -*- coding: utf-8 -*-
"""Shared session state for terminal sessions."""

from __future__ import annotations

from collections import deque
from threading import RLock
from typing import Any


BUFFER_LIMIT = 200000


class SessionBuffer:
    """Bounded append-only text buffer used for terminal resync snapshots."""

    def __init__(self, limit: int = BUFFER_LIMIT):
        self.limit = max(int(limit or BUFFER_LIMIT), 1)
        self._chunks: deque[str] = deque()
        self._size = 0

    def append(self, text: str) -> None:
        if not text:
            return

        self._chunks.append(text)
        self._size += len(text)

        while self._size > self.limit and self._chunks:
            if len(self._chunks) == 1:
                tail = self._chunks.pop()[-self.limit :]
                self._chunks.append(tail)
                self._size = len(tail)
                break

            removed = self._chunks.popleft()
            self._size -= len(removed)

    def snapshot(self) -> str:
        return "".join(self._chunks)


_SESSIONS: dict[int, dict[str, Any]] = {}
_SUBSCRIBERS: set[str] = set()
_COUNTER = 0
_STATE_LOCK = RLock()


def get_sessions() -> dict[int, dict[str, Any]]:
    with _STATE_LOCK:
        return dict(_SESSIONS)


def get_subscribers() -> set[str]:
    with _STATE_LOCK:
        return set(_SUBSCRIBERS)


def next_session_id() -> int:
    global _COUNTER
    with _STATE_LOCK:
        current = _COUNTER
        _COUNTER = current + 1
        return current


def add_session(session_id: int, entry: dict[str, Any]) -> None:
    with _STATE_LOCK:
        stored = dict(entry)
        stored.setdefault("buffer", SessionBuffer())
        stored.setdefault("subscribers", set(_SUBSCRIBERS))
        _SESSIONS[session_id] = stored


def get_session(session_id: int | None) -> dict[str, Any] | None:
    if session_id is None:
        return None
    with _STATE_LOCK:
        return _SESSIONS.get(session_id)


def pop_session(session_id: int | None) -> dict[str, Any] | None:
    if session_id is None:
        return None
    with _STATE_LOCK:
        return _SESSIONS.pop(session_id, None)


def remove_session(session_id: int | None) -> None:
    pop_session(session_id)


def subscribe(sid: str) -> None:
    if not sid:
        return
    with _STATE_LOCK:
        _SUBSCRIBERS.add(sid)
        for entry in _SESSIONS.values():
            entry.setdefault("subscribers", set()).add(sid)


def unsubscribe(sid: str) -> None:
    if not sid:
        return
    with _STATE_LOCK:
        _SUBSCRIBERS.discard(sid)
        for entry in _SESSIONS.values():
            entry.setdefault("subscribers", set()).discard(sid)


def append_output(session_id: int, output: str) -> set[str]:
    if not output:
        return set()

    with _STATE_LOCK:
        entry = _SESSIONS.get(session_id)
        if not entry:
            return set()

        buffer = entry.setdefault("buffer", SessionBuffer())
        if not isinstance(buffer, SessionBuffer):
            buffer = SessionBuffer()
            entry["buffer"] = buffer

        buffer.append(output)
        return set(entry.setdefault("subscribers", set()))


def snapshot_sessions(include_buffers: bool = True) -> list[dict[str, Any]]:
    with _STATE_LOCK:
        return [
            _snapshot_entry(session_id, entry, include_buffer=include_buffers)
            for session_id, entry in sorted(_SESSIONS.items())
        ]


def snapshot_session(
    session_id: int | None,
    include_buffer: bool = True,
) -> dict[str, Any] | None:
    if session_id is None:
        return None

    with _STATE_LOCK:
        entry = _SESSIONS.get(session_id)
        if not entry:
            return None
        return _snapshot_entry(session_id, entry, include_buffer=include_buffer)


def reset_state(clear_subscribers: bool = False) -> dict[int, dict[str, Any]]:
    global _COUNTER
    with _STATE_LOCK:
        previous = dict(_SESSIONS)
        _SESSIONS.clear()
        _COUNTER = 0
        if clear_subscribers:
            _SUBSCRIBERS.clear()
        return previous


def _snapshot_entry(
    session_id: int,
    entry: dict[str, Any],
    *,
    include_buffer: bool,
) -> dict[str, Any]:
    buffer = entry.get("buffer")
    text = buffer.snapshot() if include_buffer and isinstance(buffer, SessionBuffer) else ""
    return {
        "id": session_id,
        "type": entry.get("type", "local"),
        "cwd": entry.get("cwd", "~"),
        "buffer": text,
    }
