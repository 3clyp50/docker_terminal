# -*- coding: utf-8 -*-
"""Legacy HTTP terminal endpoint retained only as an explicit websocket-only stub."""

from flask import Request

from helpers.api import ApiHandler


class TerminalHandler(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict:
        return {
            "ok": False,
            "error": (
                "docker_terminal now uses the /webui websocket transport only; "
                "HTTP terminal actions are disabled"
            ),
        }
