import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { store as notificationStore } from "/components/notifications/notification-store.js";

/**
 * @typedef {object} TerminalConfig
 * @property {string} startup_directory
 * @property {boolean} preserve_sessions_on_hide
 * @property {number} font_size
 * @property {boolean} cursor_blink
 * @property {number} default_panel_height_vh
 */

/**
 * @typedef {object} TerminalSession
 * @property {number} id
 * @property {string} name
 * @property {string} type
 * @property {string} cwd
 */

/**
 * @typedef {object} TerminalEntry
 * @property {HTMLElement} element
 * @property {any} fitAddon
 * @property {ResizeObserver} resizeObserver
 * @property {any} term
 */

const PLUGINS_API = "plugins";
const PLUGIN_NAME = "docker_terminal";
const TERMINAL_API = "plugins/docker_terminal/terminal";
const XTERM_CSS_URL = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css";
const XTERM_JS_URL = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js";
const FIT_JS_URL = "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js";
const SESSION_BUFFER_LIMIT = 200000;
const PANEL_MIN_HEIGHT = 200;
const PANEL_MAX_VH = 0.6;
const PANEL_DEFAULT_VH = 0.4;
const DEFAULT_CONFIG = Object.freeze(/** @type {TerminalConfig} */ ({
    startup_directory: "",
    preserve_sessions_on_hide: true,
    font_size: 14,
    cursor_blink: true,
    default_panel_height_vh: 40,
}));
const xtermWindow = /** @type {Window & typeof globalThis & { Terminal?: any, FitAddon?: { FitAddon: new () => any } }} */ (window);

const model = {
    panelOpen: false,
    panelHeight: Math.round(window.innerHeight * PANEL_DEFAULT_VH),
    sessions: /** @type {TerminalSession[]} */ ([]),
    activeSessionId: /** @type {number | null} */ (null),
    loading: false,
    config: /** @type {TerminalConfig} */ ({ ...DEFAULT_CONFIG }),
    _terms: /** @type {Record<number, TerminalEntry>} */ ({}),
    _pollId: /** @type {ReturnType<typeof setInterval> | null} */ (null),
    _xtermReady: false,
    _xtermLoadPromise: /** @type {Promise<void> | null} */ (null),
    _configLoadPromise: /** @type {Promise<TerminalConfig> | null} */ (null),
    _configLoaded: false,
    _cleanupPromise: /** @type {Promise<{ ok: boolean, preserved: boolean }> | null} */ (null),
    _isOpeningPanel: false,
    _isCleaningUp: false,
    _isResizing: false,
    _panelHeightCustomized: false,
    _resizeStartY: 0,
    _resizeStartHeight: 0,
    _dragListeners: /** @type {{ move: (event: MouseEvent) => void, end: () => void }} */ ({
        move: () => {},
        end: () => {},
    }),
    _hasDragListeners: false,
    _buffers: /** @type {Record<string, string>} */ ({}),
    _cachedSessionCount: 0,

    getPanelStyle() {
        return `height: ${this.panelHeight}px`;
    },

    getSelectedSessionCount() {
        return this.panelOpen ? this.sessions.length : this._cachedSessionCount;
    },

    getTerminalButtonTitle() {
        const count = this.getSelectedSessionCount();
        if (count === 0) {
            return "Open terminal";
        }
        return `${count} active terminal${count === 1 ? "" : "s"}`;
    },

    async syncSelectedSessionCount() {
        if (this.panelOpen) return;
        try {
            const res = await this._callTerminalApi("list");
            if (res.ok && Array.isArray(res.sessions)) {
                this._cachedSessionCount = res.sessions.length;
            }
        } catch (_error) {
            // Ignore
        }
    },

    async togglePanel() {
        if (this.panelOpen) {
            this._isCleaningUp = true;
            this._stopPoll();
            this._onDragEnd();
            this.panelOpen = false;
            return;
        }

        if (this._isOpeningPanel) {
            return;
        }

        await this._loadConfig({ force: true });
        this.panelOpen = true;
        this._isOpeningPanel = true;
        try {
            await this._afterDomPaint();
            await this.onOpen();
        } finally {
            this._isOpeningPanel = false;
        }
    },

    startResize(event) {
        this._onDragStart(event);
    },

    async onOpen() {
        if (this._cleanupPromise) {
            await this._cleanupPromise.catch(() => {});
        }

        if (!this._configLoaded) {
            await this._loadConfig();
        }
        this._resetState({ keepXterm: true });
        this.loading = true;

        try {
            await this._loadXterm();
            await this._loadSessions();
            this._startPoll();

            if (this.sessions.length === 0) {
                await this.createSession();
                return;
            }

            await this._activateSession(this.sessions[0].id);
        } catch (error) {
            this._notifyError(this._getErrorMessage(error, "Failed to open the terminal."));
        } finally {
            this.loading = false;
        }
    },

    async createSession() {
        this.loading = true;
        try {
            const res = await this._callTerminalApi("create");
            if (!res.ok) {
                throw new Error(res.error || "Failed to create terminal session.");
            }

            const session = this._mapSession(res.session_id, res.type, res.cwd);
            this.sessions = [...this.sessions, session];
            this._cachedSessionCount = this.sessions.length;
            await this._activateSession(session.id);
        } catch (error) {
            this._notifyError(this._getErrorMessage(error, "Failed to create terminal session."));
        } finally {
            this.loading = false;
        }
    },

    async closeSession(sessionId) {
        try {
            const res = await this._callTerminalApi("close", {
                session_id: sessionId,
            });
            if (!res.ok && res.error !== "Session not found") {
                throw new Error(res.error || "Failed to close terminal session.");
            }
        } catch (error) {
            this._notifyError(this._getErrorMessage(error, "Failed to close terminal session."));
            return;
        }

        this._disposeTerm(sessionId);
        this._dropSessionBuffer(sessionId);
        this.sessions = this.sessions.filter((session) => session.id !== sessionId);
        this._cachedSessionCount = this.sessions.length;

        if (this.activeSessionId === sessionId) {
            const nextSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
            if (nextSessionId !== null) {
                await this._activateSession(nextSessionId);
            } else {
                this.activeSessionId = null;
            }
        }
    },

    async switchSession(sessionId) {
        await this._activateSession(sessionId);
    },

    async _activateSession(sessionId) {
        this.activeSessionId = sessionId;
        await this._afterDomPaint();
        this._ensureTerm(sessionId);
        this._fitAndResize(sessionId);
        this._focusTerm(sessionId);
    },

    cleanup() {
        const preserveSessions = this.config.preserve_sessions_on_hide !== false;

        this._cachedSessionCount = preserveSessions ? this.sessions.length : 0;
        this._onDragEnd();
        this._stopPoll();
        this._disposeAllTerms();
        if (!preserveSessions) {
            this._clearBuffers();
        }
        this._resetState({ keepXterm: true, preserveSessionCount: true });
        this._isCleaningUp = true;

        const cleanupPromise = (async () => {
            if (!preserveSessions) {
                const res = await this._callTerminalApi("close_all");
                if (!res.ok) {
                    throw new Error(res.error || "Failed to close terminal sessions.");
                }
            }
            return {
                ok: true,
                preserved: preserveSessions,
            };
        })().catch((error) => {
            this._notifyError(this._getErrorMessage(error, "Failed to clean up terminal sessions."));
            return {
                ok: false,
                preserved: preserveSessions,
            };
        }).finally(() => {
            this._isCleaningUp = false;
            if (this._cleanupPromise === cleanupPromise) {
                this._cleanupPromise = null;
            }
        });

        this._cleanupPromise = cleanupPromise;
        return cleanupPromise;
    },

    async _loadXterm() {
        if (this._xtermReady || (xtermWindow.Terminal && xtermWindow.FitAddon)) {
            this._xtermReady = true;
            return;
        }

        if (this._xtermLoadPromise) {
            return this._xtermLoadPromise;
        }

        this._xtermLoadPromise = new Promise((resolve, reject) => {
            const finish = () => {
                this._xtermReady = Boolean(xtermWindow.Terminal && xtermWindow.FitAddon);
                if (this._xtermReady) {
                    resolve(undefined);
                    return;
                }
                reject(new Error("xterm assets did not load correctly."));
            };

            if (!document.querySelector(`link[href="${XTERM_CSS_URL}"]`)) {
                const css = document.createElement("link");
                css.rel = "stylesheet";
                css.href = XTERM_CSS_URL;
                document.head.appendChild(css);
            }

            const ensureFitAddon = () => {
                if (xtermWindow.FitAddon) {
                    finish();
                    return;
                }

                const fitScript = document.querySelector(`script[src="${FIT_JS_URL}"]`);
                if (fitScript) {
                    fitScript.addEventListener("load", finish, { once: true });
                    fitScript.addEventListener(
                        "error",
                        () => reject(new Error("Failed to load xterm fit addon.")),
                        { once: true },
                    );
                    return;
                }

                const script = document.createElement("script");
                script.src = FIT_JS_URL;
                script.onload = finish;
                script.onerror = () => reject(new Error("Failed to load xterm fit addon."));
                document.head.appendChild(script);
            };

            if (xtermWindow.Terminal) {
                ensureFitAddon();
                return;
            }

            const terminalScript = document.querySelector(`script[src="${XTERM_JS_URL}"]`);
            if (terminalScript) {
                terminalScript.addEventListener("load", ensureFitAddon, { once: true });
                terminalScript.addEventListener(
                    "error",
                    () => reject(new Error("Failed to load xterm.")),
                    { once: true },
                );
                return;
            }

            const script = document.createElement("script");
            script.src = XTERM_JS_URL;
            script.onload = ensureFitAddon;
            script.onerror = () => reject(new Error("Failed to load xterm."));
            document.head.appendChild(script);
        }).finally(() => {
            this._xtermLoadPromise = null;
        });

        return this._xtermLoadPromise;
    },

    async _loadSessions() {
        const res = await this._callTerminalApi("list");
        if (!res.ok) {
            throw new Error(res.error || "Failed to load terminal sessions.");
        }
        this.sessions = (res.sessions || []).map((session) =>
            this._mapSession(session.id, session.type, session.cwd),
        );
        this._cachedSessionCount = this.sessions.length;
        const activeKeys = new Set(
            this.sessions.map((session) => this._getBufferKey(session.id)),
        );
        Object.keys(this._buffers)
            .filter((key) => !activeKeys.has(key))
            .forEach((key) => {
                delete this._buffers[key];
            });
    },

    _ensureTerm(sessionId) {
        if (this._terms[sessionId]) {
            return this._terms[sessionId];
        }
        if (!xtermWindow.Terminal || !xtermWindow.FitAddon) {
            return null;
        }

        const element = document.getElementById(`terminal-${sessionId}`);
        if (!element) {
            return null;
        }

        const term = new xtermWindow.Terminal({
            cursorBlink: this.config.cursor_blink,
            fontSize: this.config.font_size,
            fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
            theme: this._getTerminalTheme(),
        });

        const fitAddon = new xtermWindow.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(element);
        const buffer = this._getSessionBuffer(sessionId);
        if (buffer) {
            term.write(buffer);
        }

        term.onData((data) => {
            const payload = data === "\r" ? "\n" : data;
            this._callTerminalApi("send", {
                session_id: sessionId,
                data: payload,
            }).catch((error) => {
                if (!this._isCleaningUp) {
                    this._notifyError(this._getErrorMessage(error, "Failed to send terminal input."));
                }
            });
        });

        element.addEventListener("mousedown", () => this._focusTerm(sessionId));

        const resizeObserver = new ResizeObserver(() => {
            if (this.activeSessionId !== sessionId) return;
            this._fitAndResize(sessionId);
        });
        resizeObserver.observe(element);

        this._terms[sessionId] = {
            element,
            fitAddon,
            resizeObserver,
            term,
        };
        return this._terms[sessionId];
    },

    _fitAndResize(sessionId) {
        const entry = this._terms[sessionId];
        if (!entry) return;

        try {
            entry.fitAddon.fit();
        } catch (_) {
            return;
        }

        this._callTerminalApi("resize", {
            session_id: sessionId,
            cols: entry.term.cols,
            rows: entry.term.rows,
        }).catch(() => {});
    },

    _focusTerm(sessionId) {
        const entry = this._terms[sessionId];
        if (!entry) return;
        requestAnimationFrame(() => entry.term.focus());
    },

    async _pollActiveSession() {
        if (this.activeSessionId === null) return;

        const sessionId = this.activeSessionId;
        try {
            const res = await this._callTerminalApi("read", {
                session_id: sessionId,
            });
            if (!res.ok) {
                if (!this._isCleaningUp && res.error && res.error !== "Session not found") {
                    this._notifyError(res.error);
                }
                return;
            }

            if (!res.output) return;

            this._appendSessionBuffer(sessionId, res.output);
            const entry = this._ensureTerm(sessionId);
            if (entry) {
                entry.term.write(res.output);
            }
        } catch (error) {
            if (!this._isCleaningUp) {
                this._notifyError(this._getErrorMessage(error, "Failed to read terminal output."));
            }
        }
    },

    _startPoll() {
        if (this._pollId) return;
        this._pollId = setInterval(() => {
            void this._pollActiveSession();
        }, 250);
    },

    _stopPoll() {
        if (this._pollId) {
            clearInterval(this._pollId);
            this._pollId = null;
        }
    },

    _disposeTerm(sessionId) {
        const entry = this._terms[sessionId];
        if (!entry) return;

        entry.resizeObserver?.disconnect();
        entry.term?.dispose();
        delete this._terms[sessionId];
    },

    _disposeAllTerms() {
        Object.keys(this._terms).forEach((sessionId) => {
            this._disposeTerm(Number(sessionId));
        });
    },

    _mapSession(sessionId, type, cwd) {
        return {
            id: sessionId,
            name: `Session ${Number(sessionId) + 1}`,
            type,
            cwd,
        };
    },

    _getBufferKey(sessionId) {
        return String(sessionId);
    },

    _getSessionBuffer(sessionId) {
        return this._buffers[this._getBufferKey(sessionId)] || "";
    },

    _appendSessionBuffer(sessionId, output) {
        if (!output) return;
        const key = this._getBufferKey(sessionId);
        const next = `${this._buffers[key] || ""}${output}`;
        this._buffers[key] = next.slice(-SESSION_BUFFER_LIMIT);
    },

    _dropSessionBuffer(sessionId) {
        delete this._buffers[this._getBufferKey(sessionId)];
    },

    _clearBuffers() {
        this._buffers = {};
    },

    _notifyError(message) {
        void notificationStore.frontendError(message, "Docker Terminal", 6);
    },

    _getErrorMessage(error, fallback) {
        return error instanceof Error && error.message
            ? error.message
            : fallback;
    },

    _callTerminalApi(action, payload = {}) {
        return callJsonApi(TERMINAL_API, {
            action,
            ...payload,
        });
    },

    async _loadConfig({ force = false } = {}) {
        if (this._configLoadPromise) {
            return this._configLoadPromise;
        }
        if (this._configLoaded && !force) {
            return this.config;
        }

        this._configLoadPromise = (async () => {
            try {
                const res = await callJsonApi(PLUGINS_API, {
                    action: "get_config",
                    plugin_name: PLUGIN_NAME,
                    project_name: "",
                    agent_profile: "",
                });
                this._applyConfig(this._normalizeConfig(res?.data));
            } catch (_error) {
                this._applyConfig(this._normalizeConfig());
            } finally {
                this._configLoaded = true;
                this._configLoadPromise = null;
            }
            return this.config;
        })();

        return this._configLoadPromise;
    },

    _applyConfig(nextConfig) {
        this.config = nextConfig;
        if (!this._panelHeightCustomized) {
            this.panelHeight = this._getDefaultPanelHeightPx(
                nextConfig.default_panel_height_vh,
            );
        }
    },

    /**
     * @param {Partial<TerminalConfig> | null | undefined} rawConfig
     * @returns {TerminalConfig}
     */
    _normalizeConfig(rawConfig = {}) {
        const config = rawConfig && typeof rawConfig === "object"
            ? rawConfig
            : {};
        const fontSize = Number(config.font_size);
        const panelHeightVh = Number(config.default_panel_height_vh);

        return {
            startup_directory: typeof config.startup_directory === "string"
                ? config.startup_directory
                : DEFAULT_CONFIG.startup_directory,
            preserve_sessions_on_hide: config.preserve_sessions_on_hide !== false,
            font_size: Number.isFinite(fontSize)
                ? Math.min(24, Math.max(10, Math.round(fontSize)))
                : DEFAULT_CONFIG.font_size,
            cursor_blink: config.cursor_blink !== false,
            default_panel_height_vh: Number.isFinite(panelHeightVh)
                ? Math.min(PANEL_MAX_VH * 100, Math.max(20, Math.round(panelHeightVh)))
                : DEFAULT_CONFIG.default_panel_height_vh,
        };
    },

    _getDefaultPanelHeightPx(vh) {
        const maxHeight = Math.floor(window.innerHeight * PANEL_MAX_VH);
        const configuredHeight = Math.round(
            window.innerHeight * (Number(vh || 0) / 100),
        );
        return Math.min(
            maxHeight,
            Math.max(PANEL_MIN_HEIGHT, configuredHeight || Math.round(window.innerHeight * PANEL_DEFAULT_VH)),
        );
    },

    _isLightMode() {
        return document.body.classList.contains("light-mode");
    },

    _getTerminalTheme() {
        if (this._isLightMode()) {
            return {
                background: "#fbfbfd",
                foreground: "#1f2937",
                cursor: "#1f2937",
                cursorAccent: "#fbfbfd",
                selection: "rgba(37, 99, 235, 0.18)",
                black: "#374151",
                red: "#c2410c",
                green: "#15803d",
                yellow: "#a16207",
                blue: "#2563eb",
                magenta: "#9333ea",
                cyan: "#0f766e",
                white: "#6b7280",
                brightBlack: "#4b5563",
                brightRed: "#dc2626",
                brightGreen: "#16a34a",
                brightYellow: "#ca8a04",
                brightBlue: "#3b82f6",
                brightMagenta: "#a855f7",
                brightCyan: "#14b8a6",
                brightWhite: "#111827",
            };
        }

        return {
            background: "#0d1117",
            foreground: "#c9d1d9",
            cursor: "#c9d1d9",
            cursorAccent: "#0d1117",
            selection: "rgba(88, 166, 255, 0.3)",
            black: "#484f58",
            red: "#ff7b72",
            green: "#3fb950",
            yellow: "#d29922",
            blue: "#58a6ff",
            magenta: "#bc8cff",
            cyan: "#39c5cf",
            white: "#b1bac4",
            brightBlack: "#6e7681",
            brightRed: "#ffa198",
            brightGreen: "#56d364",
            brightYellow: "#e3b341",
            brightBlue: "#79c0ff",
            brightMagenta: "#d2a8ff",
            brightCyan: "#56d4dd",
            brightWhite: "#f0f6fc",
        };
    },

    _resetState({ keepXterm = false, preserveSessionCount = false } = {}) {
        this.sessions = [];
        this.activeSessionId = null;
        this.loading = false;
        if (!preserveSessionCount) this._cachedSessionCount = 0;
        this._terms = {};
        this._pollId = null;
        this._isCleaningUp = false;
        if (!keepXterm) {
            this._xtermReady = false;
            this._xtermLoadPromise = null;
        }
    },

    _afterDomPaint() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });
    },

    _onDragStart(event) {
        if (!this.panelOpen) {
            return;
        }

        event.preventDefault();
        this._isResizing = true;
        this._resizeStartY = event.clientY;
        this._resizeStartHeight = this.panelHeight;

        if (!this._hasDragListeners) {
            this._dragListeners = {
                move: (moveEvent) => this._onDrag(moveEvent),
                end: () => this._onDragEnd(),
            };
            this._hasDragListeners = true;
        }

        document.addEventListener("mousemove", this._dragListeners.move);
        document.addEventListener("mouseup", this._dragListeners.end);
    },

    _onDrag(event) {
        if (!this._isResizing) {
            return;
        }

        const delta = this._resizeStartY - event.clientY;
        const maxHeight = Math.floor(window.innerHeight * PANEL_MAX_VH);
        const nextHeight = this._resizeStartHeight + delta;
        this._panelHeightCustomized = true;
        this.panelHeight = Math.min(maxHeight, Math.max(PANEL_MIN_HEIGHT, nextHeight));
    },

    _onDragEnd() {
        if (!this._isResizing) {
            return;
        }

        this._isResizing = false;
        if (this._hasDragListeners) {
            document.removeEventListener("mousemove", this._dragListeners.move);
            document.removeEventListener("mouseup", this._dragListeners.end);
        }
    },
};

export const store = createStore("dockerTerminal", model);
