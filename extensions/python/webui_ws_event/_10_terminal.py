from __future__ import annotations

import importlib
import sys

from helpers.extension import Extension


PLUGIN_PACKAGE_PREFIX = "usr.plugins.docker_terminal"
RUNTIME_MODULE_NAME = f"{PLUGIN_PACKAGE_PREFIX}.helpers.session_runtime"
SESSION_STORE_MODULE_NAME = f"{PLUGIN_PACKAGE_PREFIX}.helpers.session_store"

SUBSCRIBE_EVENT = "docker_terminal_subscribe"
INPUT_EVENT = "docker_terminal_input"
CREATE_EVENT = "docker_terminal_create"
CLOSE_EVENT = "docker_terminal_close"
CLOSE_ALL_EVENT = "docker_terminal_close_all"
RESIZE_EVENT = "docker_terminal_resize"


def _load_runtime_module(*required_names: str):
    last_error: Exception | None = None

    for attempt in range(2):
        try:
            module = importlib.import_module(RUNTIME_MODULE_NAME)
        except Exception as error:
            last_error = error
        else:
            missing = [name for name in required_names if not hasattr(module, name)]
            if not missing:
                return module
            last_error = ImportError(
                "docker_terminal runtime is stale or incomplete: missing "
                + ", ".join(sorted(missing))
            )

        if attempt == 0:
            _repair_stale_plugin_runtime()

    if last_error is not None:
        raise last_error
    raise RuntimeError("Failed to load docker_terminal runtime")


def _repair_stale_plugin_runtime() -> None:
    _close_loaded_terminal_sessions()
    _clear_plugin_modules()


def _close_loaded_terminal_sessions() -> None:
    runtime_module = sys.modules.get(RUNTIME_MODULE_NAME)
    close_all = getattr(runtime_module, "close_all_terminal_sessions", None)
    if callable(close_all):
        try:
            close_all()
            return
        except Exception:
            pass

    store_module = sys.modules.get(SESSION_STORE_MODULE_NAME)
    if store_module is None:
        return

    get_sessions = getattr(store_module, "get_sessions", None)
    if callable(get_sessions):
        try:
            sessions = list((get_sessions() or {}).values())
        except Exception:
            sessions = []

        for entry in sessions:
            session = entry.get("session") if isinstance(entry, dict) else None
            if session is None:
                continue
            for method_name in ("force_close", "close"):
                method = getattr(session, method_name, None)
                if not callable(method):
                    continue
                try:
                    method()
                except Exception:
                    pass
                break

    reset_state = getattr(store_module, "reset_state", None)
    if callable(reset_state):
        try:
            reset_state(clear_subscribers=True)
        except TypeError:
            try:
                reset_state()
            except Exception:
                pass
        except Exception:
            pass


def _clear_plugin_modules() -> None:
    for module_name in list(sys.modules):
        if module_name == PLUGIN_PACKAGE_PREFIX or module_name.startswith(
            f"{PLUGIN_PACKAGE_PREFIX}."
        ):
            sys.modules.pop(module_name, None)

    importlib.invalidate_caches()


class TerminalWebSocket(Extension):
    async def execute(
        self,
        instance=None,
        sid: str = "",
        event_type: str = "",
        data: dict | None = None,
        response_data: dict | None = None,
        **kwargs,
    ):
        del instance, kwargs

        if data is None:
            data = {}
        if response_data is None:
            return

        if event_type == SUBSCRIBE_EVENT:
            runtime = _load_runtime_module("subscribe_terminal_client")
            response_data.update(
                runtime.subscribe_terminal_client(
                    sid=sid,
                    subscribe=data.get("subscribe", True) is not False,
                )
            )
            return

        if event_type == CREATE_EVENT:
            runtime = _load_runtime_module("create_terminal_session")
            response_data.update(
                runtime.create_terminal_session(
                    cwd=data.get("cwd"),
                    cols=data.get("cols"),
                    rows=data.get("rows"),
                )
            )
            return

        if event_type == CLOSE_EVENT:
            runtime = _load_runtime_module("close_terminal_session")
            response_data.update(
                runtime.close_terminal_session(data.get("session_id"))
            )
            return

        if event_type == CLOSE_ALL_EVENT:
            runtime = _load_runtime_module("close_all_terminal_sessions")
            response_data.update(runtime.close_all_terminal_sessions())
            return

        if event_type == RESIZE_EVENT:
            runtime = _load_runtime_module("resize_terminal_session")
            response_data.update(
                runtime.resize_terminal_session(
                    data.get("session_id"),
                    cols=data.get("cols"),
                    rows=data.get("rows"),
                )
            )
            return

        if event_type == INPUT_EVENT:
            runtime = _load_runtime_module("send_terminal_input")
            response_data.update(
                runtime.send_terminal_input(
                    data.get("session_id"),
                    data.get("data", ""),
                )
            )
