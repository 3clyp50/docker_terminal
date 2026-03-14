# Docker Terminal

Embedded multi-session terminal panel for Agent Zero.

This plugin adds a terminal button to the chat input area and opens a docked terminal panel directly inside the Agent Zero UI. It supports multiple PTY-backed sessions, tab switching, live resize, persistent sessions while hidden, and a configurable startup directory.

## Features

- Open a terminal panel directly from the Agent Zero chat UI
- Automatically create the first session when the panel opens
- Run multiple terminal sessions with tab switching
- Resize the panel vertically from the UI
- Keep sessions alive while the panel is hidden, or close them on hide
- Configure startup directory, font size, cursor blink, and default panel height
- Works from `usr/plugins/docker_terminal` without any symlink or install script

Plugin settings are available under the `Developer` settings section.

## Usage

After the plugin is enabled:

1. Open Agent Zero in the browser.
2. Click the `Terminal` button near the chat input.
3. The panel opens and creates a session automatically if none exist yet.
4. Use the `+` tab button to create additional sessions.
5. Use the close button on a tab to close a session.
6. Collapse the panel with the arrow button when you want to hide it.

## Configuration

The plugin exposes the following settings:

- `startup_directory`: absolute path or `/a0/...` path used for new sessions
- `preserve_sessions_on_hide`: keep sessions running when the panel is hidden
- `font_size`: terminal font size in pixels
- `cursor_blink`: enable or disable the blinking cursor
- `default_panel_height_vh`: initial panel height as viewport percentage

Default configuration:

```yaml
startup_directory: ""
preserve_sessions_on_hide: true
font_size: 14
cursor_blink: true
default_panel_height_vh: 40
```

## Notes

- The terminal runs inside the Agent Zero runtime environment, so it has access to the same filesystem and tools available to that runtime.
- The frontend loads `xterm.js` and `xterm-addon-fit` from jsDelivr CDN at runtime.
- This plugin is designed for the Agent Zero plugin system and should live at the repository root when published as a standalone plugin repository.

## Repository Layout

```text
docker_terminal/
├── plugin.yaml
├── default_config.yaml
├── api/
├── extensions/
├── terminal_helpers/
└── webui/
```

## License

MIT
