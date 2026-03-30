import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { getNamespacedClient } from "/js/websocket.js";
import { store as notificationStore } from "/components/notifications/notification-store.js";

const PLUGIN_NAME = "docker_terminal";
let _socket = null;

function getSocket() {
    if (_socket) return _socket;
    // New A0 system uses unified /ws; legacy uses /webui.
    // By first-use time, the core app will have initialized its /ws client.
    const ws = getNamespacedClient("/ws");
    _socket = ws.socket ? ws : getNamespacedClient("/webui");
    return _socket;
}

const XTERM_CSS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css";
const XTERM_JS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js";
const FIT_JS = "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js";

const BUFFER_LIMIT = 200000;
const MIN_HEIGHT = 200;
const MAX_VH = 0.6;
const DEFAULT_VH = 0.4;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const IS_MAC = typeof navigator !== "undefined" && /\bMac|iPhone|iPad|iPod\b/.test(navigator.platform || "");

const EVENT = Object.freeze({
    subscribe: "docker_terminal_subscribe",
    input: "docker_terminal_input",
    create: "docker_terminal_create",
    close: "docker_terminal_close",
    closeAll: "docker_terminal_close_all",
    resize: "docker_terminal_resize",
    output: "docker_terminal_output",
    sessionCreated: "docker_terminal_session_created",
    sessionClosed: "docker_terminal_session_closed",
    sessionsCleared: "docker_terminal_sessions_cleared",
});

/** @type {Window & { Terminal?: any, FitAddon?: { FitAddon: new () => any } }} */
const W = window;

const DEFAULT_CONFIG = Object.freeze({
    startup_directory: "",
    preserve_sessions_on_hide: true,
    font_size: 14,
    cursor_blink: true,
    default_panel_height_vh: 40,
});

const DARK_THEME = Object.freeze({
    background: "#0d1117", foreground: "#c9d1d9", cursor: "#c9d1d9",
    cursorAccent: "#0d1117", selection: "rgba(88, 166, 255, 0.3)",
    black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
    blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
    brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
});

const LIGHT_THEME = Object.freeze({
    background: "#fbfbfd", foreground: "#1f2937", cursor: "#1f2937",
    cursorAccent: "#fbfbfd", selection: "rgba(37, 99, 235, 0.18)",
    black: "#374151", red: "#c2410c", green: "#15803d", yellow: "#a16207",
    blue: "#2563eb", magenta: "#9333ea", cyan: "#0f766e", white: "#6b7280",
    brightBlack: "#4b5563", brightRed: "#dc2626", brightGreen: "#16a34a",
    brightYellow: "#ca8a04", brightBlue: "#3b82f6", brightMagenta: "#a855f7",
    brightCyan: "#14b8a6", brightWhite: "#111827",
});

function clampHeight(px) {
    return Math.min(Math.floor(innerHeight * MAX_VH), Math.max(MIN_HEIGHT, px));
}

function vhToPx(vh) {
    return clampHeight(
        Math.round(innerHeight * (Number(vh || 0) / 100)) || Math.round(innerHeight * DEFAULT_VH),
    );
}

function errMsg(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${url}"]`);
        if (existing) {
            existing.addEventListener("load", resolve, { once: true });
            existing.addEventListener("error", () => reject(new Error(`Failed to load ${url}`)), { once: true });
            return;
        }

        const el = document.createElement("script");
        el.src = url;
        el.onload = resolve;
        el.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(el);
    });
}

function afterPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function normalizeSession(raw) {
    const id = Number(raw?.id);
    if (!Number.isInteger(id) || id < 0) return null;

    return {
        id,
        name: `Session ${id + 1}`,
        type: typeof raw?.type === "string" && raw.type ? raw.type : "local",
        cwd: typeof raw?.cwd === "string" && raw.cwd ? raw.cwd : "~",
        buffer: typeof raw?.buffer === "string" ? raw.buffer.slice(-BUFFER_LIMIT) : "",
    };
}

function normalizeSessions(rawSessions) {
    if (!Array.isArray(rawSessions)) return [];

    const byId = new Map();
    for (const raw of rawSessions) {
        const session = normalizeSession(raw);
        if (session) byId.set(session.id, session);
    }

    return [...byId.values()].sort((left, right) => left.id - right.id);
}

function pickSessionId(sessions, ...candidates) {
    const ids = new Set(sessions.map((session) => session.id));
    for (const candidate of candidates) {
        if (ids.has(candidate)) return candidate;
    }
    return sessions[0]?.id ?? null;
}

function mergeBuffer(current, incoming) {
    if (typeof incoming !== "string") return current || "";
    if (!current) return incoming.slice(-BUFFER_LIMIT);
    return incoming.length >= current.length ? incoming.slice(-BUFFER_LIMIT) : current;
}

function requestData(response) {
    const first = Array.isArray(response?.results) ? response.results[0] : null;
    if (!first) return {};

    if (first.ok === false) {
        throw new Error(first.error?.error || first.error?.code || "Terminal request failed.");
    }

    const data = first.data && typeof first.data === "object" ? first.data : {};
    if (data.ok === false) {
        throw new Error(data.error || "Terminal request failed.");
    }

    return data;
}

const model = {
    panelOpen: false,
    panelHeight: Math.round(innerHeight * DEFAULT_VH),
    sessions: [],
    activeSessionId: null,
    loading: false,
    config: { ...DEFAULT_CONFIG },

    _terms: {},
    _buffers: {},
    _cachedCount: 0,
    _preferredSessionId: null,

    _xtermReady: false,
    _xtermLoading: null,
    _configLoaded: false,

    _socketLifecycleBound: false,
    _socketEventsBound: false,
    _socketConnected: false,
    _subscribed: false,
    _subscribePromise: null,
    _socketHandlers: null,

    _isCleaningUp: false,
    _panelHeightCustom: false,
    _resizing: false,
    _resizeY: 0,
    _resizeH: 0,
    _boundMove: null,
    _boundEnd: null,

    getPanelStyle() {
        return `height: ${this.panelHeight}px`;
    },

    getSelectedSessionCount() {
        return this.panelOpen ? this.sessions.length : this._cachedCount;
    },

    getTerminalButtonTitle() {
        const count = this.getSelectedSessionCount();
        return count === 0 ? "Open terminal" : `${count} active terminal${count === 1 ? "" : "s"}`;
    },

    async syncSelectedSessionCount() {
        if (this.panelOpen) return;
        this._bindSocketLifecycle();

        try {
            const data = await this._request(EVENT.subscribe, { subscribe: false });
            this._cachedCount = Array.isArray(data.sessions) ? data.sessions.length : 0;
        } catch (_) {
            // Ignore passive count refresh failures.
        }
    },

    async togglePanel() {
        if (this.panelOpen) {
            this._isCleaningUp = true;
            this._endDrag();
            this.panelOpen = false;
            return;
        }
        if (this.loading) return;

        await this._loadConfig(true);
        this.panelOpen = true;
        this.loading = true;

        try {
            await afterPaint();
            await this._openPanel();
        } catch (error) {
            this.panelOpen = false;
            this.cleanup();
            this._err(errMsg(error, "Failed to open the terminal."));
        } finally {
            this.loading = false;
        }
    },

    async _openPanel() {
        await this._loadXterm();
        this._resetPanelState();
        this._bindSocketLifecycle();
        await this._bindSocketEvents();
        await this._subscribeSessions({ refreshTerms: false });
        if (!this.panelOpen || !this._subscribed) return;

        if (this.sessions.length === 0) {
            await this.createSession();
            return;
        }

        const targetId = pickSessionId(
            this.sessions,
            this._preferredSessionId,
            this.activeSessionId,
        );
        if (targetId !== null) {
            await this._activate(targetId);
        }
    },

    startResize(event) {
        if (!this.panelOpen) return;

        event.preventDefault();
        this._resizing = true;
        this._resizeY = event.clientY;
        this._resizeH = this.panelHeight;

        if (!this._boundMove) {
            this._boundMove = (moveEvent) => this._onDrag(moveEvent);
            this._boundEnd = () => this._endDrag();
        }

        document.addEventListener("mousemove", this._boundMove);
        document.addEventListener("mouseup", this._boundEnd);
    },

    async createSession() {
        this.loading = true;
        try {
            const data = await this._request(
                EVENT.create,
                this._getCreatePayload(),
            );
            if (!this.panelOpen || !this._subscribed) return;
            const session = this._upsertSession(data.session);
            if (!session) throw new Error("Failed to create session.");
            await this._activate(session.id);
        } catch (error) {
            this._err(errMsg(error, "Failed to create session."));
        } finally {
            this.loading = false;
        }
    },

    async copySelection() {
        if (this.activeSessionId === null) return false;
        const entry = this._terms[this.activeSessionId];
        const selection = entry?.term?.getSelection?.() || "";
        if (!selection) return false;

        if (!navigator?.clipboard?.writeText) {
            this._err("Clipboard copy is unavailable in this browser context.");
            return false;
        }

        try {
            await navigator.clipboard.writeText(selection);
            return true;
        } catch (error) {
            this._err(errMsg(error, "Failed to copy terminal selection."));
            return false;
        }
    },

    async pasteFromClipboard() {
        const sessionId = this.activeSessionId;
        if (sessionId === null) return false;

        if (!navigator?.clipboard?.readText) {
            this._err("Clipboard paste is unavailable in this browser context.");
            return false;
        }

        let text = "";
        try {
            text = await navigator.clipboard.readText();
        } catch (error) {
            this._err(errMsg(error, "Failed to read clipboard."));
            return false;
        }

        if (!text) return true;
        return this._sendInput(sessionId, text);
    },

    async closeSession(sessionId) {
        try {
            await this._request(EVENT.close, { session_id: sessionId });
        } catch (error) {
            if (error instanceof Error && error.message === "Session not found") {
                this._removeSession(sessionId);
                return;
            }
            this._err(errMsg(error, "Failed to close session."));
            return;
        }

        this._removeSession(sessionId);
    },

    async switchSession(sessionId) {
        await this._activate(sessionId);
    },

    cleanup() {
        const preserve = this.config.preserve_sessions_on_hide !== false;
        const cachedCount = preserve ? this.sessions.length : 0;
        const preferredSessionId = preserve ? this.activeSessionId : null;
        const unsubscribePromise = this._subscribed ? this._unsubscribeSessions() : null;

        this._cachedCount = cachedCount;
        this._preferredSessionId = preferredSessionId;
        this._isCleaningUp = true;

        this._endDrag();
        this._unbindSocketEvents();
        this._disposeAllTerms();
        this._resetPanelState();

        if (unsubscribePromise) void unsubscribePromise;

        if (!preserve) {
            this._cachedCount = 0;
            this._preferredSessionId = null;
            void this._request(EVENT.closeAll).catch((error) => {
                this._err(errMsg(error, "Failed to close sessions."));
            });
        }
    },

    async _loadXterm() {
        if (this._xtermReady || (W.Terminal && W.FitAddon)) {
            this._xtermReady = true;
            return;
        }
        if (this._xtermLoading) return this._xtermLoading;

        this._xtermLoading = (async () => {
            if (!document.querySelector(`link[href="${XTERM_CSS}"]`)) {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = XTERM_CSS;
                document.head.appendChild(link);
            }

            if (!W.Terminal) await loadScript(XTERM_JS);
            if (!W.FitAddon) await loadScript(FIT_JS);

            this._xtermReady = Boolean(W.Terminal && W.FitAddon);
            if (!this._xtermReady) throw new Error("xterm assets did not load.");
        })().finally(() => {
            this._xtermLoading = null;
        });

        return this._xtermLoading;
    },

    _ensureTerm(sessionId) {
        if (this._terms[sessionId]) return this._terms[sessionId];
        if (!W.Terminal || !W.FitAddon) return null;

        const element = document.getElementById(`terminal-${sessionId}`);
        if (!element) return null;

        const term = new W.Terminal({
            cursorBlink: this.config.cursor_blink,
            fontSize: this.config.font_size,
            fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
            theme: document.body.classList.contains("light-mode") ? LIGHT_THEME : DARK_THEME,
        });

        const fitAddon = new W.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(element);
        term.attachCustomKeyEventHandler((event) => this._handleClipboardShortcut(sessionId, event));

        const buffer = this._buffers[sessionId];
        if (buffer) term.write(buffer);

        term.onData((data) => {
            void this._sendInput(sessionId, data, { notifyOnDisconnect: false });
        });

        term.textarea?.addEventListener("paste", (event) => {
            const text = event.clipboardData?.getData("text") || "";
            if (!text) return;
            event.preventDefault();
            void this._sendInput(sessionId, text);
        });

        element.addEventListener("mousedown", () => this._focusTerm(sessionId));

        const resizeObserver = new ResizeObserver(() => {
            if (this.activeSessionId === sessionId) this._fitResize(sessionId);
        });
        resizeObserver.observe(element);

        const entry = { element, fitAddon, resizeObserver, term };
        this._terms[sessionId] = entry;
        return entry;
    },

    _fitResize(sessionId) {
        const entry = this._terms[sessionId];
        if (!entry) return;

        try {
            entry.fitAddon.fit();
        } catch (_) {
            return;
        }

        void this._request(EVENT.resize, {
            session_id: sessionId,
            cols: entry.term.cols,
            rows: entry.term.rows,
        }).catch(() => {});
    },

    _focusTerm(sessionId) {
        const entry = this._terms[sessionId];
        if (entry) requestAnimationFrame(() => entry.term.focus());
    },

    async _activate(sessionId) {
        const normalizedId = Number(sessionId);
        if (!Number.isInteger(normalizedId) || !this.panelOpen) return;

        this.activeSessionId = normalizedId;
        this._preferredSessionId = normalizedId;

        await afterPaint();
        if (!this.panelOpen || this.activeSessionId !== normalizedId) return;

        const entry = this._ensureTerm(normalizedId);
        if (!entry) return;

        this._fitResize(normalizedId);
        this._focusTerm(normalizedId);
    },

    async _bindSocketEvents() {
        if (this._socketEventsBound) return;

        this._socketHandlers = {
            output: (envelope) => this._handleOutput(envelope.data),
            sessionCreated: (envelope) => this._handleSessionCreated(envelope.data),
            sessionClosed: (envelope) => this._handleSessionClosed(envelope.data),
            sessionsCleared: () => this._handleSessionsCleared(),
        };

        await Promise.all([
            getSocket().on(EVENT.output, this._socketHandlers.output),
            getSocket().on(EVENT.sessionCreated, this._socketHandlers.sessionCreated),
            getSocket().on(EVENT.sessionClosed, this._socketHandlers.sessionClosed),
            getSocket().on(EVENT.sessionsCleared, this._socketHandlers.sessionsCleared),
        ]);

        this._socketConnected = getSocket().isConnected();
        this._socketEventsBound = true;
    },

    _unbindSocketEvents() {
        if (!this._socketEventsBound || !this._socketHandlers) return;

        getSocket().off(EVENT.output, this._socketHandlers.output);
        getSocket().off(EVENT.sessionCreated, this._socketHandlers.sessionCreated);
        getSocket().off(EVENT.sessionClosed, this._socketHandlers.sessionClosed);
        getSocket().off(EVENT.sessionsCleared, this._socketHandlers.sessionsCleared);

        this._socketHandlers = null;
        this._socketEventsBound = false;
    },

    _bindSocketLifecycle() {
        if (this._socketLifecycleBound) return;

        this._socketLifecycleBound = true;
        this._socketConnected = getSocket().isConnected();

        getSocket().onConnect(() => {
            this._socketConnected = true;
            if (this.panelOpen && this._subscribed) {
                void this._subscribeSessions({ refreshTerms: true });
            }
        });

        getSocket().onDisconnect(() => {
            this._socketConnected = false;
        });

        getSocket().onError((error) => {
            if (!this.panelOpen || this._isCleaningUp) return;
            this._err(errMsg(error, "Terminal websocket error."));
        });
    },

    async _subscribeSessions({ refreshTerms }) {
        if (this._subscribePromise) return this._subscribePromise;

        this._subscribed = true;
        this._subscribePromise = this._request(EVENT.subscribe, { subscribe: true })
            .then((data) => {
                if (!this.panelOpen || !this._subscribed) return;
                return this._applySnapshot(data.sessions, { refreshTerms });
            })
            .finally(() => {
                this._subscribePromise = null;
            });

        return this._subscribePromise;
    },

    async _unsubscribeSessions() {
        if (!this._subscribed) return;

        this._subscribed = false;
        try {
            await this._request(EVENT.subscribe, { subscribe: false });
        } catch (_) {
            // Best effort on panel teardown.
        }
    },

    async _applySnapshot(rawSessions, { refreshTerms = false } = {}) {
        const sessions = normalizeSessions(rawSessions);
        const nextActiveId = pickSessionId(
            sessions,
            this.activeSessionId,
            this._preferredSessionId,
        );

        const nextBuffers = {};
        for (const session of sessions) {
            nextBuffers[session.id] = session.buffer;
        }

        if (refreshTerms) this._disposeAllTerms();

        this.sessions = sessions.map(({ buffer, ...session }) => session);
        this._buffers = nextBuffers;
        this._cachedCount = this.sessions.length;
        this.activeSessionId = nextActiveId;
        this._preferredSessionId = nextActiveId;

        if (nextActiveId !== null && this.panelOpen) {
            await this._activate(nextActiveId);
        }
    },

    _handleOutput(payload = {}) {
        if (!this.panelOpen || !this._subscribed) return;

        const sessionId = Number(payload.session_id);
        const output = typeof payload.output === "string" ? payload.output : "";
        if (!Number.isInteger(sessionId) || !output) return;

        this._appendBuffer(sessionId, output);

        const entry = this._terms[sessionId];
        if (entry) entry.term.write(output);
    },

    _handleSessionCreated(payload = {}) {
        if (!this.panelOpen || !this._subscribed) return;

        const hadSessions = this.sessions.length > 0;
        const session = this._upsertSession(payload.session);
        if (!session) return;

        if (!hadSessions && this.activeSessionId === null) {
            void this._activate(session.id);
        }
    },

    _handleSessionClosed(payload = {}) {
        if (!this.panelOpen || !this._subscribed) return;
        this._removeSession(payload.session_id);
    },

    _handleSessionsCleared() {
        if (!this.panelOpen || !this._subscribed) return;

        this._disposeAllTerms();
        this.sessions = [];
        this.activeSessionId = null;
        this._buffers = {};
        this._cachedCount = 0;
        this._preferredSessionId = null;
    },

    _upsertSession(rawSession) {
        const session = normalizeSession(rawSession);
        if (!session) return null;

        const view = {
            id: session.id,
            name: session.name,
            type: session.type,
            cwd: session.cwd,
        };

        const existingIndex = this.sessions.findIndex((current) => current.id === session.id);
        if (existingIndex === -1) {
            this.sessions = [...this.sessions, view].sort((left, right) => left.id - right.id);
        } else {
            const nextSessions = [...this.sessions];
            nextSessions[existingIndex] = view;
            this.sessions = nextSessions;
        }

        this._buffers[session.id] = mergeBuffer(this._buffers[session.id], session.buffer);
        this._cachedCount = this.sessions.length;
        return view;
    },

    _removeSession(sessionId) {
        const normalizedId = Number(sessionId);
        if (!Number.isInteger(normalizedId)) return;

        const exists = this.sessions.some((session) => session.id === normalizedId);
        if (!exists) return;

        this._disposeTerm(normalizedId);
        delete this._buffers[normalizedId];
        this.sessions = this.sessions.filter((session) => session.id !== normalizedId);
        this._cachedCount = this.sessions.length;

        if (this.activeSessionId !== normalizedId) return;

        const nextActiveId = this.sessions[0]?.id ?? null;
        this.activeSessionId = nextActiveId;
        this._preferredSessionId = nextActiveId;

        if (nextActiveId !== null && this.panelOpen) {
            void this._activate(nextActiveId);
        }
    },

    _appendBuffer(sessionId, output) {
        if (!output) return;

        const previous = this._buffers[sessionId] || "";
        this._buffers[sessionId] = (previous + output).slice(-BUFFER_LIMIT);
    },

    _isCopyShortcut(event) {
        if (event.altKey) return false;

        const key = String(event.key || "").toLowerCase();
        const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (mod && event.shiftKey && key === "c") return true;
        return !IS_MAC && event.ctrlKey && !event.shiftKey && key === "insert";
    },

    _isPasteShortcut(event) {
        if (event.altKey) return false;

        const key = String(event.key || "").toLowerCase();
        const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (mod && event.shiftKey && key === "v") return true;
        return !IS_MAC && event.shiftKey && key === "insert";
    },

    _handleClipboardShortcut(sessionId, event) {
        if (event.type !== "keydown") return true;

        if (this._isCopyShortcut(event)) {
            if (!navigator?.clipboard?.writeText) return true;
            event.preventDefault();
            if (sessionId === this.activeSessionId) void this.copySelection();
            return false;
        }

        if (this._isPasteShortcut(event)) {
            if (!navigator?.clipboard?.readText) return true;
            event.preventDefault();
            if (sessionId === this.activeSessionId) void this.pasteFromClipboard();
            return false;
        }

        return true;
    },

    _disposeTerm(sessionId) {
        const entry = this._terms[sessionId];
        if (!entry) return;

        entry.resizeObserver?.disconnect();
        entry.term?.dispose();
        delete this._terms[sessionId];
    },

    _disposeAllTerms() {
        for (const sessionId of Object.keys(this._terms)) {
            this._disposeTerm(Number(sessionId));
        }
    },

    _getCreatePayload() {
        const activeTerm = this.activeSessionId !== null ? this._terms[this.activeSessionId] : null;
        return {
            cols: activeTerm?.term?.cols || DEFAULT_COLS,
            rows: activeTerm?.term?.rows || DEFAULT_ROWS,
        };
    },

    async _loadConfig(force = false) {
        if (this._configLoaded && !force) return;

        try {
            const response = await callJsonApi("plugins", {
                action: "get_config",
                plugin_name: PLUGIN_NAME,
                project_name: "",
                agent_profile: "",
            });
            this.config = this._normalizeConfig(response?.data);
        } catch (_) {
            this.config = { ...DEFAULT_CONFIG };
        }

        this._configLoaded = true;
        if (!this._panelHeightCustom) {
            this.panelHeight = vhToPx(this.config.default_panel_height_vh);
        }
    },

    _normalizeConfig(raw = {}) {
        const config = raw && typeof raw === "object" ? raw : {};
        const fontSize = Number(config.font_size);
        const defaultPanelHeight = Number(config.default_panel_height_vh);

        return {
            startup_directory: typeof config.startup_directory === "string"
                ? config.startup_directory
                : DEFAULT_CONFIG.startup_directory,
            preserve_sessions_on_hide: config.preserve_sessions_on_hide !== false,
            font_size: Number.isFinite(fontSize)
                ? Math.min(24, Math.max(10, Math.round(fontSize)))
                : DEFAULT_CONFIG.font_size,
            cursor_blink: config.cursor_blink !== false,
            default_panel_height_vh: Number.isFinite(defaultPanelHeight)
                ? Math.min(MAX_VH * 100, Math.max(20, Math.round(defaultPanelHeight)))
                : DEFAULT_CONFIG.default_panel_height_vh,
        };
    },

    _onDrag(event) {
        if (!this._resizing) return;

        const delta = this._resizeY - event.clientY;
        this._panelHeightCustom = true;
        this.panelHeight = clampHeight(this._resizeH + delta);
    },

    _endDrag() {
        if (!this._resizing) return;

        this._resizing = false;
        if (!this._boundMove) return;

        document.removeEventListener("mousemove", this._boundMove);
        document.removeEventListener("mouseup", this._boundEnd);
    },

    _resetPanelState() {
        this.sessions = [];
        this.activeSessionId = null;
        this._terms = {};
        this._buffers = {};
        this._isCleaningUp = false;
        this._subscribed = false;
    },

    async _request(eventType, payload = {}) {
        const response = await getSocket().request(eventType, payload);
        return requestData(response);
    },

    async _emit(eventType, payload = {}) {
        await getSocket().emit(eventType, payload);
    },

    async _sendInput(sessionId, data, { notifyOnDisconnect = true } = {}) {
        if (!data) return true;
        if (!this.panelOpen || !this._subscribed || !this._socketConnected) {
            if (notifyOnDisconnect && this.panelOpen && !this._isCleaningUp) {
                this._err("Terminal is disconnected.");
            }
            return false;
        }

        try {
            await this._emit(EVENT.input, { session_id: sessionId, data });
            return true;
        } catch (error) {
            if (!this._isCleaningUp && this.panelOpen) {
                this._err(errMsg(error, "Failed to send input."));
            }
            return false;
        }
    },

    _err(message) {
        void notificationStore.frontendError(message, "Docker Terminal", 6);
    },
};

export const store = createStore("dockerTerminal", model);
