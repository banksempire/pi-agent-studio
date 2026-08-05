/**
 * Chat store — the app-side state for the Chat app.
 *
 * Sessions live here regardless of whether their view (workspace tab) is
 * open: closing a chat window only closes the *view*; a running session
 * keeps streaming in the background (timers are module-scoped).
 *
 * Currently backed by a mock engine; the API surface (sessions, messages,
 * status, stats) is shaped so a real pi backend can replace it later.
 */
import { reactive, watch } from 'vue';
import { collectAllTabs, firstTile } from '@sf/workspace/tree';
import type { WorkspaceApi } from '@sf/composables/useWorkspace';

// ── Types ──────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system';
export type SessionStatus = 'idle' | 'running' | 'stopped';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
}

export interface SessionStats {
  model: string;
  tokensIn: number;
  tokensOut: number;
  startedAt: number;
  lastActivity: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  status: SessionStatus;
  messages: ChatMessage[];
  stats: SessionStats;
}

// ── Mock pricing / model ───────────────────────────────────────────────────

const MODEL = 'pi-1 (mock)';
const PRICE_IN = 3e-6;    // $ per input token (mock)
const PRICE_OUT = 12e-6;  // $ per output token (mock)

// ── State ──────────────────────────────────────────────────────────────────

interface ChatState {
  sessions: ChatSession[];
  /** session of the chat window currently activated in the workspace (null = none) */
  activeChatId: string | null;
  /** tab ids currently open in the workspace */
  openViewTabIds: Set<string>;
}

const state = reactive<ChatState>({
  sessions: [],
  activeChatId: null,
  openViewTabIds: new Set(),
});

/** Tab id scheme: one tab per session, stable across open/close. */
const TAB_PREFIX = 'chat-';
const chatTabId = (sessionId: string) => TAB_PREFIX + sessionId;

// ── Workspace binding ──────────────────────────────────────────────────────

let ws: WorkspaceApi | null = null;
let seeded = false;

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
  // Prefer the focused tile; fall back to the first tile of the first root.
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

  // First launch: open the demo running session so the workspace shows a
  // live chat (and the stats panel has something to display).
  if (!seeded) {
    seeded = true;
    const running = state.sessions.find((s) => s.status === 'running');
    if (running) openChat(running.id);
  }
}

// ── Session helpers ────────────────────────────────────────────────────────

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function findSession(sessionId: string): ChatSession | undefined {
  return state.sessions.find((s) => s.id === sessionId);
}

/** Is this session's view currently open in the workspace? */
export function isViewOpen(sessionId: string): boolean {
  return state.openViewTabIds.has(chatTabId(sessionId));
}

/** Sessions considered active: running in the background, or with an open view. */
export function activeSessions(): ChatSession[] {
  return state.sessions
    .filter((s) => s.status === 'running' || isViewOpen(s.id))
    .sort((a, b) => b.stats.lastActivity - a.stats.lastActivity);
}

// ── Cost / duration (computed, shown in the stats panel) ───────────────────

export function costOf(s: ChatSession): number {
  return s.stats.tokensIn * PRICE_IN + s.stats.tokensOut * PRICE_OUT;
}

export function durationSec(s: ChatSession): number {
  const end = s.status === 'running' ? Date.now() : Math.max(s.stats.lastActivity, s.stats.startedAt);
  return Math.max(0, (end - s.stats.startedAt) / 1000);
}

// ── Mock streaming engine ──────────────────────────────────────────────────

/** sessionId → interval id of the active stream */
const streams = new Map<string, number>();

const MOCK_REPLIES: string[] = [
  'Good question. The split-tree workspace model keeps every tile proportional: each split stores a ratio, and flexbox turns that ratio into flex-basis percentages. When you resize the window, tiles stay in proportion and only break that rule when a tile hits its minimum size — that is exactly what keeps the layout stable in StudioFramework.',
  'Here is what I would do. First, keep the chat session as the source of truth and treat the workspace tab as a mere view onto it. Closing a tab then only unmounts the view, while the session keeps running in the background. The sessions list can show live status per session, and the right panel can render session stats for whichever window is activated.',
  'Let me outline the steps. 1) Model the session store with status transitions idle → running → stopped. 2) Bind it to the workspace API so opening a history entry inserts a tab with the session id as prop. 3) Stream reply tokens into the session even when no view is open. 4) Let the stats panel subscribe to the activated session and re-render every second.',
  'That approach is solid, with one caveat: watch out for state duplication. If the tab definition carries the session id and the store is the single source of truth, you never have to sync message arrays between the view and the panel. Keep the tab label in sync by mutating the reactive tabDefs entry when the title changes.',
  'I agree, and I would add a small detail: auto-scroll in the chat window should only kick in when the user is already at the bottom. Track stickiness on scroll, then jump to the newest message only when sticky. That prevents the stream from yanking the scroll position out from under the user while they read earlier messages.',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function startStream(s: ChatSession) {
  stopStream(s);
  const words = (pick(MOCK_REPLIES) + ' ' + pick(MOCK_REPLIES)).split(/\s+/);
  const msg: ChatMessage = { id: uid('msg'), role: 'assistant', text: '', ts: Date.now() };
  s.messages.push(msg);
  s.status = 'running';
  s.stats.lastActivity = Date.now();

  let i = 0;
  const timer = window.setInterval(() => {
    if (s.status !== 'running') {
      // Stopped externally (stopSession) — clean up quietly.
      window.clearInterval(timer);
      streams.delete(s.id);
      return;
    }
    if (i >= words.length) {
      window.clearInterval(timer);
      streams.delete(s.id);
      s.status = 'idle';
      s.stats.lastActivity = Date.now();
      return;
    }
    const n = 1 + Math.floor(Math.random() * 2);
    const chunk = words.slice(i, i + n).join(' ');
    i += n;
    msg.text += (msg.text ? ' ' : '') + chunk;
    s.stats.tokensOut += n;
    s.stats.lastActivity = Date.now();
  }, 70 + Math.floor(Math.random() * 130));
  streams.set(s.id, timer);
}

function stopStream(s: ChatSession) {
  const t = streams.get(s.id);
  if (t !== undefined) {
    window.clearInterval(t);
    streams.delete(s.id);
  }
}

// ── Public operations ──────────────────────────────────────────────────────

function createSession(title: string, status: SessionStatus): ChatSession {
  const now = Date.now();
  return {
    id: uid('session'),
    title,
    createdAt: now,
    status,
    messages: [],
    stats: { model: MODEL, tokensIn: 0, tokensOut: 0, startedAt: now, lastActivity: now },
  };
}

/** Create a chat and open its window in the workspace. */
export function newChat(): ChatSession {
  const s = createSession('New Chat', 'idle');
  state.sessions.unshift(s);
  openChat(s.id);
  return s;
}

/** Open (or activate, if already open) a session's window in the workspace. */
export function openChat(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);

  // Already open → just activate it.
  const existing = ws.findTileGlobal(tabId);
  if (existing) {
    ws.ops.activateTab(existing.id, tabId);
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
}

/** Send a user message; the session starts streaming a reply (mock). */
export function sendMessage(sessionId: string, text: string) {
  const s = findSession(sessionId);
  const trimmed = text.trim();
  if (!s || !trimmed) return;

  stopStream(s);
  s.messages.push({ id: uid('msg'), role: 'user', text: trimmed, ts: Date.now() });

  // First user message becomes the session title (and the tab label).
  const userCount = s.messages.filter((m) => m.role === 'user').length;
  if (userCount === 1) {
    s.title = trimmed.length > 48 ? trimmed.slice(0, 48) + '…' : trimmed;
    const def = ws?.tabDefs[chatTabId(s.id)];
    if (def) def.label = s.title;
  }

  s.stats.tokensIn += estimateTokens(trimmed);
  s.stats.lastActivity = Date.now();
  startStream(s);
}

/** Stop a running session. The conversation stays; only generation halts. */
export function stopSession(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  stopStream(s);
  if (s.status === 'running') {
    s.status = 'stopped';
    s.stats.lastActivity = Date.now();
  }
}

/**
 * Close the workspace *view* of a session. The session itself is untouched:
 * a running session keeps streaming in the background.
 */
export function closeChatView(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tile = ws.findTileGlobal(chatTabId(sessionId));
  if (tile) ws.ops.closeTab(chatTabId(sessionId));
}

// ── Seed demo data ─────────────────────────────────────────────────────────

function seed() {
  const now = Date.now();
  const H = 3600e3;
  const D = 24 * H;

  const s1 = createSession('Explain the split-tree workspace model', 'idle');
  s1.createdAt = now - 2 * D;
  s1.messages = [
    { id: uid('msg'), role: 'user', text: 'How does the split-tree workspace model keep tiles stable on resize?', ts: now - 2 * D + 60e3 },
    { id: uid('msg'), role: 'assistant', text: MOCK_REPLIES[0], ts: now - 2 * D + 120e3 },
  ];
  s1.stats = { model: MODEL, tokensIn: 31, tokensOut: 142, startedAt: now - 2 * D + 60e3, lastActivity: now - 2 * D + 130e3 };
  state.sessions.push(s1);

  const s2 = createSession('Refactor Panel.vue resize handling', 'idle');
  s2.createdAt = now - 5 * H;
  s2.messages = [
    { id: uid('msg'), role: 'user', text: 'Can you review the resize observer logic in Panel.vue?', ts: now - 5 * H + 30e3 },
    { id: uid('msg'), role: 'assistant', text: MOCK_REPLIES[1], ts: now - 5 * H + 90e3 },
    { id: uid('msg'), role: 'user', text: 'And make sure collapsing a sub-section preserves its height.', ts: now - 5 * H + 100e3 },
    { id: uid('msg'), role: 'assistant', text: MOCK_REPLIES[3], ts: now - 5 * H + 160e3 },
  ];
  s2.stats = { model: MODEL, tokensIn: 58, tokensOut: 210, startedAt: now - 5 * H + 30e3, lastActivity: now - 5 * H + 170e3 };
  state.sessions.push(s2);

  // Running session: started 40s ago, streams in the background (its view
  // is auto-opened on first bind). Closing the view does not stop it.
  const s3 = createSession('Plan pi-agent-studio v1', 'running');
  s3.createdAt = now - 40e3;
  s3.messages = [
    { id: uid('msg'), role: 'user', text: 'Plan the first milestone of pi-agent-studio: a chat app on the StudioFramework.', ts: now - 40e3 },
    { id: uid('msg'), role: 'assistant', text: 'Let me lay out the plan. First, keep the session', ts: now - 38e3 },
  ];
  s3.stats = { model: MODEL, tokensIn: 27, tokensOut: 22, startedAt: now - 40e3, lastActivity: now - 30e3 };
  state.sessions.push(s3);
  startStream(s3);

  // Stopped session: a previous run was interrupted mid-generation.
  const s4 = createSession('Summarize yesterday’s session', 'stopped');
  s4.createdAt = now - D;
  s4.messages = [
    { id: uid('msg'), role: 'user', text: 'Summarize what we worked on yesterday.', ts: now - D + 10e3 },
    { id: uid('msg'), role: 'assistant', text: 'Yesterday we covered the workspace split-tree, drag-to-tile, and the sub-section height model. The key takeaways were:', ts: now - D + 15e3 },
  ];
  s4.stats = { model: MODEL, tokensIn: 19, tokensOut: 48, startedAt: now - D + 10e3, lastActivity: now - D + 16e3 };
  state.sessions.push(s4);
}

seed();

// ── Public API ─────────────────────────────────────────────────────────────

export const store = {
  get sessions() { return state.sessions; },
  get activeChatId() { return state.activeChatId; },
  get openViewTabIds() { return state.openViewTabIds; },
  findSession,
  isViewOpen,
  activeSessions,
  newChat,
  openChat,
  sendMessage,
  stopSession,
  closeChatView,
  bindWorkspace,
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
