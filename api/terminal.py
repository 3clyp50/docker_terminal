# -*- coding: utf-8 -*-
"""
Docker Terminal API handler. Thin dispatch layer; shared logic lives in
helpers/.
Workspace-scoped; no chat/context coupling.
"""

from typing import Any

from flask import Request

from helpers import files, plugins, settings
from helpers.api import ApiHandler
import helpers.runtime as runtime

from usr.plugins.docker_terminal.helpers.session_runtime import (
    DEFAULT_COLS,
    DEFAULT_ROWS,
    create_terminal_session,
    send_terminal_input,
    read_terminal_output,
    close_terminal_session,
    close_all_terminal_sessions,
    list_terminal_sessions,
    resize_terminal_session,
)

PLUGIN_NAME = "docker_terminal"


class TerminalHandler(ApiHandler):
    """Creates and manages local terminal sessions for the workspace."""

    async def process(self, input: dict, request: Request) -> dict:
        action = input.get("action", "")

        if action == "create":
            return await self._create()
        if action == "send":
            return await self._send(input)
        if action == "read":
            return await self._read(input)
        if action == "close":
            return await self._close(input)
        if action == "close_all":
            return await self._close_all()
        if action == "list":
            return await self._list()
        if action == "resize":
            return await self._resize(input)
        return {"ok": False, "error": f"Unknown action: {action}"}

    def _get_startup_directory(self) -> str | None:
        config = plugins.get_plugin_config(
            PLUGIN_NAME,
            agent=None,
            project_name="",
            agent_profile="",
        )
        if not isinstance(config, dict):
            return None
        return self._normalize_configured_path(config.get("startup_directory"))

    def _normalize_configured_path(self, path: Any) -> str | None:
        raw_path = str(path or "").strip()
        if not raw_path:
            return None

        absolute_path = files.get_abs_path(raw_path)
        development_path = files.fix_dev_path(absolute_path)
        return files.normalize_a0_path(development_path)

    def _resolve_cwd(self) -> str | None:
        configured_path = self._get_startup_directory()
        if configured_path:
            return configured_path

        path = settings.get_settings().get("workdir_path")
        if not path:
            return None
        return files.normalize_a0_path(path)

    async def _call_runtime(self, function: Any, *args: Any) -> dict:
        try:
            return await runtime.call_development_function(function, *args)
        except Exception as error:
            return {"ok": False, "error": str(error)}

    def _parse_session_id(self, value: Any) -> int | None:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _require_session_id(self, input: dict) -> tuple[int | None, dict | None]:
        session_id = self._parse_session_id(input.get("session_id"))
        if session_id is None:
            return None, {"ok": False, "error": "invalid session_id"}
        return session_id, None

    async def _create(self) -> dict:
        cwd = self._resolve_cwd()
        return await self._call_runtime(
            create_terminal_session,
            cwd,
            DEFAULT_COLS,
            DEFAULT_ROWS,
        )

    async def _send(self, input: dict) -> dict:
        session_id, error = self._require_session_id(input)
        if error:
            return error
        payload = str(input.get("data", ""))
        return await self._call_runtime(send_terminal_input, session_id, payload)

    async def _read(self, input: dict) -> dict:
        session_id, error = self._require_session_id(input)
        if error:
            return error
        return await self._call_runtime(read_terminal_output, session_id, 0.15)

    async def _close(self, input: dict) -> dict:
        session_id, error = self._require_session_id(input)
        if error:
            return error
        return await self._call_runtime(close_terminal_session, session_id)

    async def _close_all(self) -> dict:
        return await self._call_runtime(close_all_terminal_sessions)

    async def _list(self) -> dict:
        return await self._call_runtime(list_terminal_sessions)

    async def _resize(self, input: dict) -> dict:
        session_id, error = self._require_session_id(input)
        if error:
            return error
        return await self._call_runtime(
            resize_terminal_session,
            session_id,
            input.get("cols", DEFAULT_COLS),
            input.get("rows", DEFAULT_ROWS),
        )
