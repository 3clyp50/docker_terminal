# -*- coding: utf-8 -*-
"""
PTY-backed terminal runtime shared by websocket event handlers.
"""

from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import threading
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Iterable

from helpers import files, plugins, settings
from helpers.defer import EventLoopThread
from helpers.websocket_manager import get_shared_websocket_manager
import helpers.runtime as runtime

import usr.plugins.docker_terminal.helpers.session_store as session_store

PLUGIN_NAME = "docker_terminal"

DEFAULT_COLS = 120
DEFAULT_ROWS = 40
READ_CHUNK_SIZE = 65536
READ_SELECT_TIMEOUT = 0.25

SUBSCRIBE_EVENT = "docker_terminal_subscribe"
INPUT_EVENT = "docker_terminal_input"
CREATE_EVENT = "docker_terminal_create"
CLOSE_EVENT = "docker_terminal_close"
CLOSE_ALL_EVENT = "docker_terminal_close_all"
RESIZE_EVENT = "docker_terminal_resize"
OUTPUT_EVENT = "docker_terminal_output"
SESSION_CREATED_EVENT = "docker_terminal_session_created"
SESSION_CLOSED_EVENT = "docker_terminal_session_closed"
SESSIONS_CLEARED_EVENT = "docker_terminal_sessions_cleared"

_OUTPUT_LOOP: EventLoopThread | None = None
_OUTPUT_LOOP_LOCK = threading.Lock()


@dataclass(frozen=True, slots=True)
class ResolvedTerminalPaths:
    exec_cwd: str | None
    display_cwd: str | None


class RawLocalSession:
    """PTY session with a dedicated background reader thread."""

    def __init__(self, cwd: str | None = None):
        self.cwd = cwd
        self.encoding = "utf-8"
        self.master_fd: int | None = None
        self.proc: subprocess.Popen[bytes] | None = None
        self._closed = threading.Event()
        self._reader_thread: threading.Thread | None = None

    def connect(self) -> None:
        master_fd, slave_fd = pty.openpty()
        command = self._build_command()

        def _preexec() -> None:
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

    def start_reader(
        self,
        on_output: Any,
        on_exit: Any,
    ) -> None:
        if self.master_fd is None:
            raise RuntimeError("Not connected")
        if self._reader_thread and self._reader_thread.is_alive():
            return

        def _run() -> None:
            try:
                self._read_loop(on_output)
            finally:
                try:
                    on_exit()
                except Exception:
                    pass

        self._reader_thread = threading.Thread(
            target=_run,
            daemon=True,
            name=f"DockerTerminalReader-{id(self)}",
        )
        self._reader_thread.start()

    def send_raw(self, data: str) -> None:
        if self.master_fd is None:
            raise RuntimeError("Not connected")

        payload = data.encode(self.encoding)
        while payload:
            written = os.write(self.master_fd, payload)
            payload = payload[written:]

    def read_raw(self, timeout: float = 0.0) -> str:
        if self.master_fd is None:
            raise RuntimeError("Not connected")

        wait_for = max(float(timeout or 0), 0.0)
        if wait_for > 0:
            ready, _, _ = select.select([self.master_fd], [], [], wait_for)
            if not ready:
                return ""

        return self._drain_available()

    def close(self) -> None:
        self._closed.set()
        proc = self.proc
        self.proc = None

        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=0.5)

        self._close_master_fd()
        self._join_reader()

    def force_close(self) -> None:
        self._closed.set()
        proc = self.proc
        self.proc = None

        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=0.5)
            except Exception:
                pass

        self._close_master_fd()
        self._join_reader()

    def resize(self, cols: int, rows: int) -> None:
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

    def _read_loop(self, on_output: Any) -> None:
        while not self._closed.is_set():
            if self.master_fd is None:
                break

            if self.proc is not None and self.proc.poll() is not None:
                remaining = self._drain_available()
                if remaining:
                    self._safe_deliver(on_output, remaining)
                break

            try:
                ready, _, _ = select.select(
                    [self.master_fd],
                    [],
                    [],
                    READ_SELECT_TIMEOUT,
                )
            except OSError as error:
                if error.errno in (errno.EBADF,):
                    break
                raise

            if not ready:
                continue

            chunk = self._drain_available()
            if chunk:
                self._safe_deliver(on_output, chunk)
                continue

            if self.proc is not None and self.proc.poll() is not None:
                break

        tail = self._drain_available()
        if tail:
            self._safe_deliver(on_output, tail)

    def _drain_available(self) -> str:
        if self.master_fd is None:
            return ""

        chunks: list[bytes] = []
        while True:
            try:
                data = os.read(self.master_fd, READ_CHUNK_SIZE)
            except BlockingIOError:
                break
            except OSError as error:
                if error.errno in (errno.EIO, errno.EBADF):
                    break
                raise

            if not data:
                break
            chunks.append(data)

            if len(data) < READ_CHUNK_SIZE:
                break

        return b"".join(chunks).decode(self.encoding, "replace")

    def _build_command(self) -> list[str]:
        executable = runtime.get_terminal_executable()
        if os.name == "posix" and os.path.basename(executable) in {"bash", "sh", "zsh"}:
            return [executable, "-i"]
        return [executable]

    def _close_master_fd(self) -> None:
        if self.master_fd is None:
            return
        try:
            os.close(self.master_fd)
        except OSError:
            pass
        self.master_fd = None

    def _join_reader(self) -> None:
        thread = self._reader_thread
        if not thread or thread is threading.current_thread():
            return
        thread.join(timeout=0.5)

    def _safe_deliver(self, on_output: Any, output: str) -> None:
        if not output:
            return
        try:
            on_output(output)
        except Exception:
            pass


def resolve_terminal_cwd() -> str | None:
    return resolve_terminal_paths().display_cwd


def resolve_terminal_paths(cwd: Any = None) -> ResolvedTerminalPaths:
    requested = _normalize_terminal_path(cwd)
    if requested.exec_cwd or requested.display_cwd:
        return requested

    config = plugins.get_plugin_config(
        PLUGIN_NAME,
        agent=None,
        project_name="",
        agent_profile="",
    )
    if isinstance(config, dict):
        configured = _normalize_terminal_path(config.get("startup_directory"))
        if configured.exec_cwd or configured.display_cwd:
            return configured

    path = settings.get_settings().get("workdir_path")
    if not path:
        return ResolvedTerminalPaths(exec_cwd=None, display_cwd=None)
    return _normalize_terminal_path(path)


def create_terminal_session(
    cwd: str | None = None,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
) -> dict[str, Any]:
    resolved_paths = resolve_terminal_paths(cwd)
    session_id = session_store.next_session_id()
    session = RawLocalSession(cwd=resolved_paths.exec_cwd)

    try:
        _prepare_terminal_cwd(resolved_paths.exec_cwd)
        session.connect()
        session_store.add_session(
            session_id,
            {
                "id": session_id,
                "session": session,
                "cwd": resolved_paths.display_cwd or "~",
                "exec_cwd": resolved_paths.exec_cwd,
                "type": "local",
            },
        )
        session.resize(cols, rows)
        session.start_reader(
            lambda output: _handle_session_output(session_id, output),
            lambda: _handle_session_exit(session_id),
        )
    except Exception as error:
        session_store.remove_session(session_id)
        session.force_close()
        return {
            "ok": False,
            "error": _format_terminal_start_error(
                error,
                exec_cwd=resolved_paths.exec_cwd,
                display_cwd=resolved_paths.display_cwd,
            ),
        }

    snapshot = session_store.snapshot_session(session_id, include_buffer=True)
    if snapshot is None:
        return {"ok": False, "error": "Failed to snapshot session"}

    _schedule_broadcast(SESSION_CREATED_EVENT, {"session": snapshot})
    return {"ok": True, "session": snapshot}


def send_terminal_input(session_id: int | None, data: str) -> dict[str, Any]:
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        entry["session"].send_raw(data)
        return {"ok": True}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def read_terminal_output(session_id: int | None, timeout: float = 0.0) -> dict[str, Any]:
    entry = session_store.get_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        output = entry["session"].read_raw(timeout=timeout)
        return {"ok": True, "output": output}
    except Exception as error:
        return {"ok": False, "error": str(error)}


def subscribe_terminal_client(sid: str, subscribe: bool = True) -> dict[str, Any]:
    if subscribe:
        session_store.subscribe(sid)
    else:
        session_store.unsubscribe(sid)

    return {
        "ok": True,
        "subscribed": bool(subscribe),
        "sessions": session_store.snapshot_sessions(include_buffers=True),
    }


def remove_terminal_client(sid: str) -> None:
    session_store.unsubscribe(sid)


def close_terminal_session(session_id: int | None) -> dict[str, Any]:
    entry = session_store.pop_session(session_id)
    if not entry:
        return {"ok": False, "error": "Session not found"}

    try:
        session = entry.get("session")
        if session:
            session.close()
    finally:
        _schedule_broadcast(
            SESSION_CLOSED_EVENT,
            {"session_id": session_id},
        )
    return {"ok": True}


def close_all_terminal_sessions() -> dict[str, Any]:
    entries = session_store.reset_state(clear_subscribers=False)
    closed = 0

    for entry in entries.values():
        session = entry.get("session")
        if not session:
            continue
        try:
            session.close()
            closed += 1
        except Exception:
            pass

    _schedule_broadcast(
        SESSIONS_CLEARED_EVENT,
        {"closed": closed},
    )
    return {"ok": True, "closed": closed}


def list_terminal_sessions(include_buffers: bool = True) -> dict[str, Any]:
    return {
        "ok": True,
        "sessions": session_store.snapshot_sessions(include_buffers=include_buffers),
    }


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


def _normalize_terminal_path(path: Any) -> ResolvedTerminalPaths:
    raw_path = str(path or "").strip()
    if not raw_path:
        return ResolvedTerminalPaths(exec_cwd=None, display_cwd=None)

    expanded_path = os.path.expanduser(raw_path)
    exec_cwd = _resolve_exec_cwd(expanded_path)
    display_cwd = _resolve_display_cwd(exec_cwd, raw_path, expanded_path)
    return ResolvedTerminalPaths(exec_cwd=exec_cwd, display_cwd=display_cwd)


def _resolve_exec_cwd(path: str) -> str:
    if path.startswith("/a0/"):
        return files.fix_dev_path(path)
    if os.path.isabs(path):
        return path
    return files.get_abs_path(path)


def _resolve_display_cwd(
    exec_cwd: str | None,
    raw_path: str,
    expanded_path: str,
) -> str | None:
    if not exec_cwd:
        return None
    if raw_path.startswith("/a0/"):
        return files.normalize_a0_path(exec_cwd)
    if os.path.isabs(expanded_path):
        return expanded_path
    return files.normalize_a0_path(exec_cwd)


def _prepare_terminal_cwd(exec_cwd: str | None) -> None:
    if not exec_cwd:
        return

    if os.path.exists(exec_cwd):
        if not os.path.isdir(exec_cwd):
            raise NotADirectoryError(exec_cwd)
        return

    os.makedirs(exec_cwd, exist_ok=True)


def _describe_terminal_cwd(exec_cwd: str | None, display_cwd: str | None) -> str:
    if display_cwd and exec_cwd and display_cwd != exec_cwd:
        return f"{display_cwd} (resolved to {exec_cwd})"
    return display_cwd or exec_cwd or "the requested startup directory"


def _format_terminal_start_error(
    error: Exception,
    *,
    exec_cwd: str | None,
    display_cwd: str | None,
) -> str:
    target = _describe_terminal_cwd(exec_cwd, display_cwd)

    if isinstance(error, NotADirectoryError):
        return f"Failed to start terminal: startup directory is not a folder: {target}"
    if isinstance(error, FileNotFoundError):
        return f"Failed to start terminal: startup directory is unavailable: {target}"
    if isinstance(error, PermissionError):
        return f"Failed to start terminal: startup directory is not accessible: {target}"
    if isinstance(error, OSError) and error.errno == errno.EROFS:
        return f"Failed to start terminal: startup directory is read-only: {target}"
    if exec_cwd or display_cwd:
        return f"Failed to start terminal in {target}: {error}"
    return str(error)


def _handle_session_output(session_id: int, output: str) -> None:
    subscribers = session_store.append_output(session_id, output)
    if not subscribers:
        return

    _schedule_push(
        OUTPUT_EVENT,
        {"session_id": session_id, "output": output},
        subscribers,
    )


def _handle_session_exit(session_id: int) -> None:
    entry = session_store.pop_session(session_id)
    if not entry:
        return

    session = entry.get("session")
    if session:
        try:
            session.force_close()
        except Exception:
            pass

    _schedule_broadcast(
        SESSION_CLOSED_EVENT,
        {"session_id": session_id},
    )


def _schedule_broadcast(event_name: str, data: dict[str, Any]) -> None:
    subscribers = session_store.get_subscribers()
    if not subscribers:
        return
    _schedule_push(event_name, data, subscribers)


def _schedule_push(
    event_name: str,
    data: dict[str, Any],
    subscribers: Iterable[str],
) -> None:
    audience = tuple(sorted({sid for sid in subscribers if sid}))
    if not audience:
        return

    future = _get_output_loop().run_coroutine(
        _push_to_subscribers(audience, event_name, data)
    )
    future.add_done_callback(_discard_future_exception)


async def _push_to_subscribers(
    subscribers: Iterable[str],
    event_name: str,
    data: dict[str, Any],
) -> None:
    manager = get_shared_websocket_manager()
    stale: list[str] = []
    for sid in subscribers:
        try:
            await manager.send_data(
                endpoint_name="/webui",
                event_name=event_name,
                data=data,
                connection_id=sid,
            )
        except Exception:
            stale.append(sid)

    for sid in stale:
        session_store.unsubscribe(sid)


def _get_output_loop() -> EventLoopThread:
    global _OUTPUT_LOOP
    with _OUTPUT_LOOP_LOCK:
        if _OUTPUT_LOOP is None:
            _OUTPUT_LOOP = EventLoopThread("DockerTerminalWebSocket")
        return _OUTPUT_LOOP


def _discard_future_exception(future: Future[Any]) -> None:
    try:
        future.result()
    except Exception:
        pass
