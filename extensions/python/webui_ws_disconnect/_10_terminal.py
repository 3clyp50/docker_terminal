from helpers.extension import Extension

from usr.plugins.docker_terminal.helpers.session_runtime import remove_terminal_client


class TerminalWebSocketDisconnect(Extension):
    async def execute(self, sid: str = "", **kwargs):
        remove_terminal_client(sid)
