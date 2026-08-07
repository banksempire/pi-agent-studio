/**
 * Chat store — the app-side state for the Chat app, backed by the REAL pi
 * agent through the backend server (src/pi-studio/server/index.mjs).
 *
 * - Session list + messages come from real ~/.pi/agent/sessions files
 * - Sending a message runs the real agent (createAgentSession in the
 *   backend); replies stream live over Server-Sent Events
 * - Closing a chat window only closes the *view* — a running session
 *   keeps generating in the backend and the sessions list reflects it
 */
import { reactive, watch } from 'vue';
import { collectAllTabs, firstTile } from '@sf/workspace/tree';
import type { WorkspaceApi } from '@sf/composables/useWorkspace';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'summary' | 'bash' | 'custom' | 'toolResult' | 'system';
  text: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  model?: string | null;
  stopReason?: string | null;
  error?: string | null;
  ts: number;
  /** Compaction duration in ms — set when the summary arrived while the
   *  page session had the compaction context (start/end status events);
   *  preserved across file-refresh upserts so it survives syncTail. */
  elapsedMs?: number;
  command?: string;
  exitCode?: number;
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
}

export interface SessionStatsView {
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  lastActivity: number;
  messageCount: number;
  userMessages: number;
}

export interface ChatSession {
  /** UI id (encoded file path) — also the key for the workspace tab */
  id: string;
  file: string;
  title: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
  status: 'idle' | 'running';
  /** a manual /compact is running on the backend (LLM summarization) */
  compacting: boolean;
  /** outcome of the last /compact: null = none yet, 'done'/'failed' persists until audited */
  compactResult: 'done' | 'failed' | null;
  /** when the last /compact started (for the WIP elapsed timer) */
  compactStartedAt: number;
  /** when the last /compact finished (for the done box's total time) */
  compactEndedAt: number;
  preview: string;
  stats: SessionStatsView;
  messages: DisplayMessage[];
  messagesLoaded: boolean;
  /** pagination: are there older messages not loaded yet? */
  hasMoreOlder: boolean;
  /** entry id of the oldest loaded message (cursor for loading older) */
  oldestId: string | null;
  loadingOlder: boolean;
  /**
   * False while the session exists only in frontend state (created via
   * /api/new-chat; the session file is written by the SDK only once the
   * first assistant message lands). Such sessions must survive list
   * refreshes until they appear on disk.
   */
  onDisk: boolean;
}

export type BackendStatus = 'connecting' | 'online' | 'offline';

export type SendKeyMode = 'enter' | 'shiftEnter';

interface ChatState {
  sessions: ChatSession[];
  /** session of the chat window currently activated in the workspace (null = none) */
  activeChatId: string | null;
  /** tab ids currently open in the workspace */
  openViewTabIds: Set<string>;
  backend: BackendStatus;
  backendError: string;
  /** last send failure, shown in chat windows */
  lastError: string;
  /** global UI preferences (localStorage-backed, apply to all chats) */
  prefs: {
    /** which key sends a message; the other key inserts a newline */
    sendKey: SendKeyMode;
    /** render message text as markdown */
    renderMarkdown: boolean;
  };
}

const state = reactive<ChatState>({
  sessions: [],
  activeChatId: null,
  openViewTabIds: new Set(),
  backend: 'connecting',
  backendError: '',
  lastError: '',
  prefs: loadPrefs(),
});

/** Tab id scheme: one tab per session, stable across open/close. */
const TAB_PREFIX = 'chat-';
const chatTabId = (sessionId: string) => TAB_PREFIX + sessionId;

// ── Global preferences (localStorage, apply to ALL chats) ──────────────────

const PREFS_KEY = 'sf-chat:prefs';
function loadPrefs(): ChatState['prefs'] {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      return {
        sendKey: j.sendKey === 'shiftEnter' ? 'shiftEnter' : 'enter',
        renderMarkdown: j.renderMarkdown !== false,
      };
    }
  } catch { /* corrupted or unavailable — use defaults */ }
  return { sendKey: 'enter', renderMarkdown: true };
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* storage unavailable */ }
}
function setSendKey(mode: SendKeyMode) {
  state.prefs.sendKey = mode;
  savePrefs();
}

// ── Backend client ─────────────────────────────────────────────────────────

const NEW_CHAT_CWD = '/workspace/sf';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

interface SessionInfo {
  file: string;
  name: string | null;
  cwd: string;
  created: number;
  modified: number;
  messageCount: number;
  userMessages: number;
  firstMessage: string;
  preview: string;
  model: string | null;
  tokens: { input: number; output: number; total: number };
  cost: number;
  running: boolean;
}

function toSession(raw: SessionInfo): ChatSession {
  const id = encodeURIComponent(raw.file);
  const title = raw.name
    ?? (raw.firstMessage ? (raw.firstMessage.length > 60 ? raw.firstMessage.slice(0, 60) + '…' : raw.firstMessage) : 'Untitled chat');
  return {
    id,
    file: raw.file,
    title,
    cwd: raw.cwd,
    compacting: false,
    compactResult: null,
    compactStartedAt: 0,
    compactEndedAt: 0,
    createdAt: raw.created,
    lastActivity: raw.modified,
    status: raw.running ? 'running' : 'idle',
    preview: raw.preview || raw.firstMessage,
    stats: {
      model: raw.model,
      tokensIn: raw.tokens.input,
      tokensOut: raw.tokens.output,
      costUsd: raw.cost,
      startedAt: raw.created,
      lastActivity: raw.modified,
      messageCount: raw.messageCount,
      userMessages: raw.userMessages,
    },
    messages: [],
    messagesLoaded: false,
    hasMoreOlder: false,
    oldestId: null,
    loadingOlder: false,
    onDisk: true,
  };
}

let listTimer: number | null = null;

async function fetchList() {
  try {
    const { sessions } = await api<{ sessions: SessionInfo[] }>('/api/sessions');
    const prev = new Map(state.sessions.map((s) => [s.file, s]));
    const onDisk = new Set(sessions.map((s) => s.file));
    // Sessions that never hit disk yet (fresh UI chats before the first
    // assistant message) are absent from the backend list — keep them so
    // open windows don't lose their session mid-flight.
    const memoryOnly = state.sessions.filter((s) => !onDisk.has(s.file) && !s.onDisk);
    state.sessions = [
      ...memoryOnly,
      ...sessions.map((raw) => {
        const old = prev.get(raw.file);
        const s = toSession(raw);
        s.onDisk = true;
        if (old) {
          s.messages = old.messages;
          s.messagesLoaded = old.messagesLoaded;
          s.hasMoreOlder = old.hasMoreOlder;
          s.oldestId = old.oldestId;
          s.loadingOlder = old.loadingOlder;
          // Transient /compact UI state must survive list refreshes (the
          // backend emits refresh right after appending the compaction entry).
          s.compacting = old.compacting;
          s.compactResult = old.compactResult;
          s.compactStartedAt = old.compactStartedAt;
          s.compactEndedAt = old.compactEndedAt;
        }
        return s;
      }),
    ];
    state.backend = 'online';
    state.backendError = '';
  } catch (e) {
    state.backend = 'offline';
    state.backendError = e instanceof Error ? e.message : String(e);
  }
}

/** Public refresh — re-read the session list from the backend (slash results use it). */
export function refreshList(): Promise<void> {
  return fetchList();
}

// ── SSE live events ────────────────────────────────────────────────────────

function byFile(file: string): ChatSession | undefined {
  return state.sessions.find((s) => s.file === file);
}

function upsert(s: ChatSession, m: DisplayMessage) {
  const i = s.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    // A file-refresh copy of a summary (same hashId) has no elapsed data —
    // keep the one computed when the live event arrived.
    if (m.elapsedMs === undefined) m.elapsedMs = s.messages[i].elapsedMs;
    s.messages[i] = m;
  } else s.messages.push(m);
}

function lastAssistant(s: ChatSession): DisplayMessage | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'assistant') return s.messages[i];
  }
  return undefined;
}

function mergeToolResult(s: ChatSession, toolCallId: string, text: string, isError: boolean) {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const tc = s.messages[i].toolCalls?.find((t) => t.id === toolCallId);
    if (tc) { tc.result = text; tc.isError = isError; return; }
  }
}

function handleEvent(ev: any) {
  switch (ev.type) {
    case 'session_status': {
      const s = byFile(ev.file);
      if (s) s.status = ev.status;
      break;
    }
    case 'compaction_status': {
      // /compact progress: 'started' lights the WIP indicator and resets the
      // previous outcome; 'done'/'failed' stops it and keeps the result so the
      // chat window can flash the box and offer click-to-audit.
      const s = byFile(ev.file);
      if (!s) break;
      s.compacting = ev.status === 'started';
      if (ev.status === 'started') {
        s.compactResult = null;
        s.compactStartedAt = Date.now();
      } else if (ev.status === 'done') {
        s.compactResult = 'done';
        s.compactEndedAt = Date.now();
      } else if (ev.status === 'failed') {
        s.compactResult = 'failed';
        s.compactEndedAt = Date.now();
      }
      break;
    }
    case 'message': {
      const s = byFile(ev.file);
      if (!s) break;
      if (!s.messagesLoaded) {
        // Session was opened without messages — load them now.
        void fetchMessages(s.id);
        break;
      }
      const m = ev.message as DisplayMessage;
      if (m.role === 'user') {
        // Replace the optimistic pending message (same text). It may no longer
        // be the last message: a queued message's turn starts only after the
        // previous turn's stream has pushed more messages in between.
        const opt = s.messages.findIndex(
          (x) => x.role === 'user' && x.id.startsWith('pending-') && x.text === m.text,
        );
        if (opt >= 0) s.messages[opt] = m;
        else upsert(s, m);
      } else if (m.role === 'toolResult') {
        mergeToolResult(s, m.toolCallId ?? '', m.text, !!m.isError);
      } else {
        // The summary message follows compaction_status 'done' in the same
        // broadcast, so the start/end context is already on the session —
        // stamp the duration onto the message (the box shows elapsed, not
        // the absolute timestamp).
        if (m.role === 'summary' && s.compactEndedAt > s.compactStartedAt) {
          m.elapsedMs = s.compactEndedAt - s.compactStartedAt;
        }
        upsert(s, m);
      }
      break;
    }
    case 'tool_start': {
      const s = byFile(ev.file);
      if (!s) break;
      const asst = lastAssistant(s);
      if (asst) {
        asst.toolCalls ??= [];
        if (!asst.toolCalls.some((t) => t.id === ev.toolCallId)) {
          asst.toolCalls.push({
            id: ev.toolCallId,
            name: ev.toolName,
            args: JSON.stringify(ev.args ?? {}, null, 1),
          });
        }
      }
      break;
    }
    case 'tool_partial':
    case 'tool_result': {
      const s = byFile(ev.file);
      if (s) mergeToolResult(s, ev.toolCallId, ev.text ?? '', !!ev.isError);
      break;
    }
    case 'refresh': {
      // Anything new on disk (our own appends OR external writers like the
      // pi TUI) — refresh the list and pull new messages into loaded views.
      const s = byFile(ev.file);
      if (s && s.messagesLoaded) void syncTail(s.id);
      void fetchList();
      break;
    }
  }
}

let es: EventSource | null = null;

function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.onopen = () => {
    state.backend = 'online';
    // Reconnect (or first connect): heal any events missed while offline.
    syncAllTails();
  };
  es.onerror = () => { state.backend = 'offline'; }; // EventSource auto-reconnects
  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  };
}

/** Pull messages newer than the last loaded one into every loaded session. */
function syncAllTails() {
  for (const s of state.sessions) {
    if (s.messagesLoaded) void syncTail(s.id);
  }
}

// ── Workspace binding ──────────────────────────────────────────────────────

let ws: WorkspaceApi | null = null;
let firstBind = true;

function activeTabOfFocusedTile(): string {
  if (!ws) return '';
  const tile = ws.focusedTileId ? ws.findTileGlobal(ws.focusedTileId) : null;
  return tile?.activeId ?? '';
}

function openTabIds(): string[] {
  if (!ws) return [];
  return ws.roots.flatMap((r) => collectAllTabs(r.node));
}

function targetTileId(): string {
  if (!ws) return '';
  if (ws.focusedTileId && ws.findTileGlobal(ws.focusedTileId)) return ws.focusedTileId;
  for (const root of ws.roots) {
    const t = firstTile(root.node);
    if (t) return t.id;
  }
  return '';
}

/**
 * Called by the shell once the framework reports its workspace is ready.
 * Watches the workspace so the store always knows which chat window is
 * activated and which session views are open.
 */
export function bindWorkspace(api: WorkspaceApi) {
  ws = api;

  watch(
    () => activeTabOfFocusedTile(),
    (tabId) => {
      state.activeChatId = tabId && tabId.startsWith(TAB_PREFIX)
        ? tabId.slice(TAB_PREFIX.length)
        : null;
    },
    { immediate: true },
  );

  watch(
    () => openTabIds(),
    (ids) => {
      state.openViewTabIds = new Set(ids);
    },
    { immediate: true },
  );

  // Tile-strip "+" = start a new chat. The framework's default "+" creates
  // an editor-style "Untitled" tab; a chat product has no use for that, so
  // the app decides what a new workspace item means here.
  api.setNewTabHandler(() => { void newChat(); }, 'New Chat');

  connectEvents();
  void fetchList().then(() => {
    if (firstBind) {
      firstBind = false;
      // Show the most recent real conversation on first launch.
      if (state.sessions.length > 0) openChat(state.sessions[0].id);
    }
  });

  // Periodic refresh picks up sessions created outside the UI (e.g. TUI).
  if (listTimer === null) {
    listTimer = window.setInterval(() => void fetchList(), 15000);
  }
}

// ── Session helpers ────────────────────────────────────────────────────────

export function findSession(sessionId: string): ChatSession | undefined {
  return state.sessions.find((s) => s.id === sessionId);
}

/** Is this session's view currently open in the workspace? */
export function isViewOpen(sessionId: string): boolean {
  return state.openViewTabIds.has(chatTabId(sessionId));
}

/** Sessions considered active: generating in the backend, or with an open view. */
export function activeSessions(): ChatSession[] {
  return state.sessions
    .filter((s) => s.status === 'running' || isViewOpen(s.id))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

// ── Public operations ──────────────────────────────────────────────────────

/** Create a real chat session (backend) and open its window. */
export async function newChat(): Promise<void> {
  try {
    const { file } = await api<{ file: string; cwd: string }>('/api/new-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: NEW_CHAT_CWD }),
    });
    // The file is created by the backend on the first message — build the
    // session entry locally so the window opens immediately.
    const id = encodeURIComponent(file);
    const now = Date.now();
    if (!findSession(id)) {
      state.sessions.unshift({
        id, file, title: 'New Chat', cwd: NEW_CHAT_CWD,
        createdAt: now, lastActivity: now,
        status: 'idle', compacting: false, compactResult: null, compactStartedAt: 0, compactEndedAt: 0, preview: '',
        stats: {
          model: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
          startedAt: now, lastActivity: now, messageCount: 0, userMessages: 0,
        },
        messages: [], messagesLoaded: true,
        hasMoreOlder: false, oldestId: null, loadingOlder: false,
        onDisk: false,
      });
    }
    openChat(id);
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    state.backend = 'offline';
  }
}

/** Open (or activate, if already open) a session's window in the workspace. */
export function openChat(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);

  // Already open somewhere → just activate it (dedupe by tab id).
  const existing = ws.findTabGlobal(tabId);
  if (existing) {
    ws.ops.activateTab(existing.id, tabId);
    // Re-sync on every activation: the session may have advanced while
    // its view was closed or while events were missed.
    if (!s.messagesLoaded) void fetchMessages(sessionId);
    else void syncTail(sessionId);
    return;
  }

  const tileId = targetTileId();
  if (!tileId) return;
  ws.ops.openTab(tileId, {
    id: tabId,
    label: s.title,
    icon: '💬',
    content: 'chat-window',
    props: { sessionId },
  });
  if (!s.messagesLoaded) void fetchMessages(sessionId);
  else void syncTail(sessionId);
}

/** Send a user message; the real pi agent replies (streaming via SSE). */
export async function sendMessage(sessionId: string, text: string, opts: { wait?: boolean } = {}) {
  const s = findSession(sessionId);
  const trimmed = text.trim();
  if (!s || !trimmed) return;
  state.lastError = '';

  // Optimistic append (the backend confirms with the same text shortly).
  // No "already running" guard here: the backend decides per message — a
  // plain message INTERRUPTS a busy turn; `wait: true` (/wait) queues it
  // until the current turn finishes.
  const mid = `pending-${Date.now()}`;
  s.messages.push({ id: mid, role: 'user', text: trimmed, ts: Date.now() });
  try {
    await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file, message: trimmed, ...(opts.wait ? { wait: true } : {}) }),
    });
  } catch (e) {
    const i = s.messages.findIndex((m) => m.id === mid);
    if (i >= 0) s.messages.splice(i, 1);
    state.lastError = e instanceof Error ? e.message : String(e);
  }
}

/** Abort the running agent (the conversation stays; generation halts). */
export async function stopSession(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  try {
    await api('/api/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file }),
    });
  } catch { /* session not running — fine */ }
}

/** Append a local-only system message (slash command output) to a session. */
export function appendLocalMessage(sessionId: string, msg: Partial<DisplayMessage> & { text: string }) {
  const s = findSession(sessionId);
  if (!s) return;
  s.messages.push({
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'system',
    ts: Date.now(),
    ...msg,
  } as DisplayMessage);
}

/** Close the workspace *view* of a session. The session itself is untouched. */
export function closeChatView(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);
  if (ws.findTabGlobal(tabId)) ws.ops.closeTab(tabId);
}

/** Global preference: render markdown in every chat window. */
export function setRenderMarkdown(on: boolean) {
  state.prefs.renderMarkdown = on;
  savePrefs();
}

/** Number of messages fetched per page (newest window). */
const PAGE_SIZE = 50;

/**
 * Load a session's messages from the backend. First call replaces the
 * list with the newest PAGE_SIZE; `older: true` prepends the page before
 * the current oldest message (scroll-up pagination).
 */
export async function fetchMessages(sessionId: string, opts?: { older?: boolean }) {
  const s = findSession(sessionId);
  if (!s) return;
  const params = new URLSearchParams({ file: s.file, limit: String(PAGE_SIZE) });
  if (opts?.older && s.oldestId) params.set('before', s.oldestId);
  try {
    const data = await api<any>(`/api/sessions/messages?${params.toString()}`);
    const incoming = (data.messages ?? []) as DisplayMessage[];
    if (opts?.older) {
      // Prepend, keeping any live/optimistic messages at the tail intact.
      s.messages = [...incoming, ...s.messages];
    } else {
      s.messages = incoming;
      s.messagesLoaded = true;
    }
    s.oldestId = data.oldestId ?? null;
    s.hasMoreOlder = !!data.hasMore;
    s.loadingOlder = false;
    applySessionInfo(s, data);
  } catch (e) {
    s.loadingOlder = false;
    state.lastError = `Failed to load messages: ${e instanceof Error ? e.message : e}`;
  }
}

/** Load the page of messages older than the current oldest one. */
export async function loadOlder(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || s.loadingOlder || !s.hasMoreOlder || !s.oldestId) return;
  s.loadingOlder = true;
  await fetchMessages(sessionId, { older: true });
}

/**
 * Pull only the messages newer than the last loaded one and append them
 * (used for live sync: SSE refresh events, reconnect, window activation).
 * Dedupes by id and by (role, timestamp) — streamed messages carry live
 * ids that differ from their persisted entry ids.
 */
export async function syncTail(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !s.messagesLoaded) return;
  // Cursor: the last message that has a stable file entry id.
  let lastEntryId: string | null = null;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const id = s.messages[i].id;
    if (id && !id.startsWith('pending-') && !id.startsWith('asst-') && !id.startsWith('toolresult-') && !id.startsWith('msg-')) {
      lastEntryId = id;
      break;
    }
  }
  if (!lastEntryId) return;
  try {
    const data = await api<any>(`/api/sessions/messages?file=${encodeURIComponent(s.file)}&after=${encodeURIComponent(lastEntryId)}`);
    const incoming = (data.messages ?? []) as DisplayMessage[];
    if (incoming.length > 0) {
      // Dedupe by id, or by (role, timestamp): streamed messages carry live
      // ids that differ from their persisted entry ids. One set each —
      // avoids the old per-item O(n) scan over the loaded messages.
      const seenId = new Set(s.messages.map((m) => m.id));
      const seenTs = new Set(s.messages.map((m) => `${m.role}:${m.ts}`));
      const fresh = incoming.filter((m) => !seenId.has(m.id) && !seenTs.has(`${m.role}:${m.ts}`));
      if (fresh.length > 0) s.messages = [...s.messages, ...fresh];
    }
    // Full-session info rides along — keep stats fresh too.
    applySessionInfo(s, data);
  } catch { /* transient — next refresh/connect will retry */ }
}

/** Merge the full-session info that rides along on message responses. */
function applySessionInfo(s: ChatSession, data: any) {
  s.stats.model = data.model ?? s.stats.model;
  s.stats.tokensIn = data.tokens?.input ?? s.stats.tokensIn;
  s.stats.tokensOut = data.tokens?.output ?? s.stats.tokensOut;
  s.stats.costUsd = data.cost ?? s.stats.costUsd;
  s.stats.messageCount = data.messageCount ?? s.stats.messageCount;
  s.status = data.running ? 'running' : s.status;
}

// ── Public API ─────────────────────────────────────────────────────────────

export const store = {
  get sessions() { return state.sessions; },
  get activeChatId() { return state.activeChatId; },
  get openViewTabIds() { return state.openViewTabIds; },
  get backend() { return state.backend; },
  get backendError() { return state.backendError; },
  get lastError() { return state.lastError; },
  clearLastError() { state.lastError = ''; },
  findSession,
  isViewOpen,
  activeSessions,
  newChat,
  openChat,
  sendMessage,
  stopSession,
  closeChatView,
  get prefs() { return state.prefs; },
  setSendKey,
  setRenderMarkdown,
  fetchMessages,
  loadOlder,
  syncTail,
  bindWorkspace,
  refreshList,
  appendLocalMessage,
};

export function useChatStore() {
  return store;
}

// ── Formatting helpers (shared by components) ──────────────────────────────

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}
