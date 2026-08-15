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

import { BLANK_CONTENT, type ExternalDropTarget, type WorkspaceApi } from '@sf/composables/useWorkspace';
import type { WorkspaceTabDef } from '@sf/types/layout';
import { collectAllTabs, firstTile } from '@sf/workspace/tree';
import { reactive, watch } from 'vue';

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
  /** Image attachments of a user message: [{ data: base64, mimeType }] */
  images?: { data: string; mimeType: string }[];
  model?: string | null;
  /** provider id of the assistant turn (from the SDK AssistantMessage) */
  provider?: string | null;
  /** thinking level in effect when the assistant message was produced */
  thinkingLevel?: string | null;
  stopReason?: string | null;
  error?: string | null;
  ts: number;
  /** The optimistic user row failed to reach the backend — render a ↻ resend
   *  affordance. Cleared when the message is accepted (ack) or re-sent. */
  sendFailed?: boolean;
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
  /** prompt-cache read/written tokens (TUI /session "Cached/Uncached") */
  cacheRead: number;
  cacheWrite: number;
  /** full prompt volume: input + cacheRead + cacheWrite */
  promptTokens: number;
  costUsd: number;
  /** per-model cost breakdown ("provider/model" vs "Tools/summaries") */
  costBreakdown: { key: string; cost: number; tokens: number }[];
  /** prompt tokens re-billed as fresh after cache misses (TUI "Cache Re-billed") */
  cacheWaste: { missedCost: number; missedTokens: number; missCount: number };
  startedAt: number;
  lastActivity: number;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
}

/** One node of the left-panel Directory tree (backend /api/tree shape). */
export interface DirNode {
  name: string;
  path: string;
  /** recursive: how many sessions live under this folder */
  count: number;
  children: DirNode[];
}

export interface ChatSession {
  /** UI id (encoded file path) — also the key for the workspace tab */
  id: string;
  /** the session UUID from the file header (TUI /session "ID:") */
  sessionId: string | null;
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
  /** summarizer failure reason from the backend (shown in the failed bubble) */
  compactError: string | null;
  preview: string;
  stats: SessionStatsView;
  messages: DisplayMessage[];
  messagesLoaded: boolean;
  /** pagination: are there older messages not loaded yet? */
  hasMoreOlder: boolean;
  /** entry id of the oldest loaded message (cursor for loading older) */
  oldestId: string | null;
  loadingOlder: boolean;
  /** Context gauge (backend /api/sessions `context`): tokens estimate +
   *  model context window; percent null = unknown after a compaction. */
  context: { tokens: number | null; window: number; percent: number | null } | null;
  /**
   * False while the session exists only in frontend state (created via
   * /api/new-chat; the session file is written by the SDK only once the
   * first assistant message lands). Such sessions must survive list
   * refreshes until they appear on disk.
   */
  onDisk: boolean;
}

export type BackendStatus = 'connecting' | 'online' | 'offline';

/** One heartbeat outcome for the latency popup: good (ms) or lost (null). */
export type PingSample = { t: number; ms: number | null };

export type SendKeyMode = 'enter' | 'shiftEnter';

interface ChatState {
  sessions: ChatSession[];
  /** session of the chat window currently activated in the workspace (null = none) */
  activeChatId: string | null;
  /** tab ids currently open in the workspace */
  openViewTabIds: Set<string>;
  /**
   * Tab id of the session view currently in REVIEW mode (opened from a
   * history list click, dimmed tab). It auto-closes when another history
   * item is opened without interaction; any interaction (clicking its tab,
   * typing, sending) exits review and pins the window.
   */
  reviewTabId: string | null;
  /** directory filter from the left panel tree: sessions whose cwd is
   *  under ANY selected folder are shown (empty set = all) */
  selectedDirs: Set<string>;
  /** Directory tree, pushed by the backend on change (fetched once on load) */
  tree: DirNode | null;
  /** expanded/collapsed per tree node path — kept in the store so it
   *  survives switching sections/panels (the component remounts) */
  treeCollapsed: Set<string>;
  backend: BackendStatus;
  /** last /api/health round-trip in ms (null = no measurement yet) */
  backendPing: number | null;
  /** the latest heartbeat got no response within its timeout — reported as
   *  a lost packet (the late answer is discarded, never a huge ping) */
  backendLost: boolean;
  /** rolling heartbeat window for the latency popup: every probe outcome,
   *  good (ms) or lost (null), kept for PING_WINDOW_MS (5 min) */
  pingSamples: PingSample[];
  /** last send failure, shown in chat windows */
  lastError: string;
  /** unsent composer text per session (tab content instances are REUSED by
   *  the framework when switching tabs — without per-session state, text
   *  typed in one window would leak into the next) */
  drafts: Record<string, string>;
  /** global UI preferences (localStorage-backed, apply to all chats) */
  prefs: {
    /** which key sends a message; the other key inserts a newline */
    sendKey: SendKeyMode;
    /** render message text as markdown */
    renderMarkdown: boolean;
  };
}

// ── Global preferences (localStorage, apply to ALL chats) ──────────────────
// NOTE: both this block and the drafts block below sit ABOVE the `state`
// creation — the loaders run inside the state literal, and their const keys
// must already be initialized (a TDZ ReferenceError inside the try/catch
// would silently fall back to defaults).

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
  } catch {
    /* corrupted or unavailable — use defaults */
  }
  return { sendKey: 'enter', renderMarkdown: true };
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* storage unavailable */
  }
}
function setSendKey(mode: SendKeyMode) {
  state.prefs.sendKey = mode;
  savePrefs();
}

// ── Unsent composer drafts (localStorage, per session — survive reloads) ──

const DRAFTS_KEY = 'sf-chat:drafts';
function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return j;
    }
  } catch {
    /* corrupted or unavailable — start empty */
  }
  return {};
}
function saveDrafts() {
  try {
    // Once the session list is known, drop drafts of sessions that no
    // longer exist so the storage doesn't accumulate junk keys.
    if (state.sessions.length > 0) {
      const known = new Set(state.sessions.map((s) => s.id));
      for (const id of Object.keys(state.drafts)) {
        if (!known.has(id)) delete state.drafts[id];
      }
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts));
  } catch {
    /* storage unavailable */
  }
}

// ── Per-window UI state (survives workspace persistence) ───────────────────
// Each workspace window may carry state that is captured into workspace
// snapshots — e.g. the chat composer's drag-resized height. The store is
// the single source of truth; the window-state provider registered in
// bindWorkspace merges it into snapshots (keyed by tab id) and restores
// it on apply.

export interface WindowUi {
  /** Drag-resized composer height in px (null = default one-line box). */
  composerHeight: number | null;
}

const windowUi = reactive<Record<string, WindowUi>>({});

/** Per-window UI state of a session (undefined until first set). */
export function windowUiOf(sessionId: string): WindowUi | undefined {
  return windowUi[sessionId];
}

let windowPersistTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleWindowPersist() {
  if (windowPersistTimer) clearTimeout(windowPersistTimer);
  // The framework can't observe window-internal state — nudge the
  // workspace auto-save so the height survives reloads.
  windowPersistTimer = setTimeout(() => ws?.persistNow(), 400);
}

/** Set a window's drag-resized composer height (null = reset to default). */
export function setComposerHeight(sessionId: string, height: number | null) {
  let ui = windowUi[sessionId];
  if (!ui) {
    ui = { composerHeight: null };
    windowUi[sessionId] = ui;
  }
  if (ui.composerHeight === height) return;
  ui.composerHeight = height;
  scheduleWindowPersist();
}

const state = reactive<ChatState>({
  sessions: [],
  activeChatId: null,
  openViewTabIds: new Set(),
  reviewTabId: null,
  selectedDirs: new Set(),
  tree: null,
  treeCollapsed: new Set(),
  backend: 'connecting',
  backendPing: null,
  backendLost: false,
  pingSamples: [],
  lastError: '',
  drafts: loadDrafts(),
  prefs: loadPrefs(),
});

// ── Pending chats registry (localStorage) ─────────────────────────────────
// A "New Chat" becomes a real session only on its first message; until then
// its window is a local-only entry. The registry remembers these across
// refreshes so a restored workspace tab (framework auto-save / saved
// workspace) can find its pending session again instead of rendering a
// blank ghost window.

const PENDING_KEY = 'sf-chat:pending';

interface PendingChatInfo {
  file: string;
  cwd: string;
  createdAt: number;
}

function loadPendingChats(): PendingChatInfo[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) {
        return j.filter((p) => p && typeof p.file === 'string');
      }
    }
  } catch {
    /* corrupted or unavailable — start empty */
  }
  return [];
}

function persistPendingChats(list: PendingChatInfo[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    /* storage unavailable */
  }
}

/** Build the local session entry for a not-yet-materialized chat. */
function pendingSessionEntry(file: string, cwd: string, createdAt: number): ChatSession {
  return {
    id: encodeURIComponent(file),
    sessionId: null,
    file,
    title: 'New Chat',
    cwd,
    createdAt,
    lastActivity: createdAt,
    status: 'idle',
    compacting: false,
    compactResult: null,
    compactStartedAt: 0,
    compactEndedAt: 0,
    compactError: null,
    preview: '',
    stats: {
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 0,
      costUsd: 0,
      costBreakdown: [],
      cacheWaste: { missedCost: 0, missedTokens: 0, missCount: 0 },
      startedAt: createdAt,
      lastActivity: createdAt,
      messageCount: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
    },
    messages: [],
    messagesLoaded: true,
    hasMoreOlder: false,
    oldestId: null,
    loadingOlder: false,
    context: null,
    onDisk: false,
  };
}

/** Recreate pending chats from the last session (their windows get their
 *  sessions back via ghost reconciliation). Never opens windows itself. */
function seedPendingSessions() {
  const known = new Set(state.sessions.map((s) => s.file));
  for (const p of loadPendingChats()) {
    if (!known.has(p.file)) state.sessions.push(pendingSessionEntry(p.file, p.cwd, p.createdAt));
  }
}

seedPendingSessions();

/** Tab id scheme: one tab per session, stable across open/close. */
const TAB_PREFIX = 'chat-';
const chatTabId = (sessionId: string) => TAB_PREFIX + sessionId;

/** Tab icon + state class for a session: the chat bubble while idle; a
 *  large dot while the LLM works (green, pulsing — the chat-window header
 *  dot moved to the tab). */
function tabStatusOf(s: ChatSession): { icon: string; tabClass: string } {
  if (s.status === 'running') return { icon: '◉', tabClass: 'chat-tab--running' };
  return { icon: '💬', tabClass: '' };
}

/**
 * Workspace tab definition for a session's chat window. Shared by openChat
 * and the panel → workspace drag handler so both open identical views.
 */
function chatTabDef(s: ChatSession): WorkspaceTabDef {
  return {
    id: chatTabId(s.id),
    label: s.title,
    ...tabStatusOf(s),
    content: 'chat-window',
    props: { sessionId: s.id },
  };
}

/** Re-derive the status icon/class of every open chat tab from its
 *  session (status changes arrive via SSE events and list refreshes). */
function syncTabStatuses() {
  if (!ws) return;
  for (const [tabId, tab] of Object.entries(ws.tabDefs)) {
    if (!tabId.startsWith(TAB_PREFIX)) continue;
    const s = findSession(tabId.slice(TAB_PREFIX.length));
    if (!s) continue;
    const st = tabStatusOf(s);
    tab.icon = st.icon;
    tab.tabClass = st.tabClass;
  }
}

/**
 * DataTransfer type carried by a chat-session drag from the Chat panel.
 * The framework never sees this literal — the accepts predicate below
 * (product code) owns the contract.
 */
export const CHAT_DROP_TYPE = 'application/x-sf-chat-session';

// ── Backend client ─────────────────────────────────────────────────────────

const NEW_CHAT_CWD = '/workspace/sf';

/**
 * Backend request helper. Throws `ConnectivityError` (a TypeError subclass)
 * when the backend itself is unreachable — the dev proxy answers a dead
 * gateway with an empty-body 500 — so callers can silence connectivity
 * failures (the status-bar dot is the only indicator) while real backend
 * rejections (JSON error bodies) still surface as Error.
 */
class ConnectivityError extends TypeError {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      throw new ConnectivityError(msg);
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

interface SessionInfo {
  file: string;
  id: string | null;
  name: string | null;
  cwd: string;
  created: number;
  modified: number;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  firstMessage: string;
  preview: string;
  model: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    prompt: number;
    total: number;
  };
  cost: number;
  costBreakdown: { key: string; cost: number; tokens: number }[];
  cacheWaste: { missedCost: number; missedTokens: number; missCount: number };
  running: boolean;
  /** Context gauge: compaction-aware token estimate + the model's window
   *  (percent null = unknown, the "?" state right after a compaction). */
  context?: { tokens: number | null; window: number; percent: number | null } | null;
}

function toSession(raw: SessionInfo): ChatSession {
  const id = encodeURIComponent(raw.file);
  const title = sessionTitle(raw);
  return {
    id,
    sessionId: raw.id ?? null,
    file: raw.file,
    title,
    cwd: raw.cwd,
    compacting: false,
    compactResult: null,
    compactStartedAt: 0,
    compactEndedAt: 0,
    compactError: null,
    createdAt: raw.created,
    lastActivity: raw.modified,
    status: raw.running ? 'running' : 'idle',
    preview: raw.preview || raw.firstMessage,
    stats: {
      model: raw.model,
      tokensIn: raw.tokens.input,
      tokensOut: raw.tokens.output,
      cacheRead: raw.tokens.cacheRead,
      cacheWrite: raw.tokens.cacheWrite,
      promptTokens: raw.tokens.prompt,
      costUsd: raw.cost,
      costBreakdown: raw.costBreakdown ?? [],
      cacheWaste: raw.cacheWaste ?? { missedCost: 0, missedTokens: 0, missCount: 0 },
      startedAt: raw.created,
      lastActivity: raw.modified,
      messageCount: raw.messageCount,
      userMessages: raw.userMessages,
      assistantMessages: raw.assistantMessages ?? 0,
      toolCalls: raw.toolCalls ?? 0,
      toolResults: raw.toolResults ?? 0,
    },
    messages: [],
    messagesLoaded: false,
    hasMoreOlder: false,
    oldestId: null,
    loadingOlder: false,
    onDisk: true,
    context: raw.context ?? null,
  };
}

/** List-row title: session name, else the first message (truncated). */
function sessionTitle(raw: SessionInfo): string {
  return (
    raw.name ??
    (raw.firstMessage
      ? raw.firstMessage.length > 60
        ? `${raw.firstMessage.slice(0, 60)}…`
        : raw.firstMessage
      : 'Untitled chat')
  );
}

/** The fields a session list row renders, as a comparable string. Used to
 *  skip fetchList's object replacement when nothing observable changed. */
function listSignature(raw: SessionInfo): string {
  return [
    raw.file,
    raw.modified,
    raw.running,
    raw.messageCount,
    raw.model ?? '',
    raw.preview,
    sessionTitle(raw),
    raw.tokens.input,
    raw.tokens.output,
    raw.cost,
    raw.cwd,
    JSON.stringify(raw.context ?? ''),
  ].join('|');
}

function oldListSignature(s: ChatSession): string {
  return [
    s.file,
    s.lastActivity,
    s.status === 'running',
    s.stats.messageCount,
    s.stats.model ?? '',
    s.preview,
    s.title,
    s.stats.tokensIn,
    s.stats.tokensOut,
    s.stats.costUsd,
    s.cwd,
    JSON.stringify(s.context ?? ''),
  ].join('|');
}

let listTimer: number | null = null;

async function fetchList() {
  try {
    const { sessions } = await api<{ sessions: SessionInfo[] }>('/api/sessions');
    const prev = new Map(state.sessions.map((s) => [s.file, s]));
    const onDisk = new Set(sessions.map((s) => s.file));
    // Pending chats whose file materialized are no longer pending: drop
    // them from the registry (fetchList below swaps in the real session).
    const pending = loadPendingChats();
    if (pending.some((p) => onDisk.has(p.file))) {
      persistPendingChats(pending.filter((p) => !onDisk.has(p.file)));
    }
    // Sessions that never hit disk yet (fresh UI chats before the first
    // assistant message) are absent from the backend list — keep them so
    // open windows don't lose their session mid-flight.
    const memoryOnly = state.sessions.filter((s) => !onDisk.has(s.file) && !s.onDisk);
    // Nothing observable changed (poll timer, refresh-event bursts) → keep
    // the existing session objects and the array reference, so panels and
    // watchers don't re-render for a no-op refresh.
    if (
      memoryOnly.length === 0 &&
      sessions.length === prev.size &&
      sessions.every((raw) => {
        const old = prev.get(raw.file);
        return old && oldListSignature(old) === listSignature(raw);
      })
    ) {
      state.backend = 'online';
      return;
    }
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
          s.compactError = old.compactError;
        }
        return s;
      }),
    ];
    syncTabStatuses();
    state.backend = 'online';
  } catch (_e) {
    state.backend = 'offline';
  }
}

/** Public refresh — re-read the session list from the backend (slash results use it). */
export function refreshList(): Promise<void> {
  return fetchList();
}

/** Set the Directory tree + seed the default collapse state on the FIRST
 *  tree (fetch or push) — later updates keep the user's expand/collapse. */
function applyTree(j: DirNode) {
  state.tree = j;
  if (state.treeCollapsed.size === 0) {
    const s = new Set<string>();
    const collapseAll = (n: DirNode) => {
      if (n.children.length) {
        s.add(n.path);
        for (const c of n.children) collapseAll(c);
      }
    };
    collapseAll(j);
    state.treeCollapsed = s;
  }
}

function findNode(tree: DirNode | null, path: string): DirNode | null {
  if (!tree) return null;
  if (tree.path === path) return tree;
  for (const c of tree.children) {
    const found = findNode(c, path);
    if (found) return found;
  }
  return null;
}

function collectPaths(node: DirNode, out: string[]) {
  out.push(node.path);
  for (const c of node.children) collectPaths(c, out);
}

/** Toggle a folder's selection; checking a parent selects its whole
 *  subtree, unchecking deselects it (cascading). */
export function toggleDir(path: string) {
  const node = findNode(state.tree, path);
  if (!node) return;
  const paths: string[] = [];
  collectPaths(node, paths);
  const willCheck = !state.selectedDirs.has(path);
  const next = new Set(state.selectedDirs);
  for (const p of paths) {
    if (willCheck) next.add(p);
    else next.delete(p);
  }
  state.selectedDirs = next;
}

/** Fetch the Directory tree once (later updates arrive via SSE 'tree'). */
export async function loadTree() {
  try {
    const res = await fetch('/api/tree');
    const j = await res.json();
    if (j && typeof j.name === 'string') applyTree(j);
  } catch {
    /* backend offline — the SSE push will fill it in */
  }
}

export function toggleTreeCollapsed(path: string) {
  const next = new Set(state.treeCollapsed);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  state.treeCollapsed = next;
}

// ── SSE live events ────────────────────────────────────────────────────────

function byFile(file: string): ChatSession | undefined {
  return state.sessions.find((s) => s.file === file);
}
/** In-flight sends awaiting the backend's 'ack' event (keyed by reqId).
 *  `acked` flips the moment pi-nest confirms receipt, so an HTTP failure
 *  after that point must NOT mark the message as failed — the turn is
 *  running and its real entry will replace the optimistic row. */
const pendingSends = new Map<string, { sessionId: string; mid: string; acked: boolean }>();

function upsert(s: ChatSession, m: DisplayMessage) {
  const i = s.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) s.messages[i] = m;
  else s.messages.push(m);
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
    if (tc) {
      tc.result = text;
      tc.isError = isError;
      return;
    }
  }
}

function handleEvent(ev: any) {
  switch (ev.type) {
    case 'session_status': {
      const s = byFile(ev.file);
      if (s) {
        s.status = ev.status;
        syncTabStatuses();
      }
      break;
    }
    case 'ack': {
      // Backend receipt confirmation (echoes the reqId the sender attached).
      // Drives: (a) the compaction WIP bubble — it lights the moment pi-nest
      // accepts /compact instead of waiting for compaction_status started;
      // (b) send-failure disambiguation — an HTTP error after the ack means
      // the message is running, not lost.
      const p = pendingSends.get(ev.reqId);
      if (p) p.acked = true;
      if (ev.kind === 'slash' && ev.command === 'compact') {
        const s = byFile(ev.file);
        if (s) {
          s.compacting = true;
          s.compactStartedAt = Date.now();
        }
      }
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
        s.compactError = null;
      } else if (ev.status === 'done') {
        s.compactResult = 'done';
        s.compactEndedAt = Date.now();
      } else if (ev.status === 'failed') {
        s.compactResult = 'failed';
        s.compactEndedAt = Date.now();
        s.compactError = ev.error ?? null;
      }
      break;
    }
    case 'message': {
      const s = byFile(ev.file);
      if (!s) break;
      if (!s.messagesLoaded) {
        // Only the OPEN window's load race needs an event-driven retry — a
        // session nobody is viewing must not fetch a 50-message page on
        // every streamed message (syncSessionView loads it on open).
        if (isViewOpen(s.id)) void fetchMessages(s.id);
        break;
      }
      const m = ev.message as DisplayMessage;
      if (m.role === 'user') {
        // The optimistic pending row (same text) is replaced in place — it
        // may no longer be the last message: a queued message's turn starts
        // only after the previous turn's stream has pushed more messages in
        // between. A FILE-backed row (the user entry that syncTail appended
        // while the message was queued) is adopted instead of pushing a
        // second row: it keeps its canonical entry id so the syncTail
        // cursor stays file-backed.
        const pendingIdx = s.messages.findIndex(
          (x) => x.role === 'user' && x.id.startsWith('pending-') && x.text === m.text,
        );
        const fileIdx = s.messages.findIndex(
          (x) =>
            x.role === 'user' &&
            !x.id.startsWith('pending-') &&
            !x.id.startsWith('user-') &&
            x.text === m.text,
        );
        if (pendingIdx >= 0) {
          s.messages[pendingIdx] = m;
          // The file copy of this message is now redundant — drop it so the
          // message shows exactly once regardless of arrival order.
          if (fileIdx >= 0) s.messages.splice(fileIdx, 1);
        } else if (fileIdx >= 0) {
          s.messages[fileIdx] = { ...m, id: s.messages[fileIdx].id };
        } else upsert(s, m);
      } else if (m.role === 'toolResult') {
        mergeToolResult(s, m.toolCallId ?? '', m.text, !!m.isError);
      } else {
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
      if (s?.messagesLoaded) void syncTail(s.id);
      void fetchList();
      break;
    }
    case 'tree': {
      // Directory tree pushed by the backend whenever session files change.
      // The user's expand/collapse state is preserved (treeCollapsed keys).
      if (ev.tree && typeof ev.tree.name === 'string') applyTree(ev.tree);
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
  es.onerror = () => {
    state.backend = 'offline';
  }; // EventSource auto-reconnects
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* ignore malformed */
    }
  };

  // Connectivity + latency: a 5s /api/health round-trip (the check includes
  // pi-nest, so a dead daemon reads as offline too). The status-bar dot is
  // green when fast, yellow when the ping is high, red when unreachable.
  const PING_INTERVAL_MS = 5000;
  // A heartbeat with no response inside this window is a LOST packet: the
  // probe aborts, so a late answer can never record a bogus huge ping, and
  // the status bar reports the loss instead of the stale number. Two
  // consecutive losses read as offline — a backend that never answers is
  // as good as down even when the TCP connect itself succeeded.
  const PING_TIMEOUT_MS = 3000;
  /** Rolling latency window for the click-to-open stats popup. */
  const PING_WINDOW_MS = 5 * 60_000;
  let pingLostStreak = 0;
  /** Record one probe outcome (ms = round-trip, null = lost) and prune
   *  anything older than the rolling window. */
  function pushPingSample(ms: number | null) {
    const now = performance.now();
    const cutoff = now - PING_WINDOW_MS;
    while (state.pingSamples.length > 0 && state.pingSamples[0].t < cutoff) {
      state.pingSamples.shift();
    }
    state.pingSamples.push({ t: now, ms });
  }
  function pingBackend() {
    const t0 = performance.now();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, PING_TIMEOUT_MS);
    fetch('/api/health', { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        window.clearTimeout(timer);
        if (timedOut) return; // late answer to a lost heartbeat — discard
        pingLostStreak = 0;
        state.backendLost = false;
        state.backendPing = Math.round(performance.now() - t0);
        pushPingSample(state.backendPing);
        state.backend = j.nest === false ? 'offline' : 'online';
      })
      .catch(() => {
        window.clearTimeout(timer);
        if (!timedOut) {
          // Real failure (refused/DNS/network) — the backend is unreachable.
          state.backend = 'offline';
          state.backendPing = null;
          state.backendLost = false;
          pushPingSample(null);
          return;
        }
        // Heartbeat lost — the backend may just be slow. Keep the last good
        // ping on record, mark the loss, and only treat a repeated loss as
        // down.
        pingLostStreak += 1;
        state.backendLost = true;
        pushPingSample(null);
        if (pingLostStreak >= 2) state.backend = 'offline';
      });
  }
  pingBackend();
  const pingTimer = window.setInterval(pingBackend, PING_INTERVAL_MS);
  // The connection is tied to the app's lifetime; a page unload kills it.
  window.addEventListener('beforeunload', () => window.clearInterval(pingTimer));
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

  // Windows may carry state that survives workspace persistence (e.g. the
  // drag-resized composer height): it is merged into every captured
  // snapshot and restored on apply. The boot auto-restore runs before
  // this binds — pending snapshot state is flushed here by the API.
  api.setWindowStateProvider({
    read: () => {
      // Only windows in the layout carry state in a snapshot — closed
      // sessions' entries must not leak into captures (mirrors the
      // layout's skipTab semantics; one tree traversal for all ids).
      const out: Record<string, unknown> = {};
      const open = new Set(openTabIds());
      for (const [file, ui] of Object.entries(windowUi)) {
        if (open.has(TAB_PREFIX + file)) out[TAB_PREFIX + file] = { composerHeight: ui.composerHeight };
      }
      return out;
    },
    apply: (state) => {
      const next: Record<string, WindowUi> = {};
      for (const [tabId, ui] of Object.entries(state)) {
        if (!tabId.startsWith(TAB_PREFIX)) continue;
        next[tabId.slice(TAB_PREFIX.length)] = {
          composerHeight: (ui as WindowUi | null)?.composerHeight ?? null,
        };
      }
      // Replace, don't merge: the snapshot is the full truth of the
      // workspace. Open windows pick the state up via their computed.
      for (const k of Object.keys(windowUi)) delete windowUi[k];
      Object.assign(windowUi, next);
    },
  });

  watch(
    () => activeTabOfFocusedTile(),
    (tabId) => {
      state.activeChatId = tabId?.startsWith(TAB_PREFIX) ? tabId.slice(TAB_PREFIX.length) : null;
    },
    { immediate: true },
  );

  watch(
    () => openTabIds(),
    (ids) => {
      state.openViewTabIds = new Set(ids);
      // The review window can be closed by hand (✕ / middle-click):
      // review state dies with it.
      if (state.reviewTabId && !ids.includes(state.reviewTabId)) {
        state.reviewTabId = null;
      }
    },
    { immediate: true },
  );

  // Tile-strip "+" = start a new chat. The framework's default "+" creates
  // an editor-style "Untitled" tab; a chat product has no use for that, so
  // the app decides what a new workspace item means here.
  api.setNewTabHandler(() => {
    void newChat();
  }, 'New Chat');

  // Clicking a TAB is a real user gesture (the framework distinguishes it
  // from programmatic activation): interacting with the review window this
  // way pins it — it stops being auto-closable.
  api.setTabClickHandler((tabId) => {
    if (tabId === state.reviewTabId) exitReview();
  });

  // Panel → workspace drag: dropping a chat session onto a tile opens it
  // there. Center drops insert/activate a tab; edge drops split the tile
  // and open the chat in the new half (same zones as tab drags).
  api.setExternalDropHandler(
    (types) => types.includes(CHAT_DROP_TYPE),
    (e, target: ExternalDropTarget) => {
      const sessionId = e.dataTransfer?.getData(CHAT_DROP_TYPE) ?? '';
      const s = sessionId ? findSession(sessionId) : undefined;
      if (!s || !ws) return;
      const tab = chatTabDef(s);
      const existing = ws.findTabGlobal(tab.id);
      if (target.zone === 'center') {
        if (existing) {
          // Already open in another tile → move the view there (dedupe by
          // tab id; a session has exactly one view).
          ws.ops.moveTab(tab.id, target.tileId, target.index);
        } else {
          ws.ops.insertTab(target.tileId, target.index, tab);
          syncSessionView(s);
        }
      } else {
        const dir = target.zone === 'left' || target.zone === 'right' ? 'row' : 'column';
        const side = target.zone === 'left' || target.zone === 'top' ? 'start' : 'end';
        ws.ops.splitOpen(target.tileId, dir, side, tab);
        syncSessionView(s);
      }
    },
  );

  // Ghost windows can appear at ANY time — the boot auto-restore creates
  // them before this binds, and loading a saved workspace from the panel
  // creates them on the spot. Reconcile whenever tabDefs gains (or drops)
  // keys (immediate: the ghosts already there on bind); the swap itself
  // only changes values, so this cannot loop.
  watch(
    () => Object.keys(api.tabDefs).join('\n'),
    () => reconcileGhostWindows(),
    { immediate: true },
  );

  // A workspace apply replaces the root ARRAY (other ops mutate in place).
  // Windows resumed from a saved/auto workspace must never come back in
  // review state: the review class can survive on defs whose review window
  // was closed, so sweep every def rather than just the tracked window.
  watch(
    () => api.roots,
    () => {
      state.reviewTabId = null;
      for (const def of Object.values(api.tabDefs)) {
        if (def.tabClass === REVIEW_TAB_CLASS) {
          def.tabClass = '';
          def.transient = false;
        }
      }
    },
  );

  connectEvents();
  void fetchList().then(() => {
    if (firstBind) {
      firstBind = false;
      // Show the most recent real conversation on first launch.
      if (state.sessions.length > 0) openChat(state.sessions[0].id);
    }
    reconcileGhostWindows();
  });

  // Periodic refresh picks up sessions created outside the UI (e.g. TUI).
  if (listTimer === null) {
    listTimer = window.setInterval(() => void fetchList(), 15000);
  }
}

/**
 * Saved / auto-restored workspaces may reference chat windows that were not
 * open at startup (or sessions that have since been deleted). Deleted ones
 * stay as framework ghost tabs (blank page); live sessions get their real
 * window definition swapped in so the restored layout shows them again.
 */
function reconcileGhostWindows() {
  if (!ws) return;
  for (const id of Object.keys(ws.tabDefs)) {
    if (!id.startsWith(TAB_PREFIX)) continue;
    if (ws.tabDefs[id].content !== BLANK_CONTENT) continue;
    const s = findSession(id.slice(TAB_PREFIX.length));
    if (s) {
      ws.tabDefs[id] = chatTabDef(s);
      // A reconciled window opens like any other view: it must load its
      // messages (syncSessionView fetches the first page; otherwise the
      // window would sit on the empty state forever).
      syncSessionView(s);
    }
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
function cwdMatches(s: ChatSession, dirs: Set<string>): boolean {
  if (dirs.size === 0) return true;
  for (const d of dirs) {
    if (s.cwd === d || s.cwd.startsWith(`${d}/`)) return true;
  }
  return false;
}

export function activeSessions(): ChatSession[] {
  return state.sessions
    .filter((s) => (s.status === 'running' || isViewOpen(s.id)) && cwdMatches(s, state.selectedDirs))
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
      state.sessions.unshift(pendingSessionEntry(file, NEW_CHAT_CWD, now));
      // Remember the pending chat across refreshes (see PENDING_KEY block).
      const pending = loadPendingChats();
      if (!pending.some((p) => p.file === file)) {
        pending.push({ file, cwd: NEW_CHAT_CWD, createdAt: now });
        persistPendingChats(pending);
      }
    }
    openChat(id);
  } catch (e) {
    // Connectivity failures are silent — the status-bar dot is the only
    // indicator. Real backend rejections still surface as a banner.
    if (!(e instanceof TypeError)) {
      state.lastError = e instanceof Error ? e.message : String(e);
    }
    state.backend = 'offline';
  }
}

/** Extra tab class marking a review-mode window (dimmed + italic tab). */
const REVIEW_TAB_CLASS = 'sf-tab--review';

/** Mark the given tab as the review window (dim the tab). */
function enterReview(tabId: string) {
  state.reviewTabId = tabId;
  if (ws) {
    ws.tabDefs[tabId].tabClass = REVIEW_TAB_CLASS;
    // Review windows are transient previews: they must not persist into
    // the auto-saved layout or a saved workspace (capture excludes
    // transient tabs).
    ws.tabDefs[tabId].transient = true;
  }
}

/** Pin the review window: normal tab styling, no longer auto-closable. */
function exitReview() {
  if (!state.reviewTabId || !ws) return;
  const def = ws.tabDefs[state.reviewTabId];
  if (def) {
    def.tabClass = '';
    def.transient = false;
  }
  state.reviewTabId = null;
}

/**
 * Any real interaction with a window (typing, sending) pins it: exit review
 * if that session's view is the current review window.
 */
export function noteChatInteraction(sessionId: string) {
  if (state.reviewTabId === chatTabId(sessionId)) exitReview();
}

/** Load or refresh a session's messages after its view opens/activates. */
function syncSessionView(s: ChatSession) {
  if (!s.messagesLoaded) void fetchMessages(s.id);
  else void syncTail(s.id);
}

/** Start a panel → workspace drag carrying the session id. */
export function startSessionDrag(e: DragEvent, s: ChatSession) {
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(CHAT_DROP_TYPE, s.id);
  dt.setData('text/plain', s.title);
  dt.effectAllowed = 'copy';
}

/** Open (or activate, if already open) a session's window in the workspace. */
export function openChat(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);

  // Already open somewhere → just activate it (dedupe by tab id).
  const existing = ws.findTabGlobal(tabId);
  if (existing) {
    // Clicking the SAME history item while it is the review window is the
    // same navigation gesture — review persists. Opening a pinned window
    // ends nothing; the review window (if any) stays as it is.
    ws.ops.activateTab(existing.id, tabId);
    // Re-sync on every activation: the session may have advanced while
    // its view was closed or while events were missed.
    syncSessionView(s);
    return;
  }

  // Opening a NEW view from a history click = review mode. If another
  // window is currently in review and was never interacted with, close it
  // first and open this one where it stood.
  let tileId = targetTileId();
  if (state.reviewTabId) {
    const reviewTile = ws.findTabGlobal(state.reviewTabId);
    ws.ops.closeTab(state.reviewTabId);
    state.reviewTabId = null;
    // closeTab may have removed the root the review window lived in.
    tileId = reviewTile && ws.findTileGlobal(reviewTile.id) ? reviewTile.id : targetTileId();
  }
  if (!tileId) return;
  ws.ops.openTab(tileId, chatTabDef(s));
  enterReview(tabId);
  syncSessionView(s);
}

/** Drag-end cleanup for panel → workspace drags (clears hover state). */
export function endExternalDrag() {
  ws?.endDrag();
}

/** Send a user message; the real pi agent replies (streaming via SSE). */
export async function sendMessage(
  sessionId: string,
  text: string,
  opts: { wait?: boolean; images?: { data: string; mimeType: string }[] } = {},
) {
  const s = findSession(sessionId);
  const trimmed = text.trim();
  const images = opts.images ?? [];
  if (!s || (!trimmed && !images.length)) return;
  // Sending is a real interaction: pin the window if it was in review.
  noteChatInteraction(sessionId);
  state.lastError = '';

  // Optimistic append (the backend confirms with the same text shortly).
  // No "already running" guard here: the backend decides per message — a
  // plain message INTERRUPTS a busy turn; `wait: true` (/wait) queues it
  // until the current turn finishes.
  const mid = `pending-${Date.now()}`;
  const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  pendingSends.set(reqId, { sessionId, mid, acked: false });
  s.messages.push({
    id: mid,
    role: 'user',
    text: trimmed,
    ts: Date.now(),
    ...(images.length ? { images } : {}),
  });
  try {
    await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: s.file,
        message: trimmed,
        reqId,
        ...(images.length ? { images } : {}),
        ...(opts.wait ? { wait: true } : {}),
      }),
    });
    pendingSends.delete(reqId);
  } catch (e) {
    const acked = pendingSends.get(reqId)?.acked;
    pendingSends.delete(reqId);
    if (acked) return; // pi-nest confirmed receipt — the turn is running; its
    // real entry will replace the optimistic row. The HTTP error was a
    // transport hiccup after acceptance.
    const i = s.messages.findIndex((m) => m.id === mid);
    if (i >= 0) {
      // Keep the row and mark it failed so the user can resend in place
      // instead of retyping (only if it's still the optimistic copy — a real
      // entry replacing it means the backend took it after all).
      s.messages[i] = { ...s.messages[i], sendFailed: true };
    }
    // Connectivity failures are silent (the status-bar dot says it all);
    // real backend rejections still surface as a banner.
    if (!(e instanceof TypeError)) {
      state.lastError = e instanceof Error ? e.message : String(e);
    } else {
      state.backend = 'offline';
    }
  }
}

/** Resend a message whose optimistic row was marked sendFailed. */
export async function resendMessage(sessionId: string, mid: string) {
  const s = findSession(sessionId);
  if (!s) return;
  const i = s.messages.findIndex((m) => m.id === mid);
  if (i < 0) return;
  const { text, images } = s.messages[i];
  s.messages.splice(i, 1); // drop the failed copy; sendMessage re-appends it
  await sendMessage(sessionId, text, { images });
}

/** Mark the last /compact as failed (busy session, rejected command, ...).
 *  Lights the transient red flash; the reason goes to the error banner. */
export function markCompactFailed(sessionId: string, reason?: string | null) {
  const s = findSession(sessionId);
  if (!s) return;
  s.compacting = false;
  s.compactResult = 'failed';
  s.compactEndedAt = Date.now();
  s.compactError = reason ?? null;
  if (reason) state.lastError = reason;
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
  } catch {
    /* session not running — fine */
  }
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

/** Rename a session (the daemon appends a session_info entry). */
export async function renameSession(sessionId: string, name: string): Promise<boolean> {
  const s = findSession(sessionId);
  if (!s || !name.trim()) return false;
  try {
    const j = await api<any>('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file, command: 'name', args: name.trim() }),
    });
    if (!j.ok) {
      state.lastError = j.error || 'Rename failed';
      return false;
    }
    await refreshList();
    return true;
  } catch (e) {
    // Connectivity failures are silent (the status-bar dot says it all).
    if (!(e instanceof TypeError)) state.lastError = String((e as Error)?.message ?? e);
    return false;
  }
}

/** Delete a session file via the daemon (refuses while it is running). */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const s = findSession(sessionId);
  if (!s) return false;
  try {
    const j = await api<any>('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file, command: 'delete' }),
    });
    if (!j.ok) {
      state.lastError = j.error || 'Delete failed';
      return false;
    }
    closeChatView(sessionId);
    delete state.drafts[sessionId];
    delete windowUi[sessionId];
    saveDrafts();
    await refreshList();
    return true;
  } catch (e) {
    // Connectivity failures are silent (the status-bar dot says it all).
    if (!(e instanceof TypeError)) state.lastError = String((e as Error)?.message ?? e);
    return false;
  }
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
      // Dedupe by id: round-aligned pages never overlap in steady state,
      // but a stale cursor (compaction rewrote the file, or a page loaded
      // before the server's round-based slicing) can hand back entries we
      // already hold.
      const known = new Set(s.messages.map((m) => m.id).filter(Boolean));
      s.messages = [...incoming.filter((m) => !m.id || !known.has(m.id)), ...s.messages];
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
    // Connectivity failures are silent (the status-bar dot says it all);
    // the SSE push refills messages once the connection is back.
    if (!(e instanceof TypeError)) {
      state.lastError = `Failed to load messages: ${e instanceof Error ? e.message : e}`;
    }
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
  if (!s?.messagesLoaded) return;
  // Cursor: the last message that has a stable file entry id (live rows
  // carry asst-/user-/pending-/toolresult-/msg- ids that never exist in
  // the file; summary- ids ARE canonical — both sides derive them from
  // the same hash).
  let lastEntryId: string | null = null;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const id = s.messages[i].id;
    if (
      id &&
      !id.startsWith('pending-') &&
      !id.startsWith('asst-') &&
      !id.startsWith('user-') &&
      !id.startsWith('toolresult-') &&
      !id.startsWith('msg-')
    ) {
      lastEntryId = id;
      break;
    }
  }
  if (!lastEntryId) return;
  try {
    const data = await api<any>(
      `/api/sessions/messages?file=${encodeURIComponent(s.file)}&after=${encodeURIComponent(lastEntryId)}`,
    );
    const incoming = (data.messages ?? []) as DisplayMessage[];
    if (incoming.length > 0) {
      // Dedupe by id, or by (role, timestamp): streamed messages carry live
      // ids that differ from their persisted entry ids. One set each —
      // avoids the old per-item O(n) scan over the loaded messages.
      const seenId = new Set(s.messages.map((m) => m.id));
      const seenTs = new Set(s.messages.map((m) => `${m.role}:${m.ts}`));
      const fresh: DisplayMessage[] = [];
      for (const m of incoming) {
        if (seenId.has(m.id) || seenTs.has(`${m.role}:${m.ts}`)) continue;
        if (m.role === 'user') {
          // The file entry for a queued user message lands BEFORE its live
          // event (the entry is appended at queue time, the turn starts
          // later). Adopt the optimistic row's slot instead of appending a
          // second row — keeps one row per message while the turn waits.
          const p = s.messages.findIndex(
            (x) => x.role === 'user' && x.id.startsWith('pending-') && x.text === m.text,
          );
          if (p >= 0) {
            s.messages[p] = m;
            continue;
          }
        }
        fresh.push(m);
      }
      if (fresh.length > 0) s.messages = [...s.messages, ...fresh];
    }
    // Full-session info rides along — keep stats fresh too.
    applySessionInfo(s, data);
  } catch {
    /* transient — next refresh/connect will retry */
  }
}

/** Merge the full-session info that rides along on message responses. */
function applySessionInfo(s: ChatSession, data: any) {
  s.stats.model = data.model ?? s.stats.model;
  s.stats.tokensIn = data.tokens?.input ?? s.stats.tokensIn;
  s.stats.tokensOut = data.tokens?.output ?? s.stats.tokensOut;
  s.stats.cacheRead = data.tokens?.cacheRead ?? s.stats.cacheRead;
  s.stats.cacheWrite = data.tokens?.cacheWrite ?? s.stats.cacheWrite;
  s.stats.promptTokens = data.tokens?.prompt ?? s.stats.promptTokens;
  s.stats.costUsd = data.cost ?? s.stats.costUsd;
  s.stats.costBreakdown = data.costBreakdown ?? s.stats.costBreakdown;
  s.stats.cacheWaste = data.cacheWaste ?? s.stats.cacheWaste;
  s.stats.messageCount = data.messageCount ?? s.stats.messageCount;
  s.stats.assistantMessages = data.assistantMessages ?? s.stats.assistantMessages;
  s.stats.toolCalls = data.toolCalls ?? s.stats.toolCalls;
  s.stats.toolResults = data.toolResults ?? s.stats.toolResults;
  s.status = data.running ? 'running' : s.status;
  if (data.context) s.context = data.context;
  syncTabStatuses();
}

// ── Public API ─────────────────────────────────────────────────────────────

export const store = {
  get sessions() {
    return state.sessions;
  },
  /** sessions honoring the directory filter (cwd under the selected path) */
  get filteredSessions() {
    return state.sessions.filter((s) => cwdMatches(s, state.selectedDirs));
  },
  get selectedDirs() {
    return state.selectedDirs;
  },
  toggleDir,
  get tree() {
    return state.tree;
  },
  get treeCollapsed() {
    return state.treeCollapsed;
  },
  loadTree,
  toggleTreeCollapsed,
  get activeChatId() {
    return state.activeChatId;
  },
  get openViewTabIds() {
    return state.openViewTabIds;
  },
  get backend() {
    return state.backend;
  },
  get backendPing() {
    return state.backendPing;
  },
  get backendLost() {
    return state.backendLost;
  },
  /** Rolling 5-minute probe window (every outcome, good or lost). */
  get pingSamples() {
    return state.pingSamples;
  },
  get lastError() {
    return state.lastError;
  },
  clearLastError() {
    state.lastError = '';
  },
  /** Surface a transient banner error (attachment failures, etc.). */
  setLastError(message: string) {
    state.lastError = message;
  },
  /** unsent composer text of a session's chat window ('' if none) */
  draftOf(sessionId: string): string {
    return state.drafts[sessionId] ?? '';
  },
  setDraft(sessionId: string, text: string) {
    state.drafts[sessionId] = text;
    saveDrafts();
  },
  windowUiOf,
  setComposerHeight,
  findSession,
  isViewOpen,
  activeSessions,
  newChat,
  openChat,
  noteChatInteraction,
  sendMessage,
  resendMessage,
  markCompactFailed,
  stopSession,
  closeChatView,
  renameSession,
  deleteSession,
  get prefs() {
    return state.prefs;
  },
  setSendKey,
  setRenderMarkdown,
  loadOlder,
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

/**
 * Time-of-day, extended to a full datetime when the timestamp is not from
 * today ("MM-DD HH:MM", with the year prepended if it differs).
 */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return time;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const date = d.getFullYear() === now.getFullYear() ? `${mo}-${day}` : `${d.getFullYear()}-${mo}-${day}`;
  return `${date} ${time}`;
}

export function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Compact token count (TUI footer/formatTokens): 950 → "950", 12.3k,
 *  4.2M … — used for the cost-breakdown "(552M tokens)" style suffixes. */
export function fmtCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}
