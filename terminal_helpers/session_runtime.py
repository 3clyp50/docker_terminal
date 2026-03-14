# -*- coding: utf-8 -*-
"""
PTY-backed terminal session runtime. Loop-independent so it works across RFC calls.
Shared logic lives here; api/terminal.py keeps only the thin request handler.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time
from typing import Any

import helpers.runtime as runtime

from . import session_store

DEFAULT_COLS = 120
DEFAULT_ROWS = 40
READ_CHUNK_SIZE = 65536
READ_IDLE_TIMEOUT = 0.01


class RawLocalSession:
    """PTY session that does not retain asyncio-bound objects between RFC calls."""

    def __init__(self, cwd: str | None = None):
        self.cwd = cwd
        self.encoding = "utf-8"
        self.master_fd: int | None = None
        self.proc: subprocess.Popen[bytes] | None = None

    def connect(self):
        master_fd, slave_fd = pty.openpty()
        command = self._build_command()

        def _preexec():
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        try:
            self.proc = subprocess.Popen(
                command,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=self.cwd,
                env=env,
                preexec_fn=_preexec if os.name == "posix" else None,
                close_fds=True,
            )
        finally:
            os.close(slave_fd)

        os.set_blocking(master_fd, False)
        self.master_fd = master_fd

    def send_raw(self, data: str):
        if self.master_fd is None:
            raise RuntimeError("Not connected")

        payload = data.encode(self.encoding)
        while payload:
            written = os.write(self.master_fd, payload)
            payload = payload[written:]

    def read_raw(self, timeout: float = 0.15) -> str:
        if self.master_fd is None:
            raise RuntimeError("Not connected")

        deadline = time.monotonic() + max(float(timeout or 0), 0)
        chunks: list[bytes] = []

        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            wait_for = min(READ_IDLE_TIMEOUT if chunks else remaining, remaining)
            if wait_for <= 0:
                break

            ready, _, _ = select.select([self.master_fd], [], [], wait_for)
            if not ready:
                if chunks:
                    break
                continue

            try:
                data = os.read(self.master_fd, READ_CHUNK_SIZE)
            except BlockingIOError:
                if chunks:
                    break
                continue
            except OSError as error:
                if error.errno in (errno.EIO, errno.EBADF):
                    break
                raise

            if not data:
                break
            chunks.append(data)

        return b"".join(chunks).decode(self.encoding, "replace")

    def close(self):
        proc = self.proc
        self.proc = None

        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=0.5)

        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

    def force_close(self):
        proc = self.proc
        self.proc = None

        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=0.5)
            except Exception:
                pass

        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

    def resize(self, cols: int, rows: int):
        if self.master_fd is None or self.proc is None:
            return

        safe_cols = max(20, int(cols or DEFAULT_COLS))
        safe_rows = max(5, int(rows or DEFAULT_ROWS))

        fcntl.ioctl(
            self.master_fd,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", safe_rows, safe_cols, 0, 0),
        )

        if self.proc.poll() is None:
            try:
                os.kill(self.proc.pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass

    def _build_command(self) -> list[str]:
        executable = runtime.get_terminal_executable()
        if os.name == "posix" and os.path.basename(executable) in {"bash", "sh", "zsh"}:
            return [executable, "-i"]
        return [executable]


def create_terminal_session(
    cwd: str | None,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
) -> dict[str, Any]:
    sid = session_store.next_session_id()
    session = RawLocalSession(cwd=cwd)

    try:
        if cwd:
            os.makedirs(cwd, exist_ok=True)
        session.connect()
        session.resize(cols, rows)
    except Exception as error:
        session.force_close()
        return {"ok": False, "error": str(error)}

    session_store.add_session(
        sid,
        {
            "id": sid,
            "session": session,
            "cwd": cwd or "~",
            "type": "local",
        },
    )
    return {"ok": True, "session_id": sid, "type": "local", "cwd": cwd or "~"}


def send_terminal_input(session_id: int | None, data: str) -> dict[str, Any]:
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        entry["session"].send_raw(data)
        return {"ok": True}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def read_terminal_output(session_id: int | None, timeout: float = 0.15) -> dict[str, Any]:
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        output = entry["session"].read_raw(timeout=timeout)
        return {"ok": True, "output": output}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def close_terminal_session(session_id: int | None) -> dict[str, Any]:
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        entry["session"].close()
    finally:
        session_store.remove_session(session_id)
    return {"ok": True}


def _close_all_sessions(force: bool = False) -> dict[str, Any]:
    sessions = list(session_store.get_sessions().values())
    closed = 0
    for entry in sessions:
        session = entry.get("session")
        if not session:
            continue
        close_fn = getattr(session, "force_close", None) if force else getattr(session, "close", None)
        if not callable(close_fn):
            continue
        try:
            close_fn()
            closed += 1
        except Exception:
            pass

    session_store.reset_state()
    return {"ok": True, "closed": closed}


def close_all_terminal_sessions() -> dict[str, Any]:
    return _close_all_sessions(force=False)


def list_terminal_sessions() -> dict[str, Any]:
    sessions = [
        {"id": sid, "type": entry["type"], "cwd": entry["cwd"]}
        for sid, entry in sorted(session_store.get_sessions().items())
    ]
    return {"ok": True, "sessions": sessions}


def resize_terminal_session(
    session_id: int | None,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
) -> dict[str, Any]:
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        entry["session"].resize(cols, rows)
        return {"ok": True}
    except Exception as error:
        return {"ok": False, "error": str(error)}
