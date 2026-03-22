from helpers.extension import Extension

from usr.plugins.docker_terminal.helpers.session_runtime import (
    CLOSE_ALL_EVENT,
    CLOSE_EVENT,
    CREATE_EVENT,
    INPUT_EVENT,
    RESIZE_EVENT,
    SUBSCRIBE_EVENT,
    close_all_terminal_sessions,
    close_terminal_session,
    create_terminal_session,
    resize_terminal_session,
    send_terminal_input,
    subscribe_terminal_client,
)


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
        del instance

        if data is None:
            data = {}
        if response_data is None:
            return

        if event_type == SUBSCRIBE_EVENT:
            response_data.update(
                subscribe_terminal_client(
                    sid=sid,
                    subscribe=data.get("subscribe", True) is not False,
                )
            )
            return

        if event_type == CREATE_EVENT:
            response_data.update(
                create_terminal_session(
                    cwd=data.get("cwd"),
                    cols=data.get("cols"),
                    rows=data.get("rows"),
                )
            )
            return

        if event_type == CLOSE_EVENT:
            response_data.update(
                close_terminal_session(data.get("session_id"))
            )
            return

        if event_type == CLOSE_ALL_EVENT:
            response_data.update(close_all_terminal_sessions())
            return

        if event_type == RESIZE_EVENT:
            response_data.update(
                resize_terminal_session(
                    data.get("session_id"),
                    cols=data.get("cols"),
                    rows=data.get("rows"),
                )
            )
            return

        if event_type == INPUT_EVENT:
            response_data.update(
                send_terminal_input(
                    data.get("session_id"),
                    data.get("data", ""),
                )
            )
