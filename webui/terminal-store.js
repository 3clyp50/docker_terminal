import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { store as notificationStore } from "/components/notifications/notification-store.js";

const PLUGIN_NAME = "docker_terminal";
const TERMINAL_API = `plugins/${PLUGIN_NAME}/terminal`;
const XTERM_CSS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css";
const XTERM_JS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js";
const FIT_JS = "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js";
const BUFFER_LIMIT = 200000;
const MIN_HEIGHT = 200;
const MAX_VH = 0.6;
const DEFAULT_VH = 0.4;
const INPUT_BATCH_MS = 30;
const POLL_MS = 250;

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
    return clampHeight(Math.round(innerHeight * (Number(vh || 0) / 100)) || Math.round(innerHeight * DEFAULT_VH));
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
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ── store ──

const model = {
    panelOpen: false,
    panelHeight: Math.round(innerHeight * DEFAULT_VH),
    sessions: [],
    activeSessionId: null,
    loading: false,
    config: { ...DEFAULT_CONFIG },

    _terms: {},
    _pollId: null,
    _xtermReady: false,
    _xtermLoading: null,
    _configLoaded: false,
    _isCleaningUp: false,
    _panelHeightCustom: false,
    _buffers: {},
    _inputQueues: {},
    _inputTimers: {},
    _cachedCount: 0,
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
        const n = this.getSelectedSessionCount();
        return n === 0 ? "Open terminal" : `${n} active terminal${n === 1 ? "" : "s"}`;
    },

    async syncSelectedSessionCount() {
        if (this.panelOpen) return;
        try {
            const res = await this._api("list");
            if (res.ok && Array.isArray(res.sessions)) this._cachedCount = res.sessions.length;
        } catch (_) { /* ignore */ }
    },

    // ── panel lifecycle ──

    async togglePanel() {
        if (this.panelOpen) {
            this._isCleaningUp = true;
            this._stopPoll();
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
            this._err(errMsg(error, "Failed to open the terminal."));
        } finally {
            this.loading = false;
        }
    },

    async _openPanel() {
        await this._loadXterm();
        this._resetState();

        const res = await this._api("list");
        if (!res.ok) throw new Error(res.error || "Failed to list sessions.");

        this.sessions = (res.sessions || []).map((s) => ({
            id: s.id, name: `Session ${s.id + 1}`, type: s.type, cwd: s.cwd,
        }));
        this._cachedCount = this.sessions.length;
        this._pruneBuffers();
        this._startPoll();

        if (this.sessions.length === 0) {
            await this.createSession();
        } else {
            await this._activate(this.sessions[0].id);
        }
    },

    startResize(event) {
        if (!this.panelOpen) return;
        event.preventDefault();
        this._resizing = true;
        this._resizeY = event.clientY;
        this._resizeH = this.panelHeight;

        if (!this._boundMove) {
            this._boundMove = (e) => this._onDrag(e);
            this._boundEnd = () => this._endDrag();
        }
        document.addEventListener("mousemove", this._boundMove);
        document.addEventListener("mouseup", this._boundEnd);
    },

    // ── session operations ──

    async createSession() {
        this.loading = true;
        try {
            const res = await this._api("create");
            if (!res.ok) throw new Error(res.error || "Failed to create session.");

            const session = { id: res.session_id, name: `Session ${res.session_id + 1}`, type: res.type, cwd: res.cwd };
            this.sessions = [...this.sessions, session];
            this._cachedCount = this.sessions.length;
            await this._activate(session.id);
        } catch (error) {
            this._err(errMsg(error, "Failed to create session."));
        } finally {
            this.loading = false;
        }
    },

    async closeSession(sessionId) {
        try {
            const res = await this._api("close", { session_id: sessionId });
            if (!res.ok && res.error !== "Session not found") {
                throw new Error(res.error || "Failed to close session.");
            }
        } catch (error) {
            this._err(errMsg(error, "Failed to close session."));
            return;
        }

        this._disposeTerm(sessionId);
        delete this._buffers[sessionId];
        this.sessions = this.sessions.filter((s) => s.id !== sessionId);
        this._cachedCount = this.sessions.length;

        if (this.activeSessionId === sessionId) {
            if (this.sessions.length > 0) {
                await this._activate(this.sessions[0].id);
            } else {
                this.activeSessionId = null;
            }
        }
    },

    async switchSession(sessionId) {
        await this._activate(sessionId);
    },

    cleanup() {
        const preserve = this.config.preserve_sessions_on_hide !== false;
        this._cachedCount = preserve ? this.sessions.length : 0;
        this._endDrag();
        this._stopPoll();
        this._disposeAllTerms();
        if (!preserve) this._buffers = {};
        this._resetState();
        this._isCleaningUp = true;

        if (!preserve) {
            this._api("close_all").catch((e) => this._err(errMsg(e, "Failed to close sessions.")));
        }
    },

    // ── xterm ──

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
        })().finally(() => { this._xtermLoading = null; });

        return this._xtermLoading;
    },

    _ensureTerm(sessionId) {
        if (this._terms[sessionId]) return this._terms[sessionId];
        if (!W.Terminal || !W.FitAddon) return null;

        const el = document.getElementById(`terminal-${sessionId}`);
        if (!el) return null;

        const term = new W.Terminal({
            cursorBlink: this.config.cursor_blink,
            fontSize: this.config.font_size,
            fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
            theme: document.body.classList.contains("light-mode") ? LIGHT_THEME : DARK_THEME,
        });

        const fitAddon = new W.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(el);

        const buf = this._buffers[sessionId];
        if (buf) term.write(buf);

        term.onData((data) => this._enqueueInput(sessionId, data === "\r" ? "\n" : data));
        el.addEventListener("mousedown", () => this._focusTerm(sessionId));

        const ro = new ResizeObserver(() => {
            if (this.activeSessionId === sessionId) this._fitResize(sessionId);
        });
        ro.observe(el);

        this._terms[sessionId] = { element: el, fitAddon, resizeObserver: ro, term };
        return this._terms[sessionId];
    },

    _fitResize(sessionId) {
        const e = this._terms[sessionId];
        if (!e) return;
        try { e.fitAddon.fit(); } catch (_) { return; }
        this._api("resize", { session_id: sessionId, cols: e.term.cols, rows: e.term.rows }).catch(() => {});
    },

    _focusTerm(sessionId) {
        const e = this._terms[sessionId];
        if (e) requestAnimationFrame(() => e.term.focus());
    },

    // ── input batching ──

    _enqueueInput(sessionId, data) {
        this._inputQueues[sessionId] = (this._inputQueues[sessionId] || "") + data;
        if (this._inputTimers[sessionId] != null) return;
        this._inputTimers[sessionId] = setTimeout(() => this._flushInput(sessionId), INPUT_BATCH_MS);
    },

    _flushInput(sessionId) {
        delete this._inputTimers[sessionId];
        const queued = this._inputQueues[sessionId];
        if (!queued) return;
        delete this._inputQueues[sessionId];
        this._api("send", { session_id: sessionId, data: queued }).catch((error) => {
            if (!this._isCleaningUp) this._err(errMsg(error, "Failed to send input."));
        });
    },

    // ── polling ──

    async _pollActive() {
        if (this.activeSessionId === null) return;
        const sid = this.activeSessionId;
        try {
            const res = await this._api("read", { session_id: sid });
            if (!res.ok) {
                if (!this._isCleaningUp && res.error && res.error !== "Session not found") this._err(res.error);
                return;
            }
            if (!res.output) return;
            this._appendBuffer(sid, res.output);
            const e = this._ensureTerm(sid);
            if (e) e.term.write(res.output);
        } catch (error) {
            if (!this._isCleaningUp) this._err(errMsg(error, "Failed to read output."));
        }
    },

    _startPoll() {
        if (this._pollId) return;
        this._pollId = setInterval(() => void this._pollActive(), POLL_MS);
    },

    _stopPoll() {
        if (this._pollId) { clearInterval(this._pollId); this._pollId = null; }
    },

    // ── session activation ──

    async _activate(sessionId) {
        this.activeSessionId = sessionId;
        await afterPaint();
        this._ensureTerm(sessionId);
        this._fitResize(sessionId);
        this._focusTerm(sessionId);
        await this._pollActive();
    },

    // ── buffer helpers ──

    _appendBuffer(sessionId, output) {
        if (!output) return;
        const prev = this._buffers[sessionId] || "";
        this._buffers[sessionId] = (prev + output).slice(-BUFFER_LIMIT);
    },

    _pruneBuffers() {
        const active = new Set(this.sessions.map((s) => String(s.id)));
        for (const k of Object.keys(this._buffers)) {
            if (!active.has(k)) delete this._buffers[k];
        }
    },

    // ── term disposal ──

    _disposeTerm(sessionId) {
        if (this._inputTimers[sessionId] != null) {
            clearTimeout(this._inputTimers[sessionId]);
            delete this._inputTimers[sessionId];
        }
        delete this._inputQueues[sessionId];

        const e = this._terms[sessionId];
        if (!e) return;
        e.resizeObserver?.disconnect();
        e.term?.dispose();
        delete this._terms[sessionId];
    },

    _disposeAllTerms() {
        for (const id of Object.keys(this._inputTimers)) clearTimeout(this._inputTimers[id]);
        this._inputTimers = {};
        this._inputQueues = {};
        for (const id of Object.keys(this._terms)) this._disposeTerm(Number(id));
    },

    // ── config ──

    async _loadConfig(force = false) {
        if (this._configLoaded && !force) return;
        try {
            const res = await callJsonApi("plugins", {
                action: "get_config", plugin_name: PLUGIN_NAME, project_name: "", agent_profile: "",
            });
            this.config = this._normalizeConfig(res?.data);
        } catch (_) {
            this.config = { ...DEFAULT_CONFIG };
        }
        this._configLoaded = true;
        if (!this._panelHeightCustom) this.panelHeight = vhToPx(this.config.default_panel_height_vh);
    },

    _normalizeConfig(raw = {}) {
        const c = raw && typeof raw === "object" ? raw : {};
        const fs = Number(c.font_size);
        const vh = Number(c.default_panel_height_vh);
        return {
            startup_directory: typeof c.startup_directory === "string" ? c.startup_directory : DEFAULT_CONFIG.startup_directory,
            preserve_sessions_on_hide: c.preserve_sessions_on_hide !== false,
            font_size: Number.isFinite(fs) ? Math.min(24, Math.max(10, Math.round(fs))) : DEFAULT_CONFIG.font_size,
            cursor_blink: c.cursor_blink !== false,
            default_panel_height_vh: Number.isFinite(vh) ? Math.min(MAX_VH * 100, Math.max(20, Math.round(vh))) : DEFAULT_CONFIG.default_panel_height_vh,
        };
    },

    // ── resize drag ──

    _onDrag(event) {
        if (!this._resizing) return;
        const delta = this._resizeY - event.clientY;
        this._panelHeightCustom = true;
        this.panelHeight = clampHeight(this._resizeH + delta);
    },

    _endDrag() {
        if (!this._resizing) return;
        this._resizing = false;
        if (this._boundMove) {
            document.removeEventListener("mousemove", this._boundMove);
            document.removeEventListener("mouseup", this._boundEnd);
        }
    },

    // ── internals ──

    _resetState() {
        this.sessions = [];
        this.activeSessionId = null;
        this._terms = {};
        this._inputQueues = {};
        this._inputTimers = {};
        this._pollId = null;
        this._isCleaningUp = false;
    },

    _api(action, payload = {}) {
        return callJsonApi(TERMINAL_API, { action, ...payload });
    },

    _err(message) {
        void notificationStore.frontendError(message, "Docker Terminal", 6);
    },
};

export const store = createStore("dockerTerminal", model);
