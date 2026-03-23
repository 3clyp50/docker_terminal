# -*- coding: utf-8 -*-
"""Install/update hooks for docker_terminal."""

from __future__ import annotations

import importlib
import shutil
import sys
from pathlib import Path


PLUGIN_PACKAGE_PREFIX = "usr.plugins.docker_terminal"
RUNTIME_MODULE_NAME = f"{PLUGIN_PACKAGE_PREFIX}.helpers.session_runtime"
SESSION_STORE_MODULE_NAME = f"{PLUGIN_PACKAGE_PREFIX}.helpers.session_store"
PLUGIN_ROOT = Path(__file__).resolve().parent


def install():
    _close_loaded_terminal_sessions()
    _clear_plugin_modules()
    _clear_plugin_bytecode()


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


def _clear_plugin_bytecode() -> None:
    for cache_dir in PLUGIN_ROOT.rglob("__pycache__"):
        shutil.rmtree(cache_dir, ignore_errors=True)
