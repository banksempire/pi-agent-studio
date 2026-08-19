import { BLANK_CONTENT, type ExternalDropTarget, type WorkspaceApi } from '@sf/composables/useWorkspace';
import type { WorkspaceTabDef } from '@sf/types/layout';
import { collectAllTabs, firstTile } from '@sf/workspace/tree';
import { reactive, watch } from 'vue';

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
  images?: { data: string; mimeType: string }[];
  model?: string | null;
  provider?: string | null;
  thinkingLevel?: string | null;
  stopReason?: string | null;
  error?: string | null;
  ts: number;
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
  cacheRead: number;
  cacheWrite: number;
  promptTokens: number;
  costUsd: number;
  costBreakdown: { key: string; cost: number; tokens: number }[];
  cacheWaste: { missedCost: number; missedTokens: number; missCount: number };
  startedAt: number;
  lastActivity: number;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
}

export interface DirNode {
  name: string;
  path: string;
  count: number;
  children: DirNode[];
}

export interface ChatSession {
  id: string;
  sessionId: string | null;
  file: string;
  title: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
  status: 'idle' | 'running';
  streaming: boolean;
  compacting: boolean;
  compactResult: 'done' | 'failed' | null;
  compactStartedAt: number;
  compactEndedAt: number;
  compactError: string | null;
  preview: string;
  stats: SessionStatsView;
  messages: DisplayMessage[];
  messagesLoaded: boolean;
  hasMoreOlder: boolean;
  oldestId: string | null;
  loadingOlder: boolean;
  context: { tokens: number | null; window: number; percent: number | null } | null;
  onDisk: boolean;
}

export type BackendStatus = 'connecting' | 'online' | 'offline';

export type PingSample = { t: number; ms: number | null };

export type SendKeyMode = 'enter' | 'shiftEnter';

interface ChatState {
  sessions: ChatSession[];
  activeChatId: string | null;
  openViewTabIds: Set<string>;
  reviewTabId: string | null;
  selectedDirs: Set<string>;
  tree: DirNode | null;
  treeCollapsed: Set<string>;
  backend: BackendStatus;
  backendPing: number | null;
  backendLost: boolean;
  pingSamples: PingSample[];
  lastError: string;
  sessionErrors: Record<string, string>;
  drafts: Record<string, string>;
  prefs: {
    sendKey: SendKeyMode;
    renderMarkdown: boolean;
  };
}

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
  } catch {}
  return { sendKey: 'enter', renderMarkdown: true };
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {}
}
function setSendKey(mode: SendKeyMode) {
  state.prefs.sendKey = mode;
  savePrefs();
}

const DRAFTS_KEY = 'sf-chat:drafts';
function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return j;
    }
  } catch {}
  return {};
}
function saveDrafts() {
  try {
    if (state.sessions.length > 0) {
      const known = new Set(state.sessions.map((s) => s.id));
      for (const id of Object.keys(state.drafts)) {
        if (!known.has(id)) delete state.drafts[id];
      }
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts));
  } catch {}
}

export interface WindowUi {
  composerHeight: number | null;
}

const windowUi = reactive<Record<string, WindowUi>>({});

export function windowUiOf(sessionId: string): WindowUi | undefined {
  return windowUi[sessionId];
}

export interface ChatScrollMem {
  top: number;
  sticky: boolean;
}
const scrollMemory = new Map<string, ChatScrollMem>();

export interface ChatAttachment {
  data: string;
  mimeType: string;
  url: string;
}

const sessionAttachments = reactive<Record<string, ChatAttachment[]>>({});

export function attachmentsOf(sessionId: string): ChatAttachment[] {
  if (!sessionAttachments[sessionId]) sessionAttachments[sessionId] = [];
  return sessionAttachments[sessionId];
}

export function setAttachments(sessionId: string, list: ChatAttachment[]) {
  sessionAttachments[sessionId] = list;
}

export function sessionErrorOf(sessionId: string): string {
  return state.sessionErrors[sessionId] ?? '';
}

export function setSessionError(sessionId: string, message: string) {
  state.sessionErrors[sessionId] = message;
}

export function clearSessionError(sessionId: string) {
  delete state.sessionErrors[sessionId];
}

const sessionOpenGroups = reactive<Record<string, Record<string, boolean>>>({});

export function openGroupsOf(sessionId: string): Record<string, boolean> {
  let g = sessionOpenGroups[sessionId];
  if (!g) {
    g = {};
    sessionOpenGroups[sessionId] = g;
  }
  return g;
}

export function setOpenGroup(sessionId: string, id: string, open: boolean) {
  openGroupsOf(sessionId)[id] = open;
}

export function unsetOpenGroup(sessionId: string, id: string) {
  delete sessionOpenGroups[sessionId]?.[id];
}

export function chatScrollOf(sessionId: string): ChatScrollMem {
  let m = scrollMemory.get(sessionId);
  if (!m) {
    m = { top: 0, sticky: true };
    scrollMemory.set(sessionId, m);
  }
  return m;
}

export function forgetChatScroll(sessionId: string) {
  scrollMemory.delete(sessionId);
}

let windowPersistTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleWindowPersist() {
  if (windowPersistTimer) clearTimeout(windowPersistTimer);
  windowPersistTimer = setTimeout(() => ws?.persistNow(), 400);
}

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
  sessionErrors: {},
  drafts: loadDrafts(),
  prefs: loadPrefs(),
});

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
  } catch {}
  return [];
}

function persistPendingChats(list: PendingChatInfo[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20)));
  } catch {}
}

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
    streaming: false,
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

function seedPendingSessions() {
  const known = new Set(state.sessions.map((s) => s.file));
  for (const p of loadPendingChats()) {
    if (!known.has(p.file)) state.sessions.push(pendingSessionEntry(p.file, p.cwd, p.createdAt));
  }
}

seedPendingSessions();

const TAB_PREFIX = 'chat-';
const chatTabId = (sessionId: string) => TAB_PREFIX + sessionId;

function tabStatusOf(s: ChatSession): { icon: string; tabClass: string } {
  if (s.status === 'running') {
    return { icon: s.streaming ? '◉-busy' : '◉-waiting', tabClass: 'chat-tab--running' };
  }
  return { icon: '💬', tabClass: '' };
}

function chatTabDef(s: ChatSession): WorkspaceTabDef {
  return {
    id: chatTabId(s.id),
    label: s.title,
    ...tabStatusOf(s),
    content: 'chat-window',
    props: { sessionId: s.id },
  };
}

function syncTabStatuses() {
  if (!ws) return;
  for (const [tabId, tab] of Object.entries(ws.tabDefs)) {
    if (!tabId.startsWith(TAB_PREFIX)) continue;
    const s = findSession(tabId.slice(TAB_PREFIX.length));
    if (!s) continue;
    const st = tabStatusOf(s);
    tab.icon = st.icon;
    tab.tabClass = st.tabClass;
    tab.label = s.title;
  }
  syncDocumentTitle();
}

function syncDocumentTitle() {
  const anyRunning = state.sessions.some((s) => s.status === 'running');
  document.title = anyRunning ? PAGE_TITLE : `${IDLE_TITLE_PREFIX} ${PAGE_TITLE}`;
}

const PAGE_TITLE = 'pi-agent-studio';
const IDLE_TITLE_PREFIX = '[idle]';

export const CHAT_DROP_TYPE = 'application/x-sf-chat-session';

const NEW_CHAT_CWD = '/workspace/sf';

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
    streaming: false,
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
    const pending = loadPendingChats();
    if (pending.some((p) => onDisk.has(p.file))) {
      persistPendingChats(pending.filter((p) => !onDisk.has(p.file)));
    }
    const memoryOnly = state.sessions.filter((s) => !onDisk.has(s.file) && !s.onDisk);
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

export function refreshList(): Promise<void> {
  return fetchList();
}

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

export async function loadTree() {
  try {
    const res = await fetch('/api/tree');
    const j = await res.json();
    if (j && typeof j.name === 'string') applyTree(j);
  } catch {}
}

export function toggleTreeCollapsed(path: string) {
  const next = new Set(state.treeCollapsed);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  state.treeCollapsed = next;
}

function byFile(file: string): ChatSession | undefined {
  return state.sessions.find((s) => s.file === file);
}
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
        if (ev.status === 'idle') s.streaming = false;
        syncTabStatuses();
      }
      break;
    }
    case 'ack': {
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
        if (isViewOpen(s.id)) void fetchMessages(s.id);
        break;
      }
      const m = ev.message as DisplayMessage;
      if (m.role === 'user') {
        m.text = m.text.trim();
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
          if (fileIdx >= 0) s.messages.splice(fileIdx, 1);
        } else if (fileIdx >= 0) {
          s.messages[fileIdx] = { ...m, id: s.messages[fileIdx].id };
        } else upsert(s, m);
      } else if (m.role === 'toolResult') {
        mergeToolResult(s, m.toolCallId ?? '', m.text, !!m.isError);
      } else {
        upsert(s, m);
        if (m.role === 'assistant' && !s.streaming) {
          s.streaming = true;
          syncTabStatuses();
        }
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
      const s = byFile(ev.file);
      if (s?.messagesLoaded) void syncTail(s.id);
      void fetchList();
      break;
    }
    case 'tree': {
      if (ev.tree && typeof ev.tree.name === 'string') applyTree(ev.tree);
      break;
    }
  }
}

let es: EventSource | null = null;
let esClientId: string | null = null;
let lastViewFiles = new Set<string>();
let pingLostStreak = 0;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 3000;
const PING_WINDOW_MS = 5 * 60_000;

function openViewFiles(): string[] {
  return state.sessions
    .filter((s) => isViewOpen(s.id))
    .map((s) => s.file)
    .slice(0, 64);
}

function pushPingSample(ms: number | null) {
  const now = performance.now();
  const cutoff = now - PING_WINDOW_MS;
  while (state.pingSamples.length > 0 && state.pingSamples[0].t < cutoff) {
    state.pingSamples.shift();
  }
  state.pingSamples.push({ t: now, ms });
}

function postStreamSignal(endpoint: string, files: string[]) {
  if (!esClientId || files.length === 0) return;
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: esClientId, files }),
  }).catch(() => {});
}

function syncViewSubscriptions() {
  const next = new Set(openViewFiles());
  const added: string[] = [];
  const removed: string[] = [];
  for (const f of next) {
    if (!lastViewFiles.has(f)) added.push(f);
  }
  for (const f of lastViewFiles) {
    if (!next.has(f)) removed.push(f);
  }
  lastViewFiles = next;
  if (added.length > 0) postStreamSignal('/api/events/open', added);
  if (removed.length > 0) postStreamSignal('/api/events/close', removed);
}

function heartbeatTick() {
  if (!esClientId) {
    state.backendPing = null;
    pushPingSample(null);
    return;
  }
  const t0 = performance.now();
  const files = openViewFiles();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, HEARTBEAT_TIMEOUT_MS);
  fetch('/api/events/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: esClientId, files }),
    signal: ctrl.signal,
  })
    .then((r) => r.json())
    .then((j) => {
      window.clearTimeout(timer);
      if (timedOut) return;
      pingLostStreak = 0;
      state.backendLost = false;
      state.backendPing = Math.round(performance.now() - t0);
      pushPingSample(state.backendPing);
      state.backend = j.nest === false ? 'offline' : 'online';
    })
    .catch(() => {
      window.clearTimeout(timer);
      if (!timedOut) {
        state.backend = 'offline';
        state.backendPing = null;
        state.backendLost = false;
        pushPingSample(null);
        return;
      }
      pingLostStreak += 1;
      state.backendLost = true;
      pushPingSample(null);
      if (pingLostStreak >= 2) state.backend = 'offline';
    });
}

function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.addEventListener('ready', (e) => {
    try {
      esClientId = (JSON.parse((e as MessageEvent).data) as { clientId?: string }).clientId ?? null;
    } catch {
      esClientId = null;
    }
    lastViewFiles = new Set();
    syncViewSubscriptions();
    heartbeatTick();
  });
  es.onopen = () => {
    state.backend = 'online';
    syncAllTails();
  };
  es.onerror = () => {
    state.backend = 'offline';
    esClientId = null;
  };
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {}
  };

  heartbeatTick();
  const hbTimer = window.setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
  window.addEventListener('beforeunload', () => window.clearInterval(hbTimer));
}

function syncAllTails() {
  for (const s of state.sessions) {
    if (s.messagesLoaded) void syncTail(s.id);
  }
}

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

export function bindWorkspace(api: WorkspaceApi) {
  ws = api;

  api.setWindowStateProvider({
    read: () => {
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
      if (state.reviewTabId && !ids.includes(state.reviewTabId)) {
        state.reviewTabId = null;
      }
      syncViewSubscriptions();
    },
    { immediate: true },
  );

  api.setNewTabHandler(() => {
    void newChat();
  }, 'New Chat');

  api.setTabClickHandler((tabId) => {
    if (tabId === state.reviewTabId) exitReview();
  });

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

  watch(
    () => Object.keys(api.tabDefs).join('\n'),
    () => reconcileGhostWindows(),
    { immediate: true },
  );

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
      if (!hasPersistedLayout() && state.sessions.length > 0) {
        openChat(state.sessions[0].id);
        exitReview();
      }
    }
    reconcileGhostWindows();
  });

  if (listTimer === null) {
    listTimer = window.setInterval(() => void fetchList(), 15000);
  }
}

function hasPersistedLayout(): boolean {
  try {
    const raw = localStorage.getItem('sf.workspace.layout');
    if (!raw) return false;
    const snap = JSON.parse(raw);
    return !!(snap && snap.version === 1 && Array.isArray(snap.roots));
  } catch {
    return false;
  }
}

function reconcileGhostWindows() {
  if (!ws) return;
  for (const id of Object.keys(ws.tabDefs)) {
    if (!id.startsWith(TAB_PREFIX)) continue;
    if (ws.tabDefs[id].content !== BLANK_CONTENT) continue;
    const s = findSession(id.slice(TAB_PREFIX.length));
    if (s) {
      ws.tabDefs[id] = chatTabDef(s);
      syncSessionView(s);
    }
  }
}

export function findSession(sessionId: string): ChatSession | undefined {
  return state.sessions.find((s) => s.id === sessionId);
}

export function isViewOpen(sessionId: string): boolean {
  return state.openViewTabIds.has(chatTabId(sessionId));
}

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

export async function newChat(): Promise<void> {
  try {
    const { file } = await api<{ file: string; cwd: string }>('/api/new-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: NEW_CHAT_CWD }),
    });
    const id = encodeURIComponent(file);
    const now = Date.now();
    if (!findSession(id)) {
      state.sessions.unshift(pendingSessionEntry(file, NEW_CHAT_CWD, now));
      const pending = loadPendingChats();
      if (!pending.some((p) => p.file === file)) {
        pending.push({ file, cwd: NEW_CHAT_CWD, createdAt: now });
        persistPendingChats(pending);
      }
    }
    openChat(id);
  } catch (e) {
    if (!(e instanceof TypeError)) {
      state.lastError = e instanceof Error ? e.message : String(e);
    }
    state.backend = 'offline';
  }
}

const REVIEW_TAB_CLASS = 'sf-tab--review';

function enterReview(tabId: string) {
  state.reviewTabId = tabId;
  if (ws) {
    ws.tabDefs[tabId].tabClass = REVIEW_TAB_CLASS;
    ws.tabDefs[tabId].transient = true;
  }
}

function exitReview() {
  if (!state.reviewTabId || !ws) return;
  const def = ws.tabDefs[state.reviewTabId];
  if (def) {
    def.tabClass = '';
    def.transient = false;
  }
  state.reviewTabId = null;
  scheduleWindowPersist();
}

export function noteChatInteraction(sessionId: string) {
  if (state.reviewTabId === chatTabId(sessionId)) exitReview();
}

function syncSessionView(s: ChatSession) {
  if (!s.messagesLoaded) void fetchMessages(s.id);
  else void syncTail(s.id);
}

export function startSessionDrag(e: DragEvent, s: ChatSession) {
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(CHAT_DROP_TYPE, s.id);
  dt.setData('text/plain', s.title);
  dt.effectAllowed = 'copy';
}

export function openChat(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);

  const existing = ws.findTabGlobal(tabId);
  if (existing) {
    ws.ops.activateTab(existing.id, tabId);
    syncSessionView(s);
    return;
  }

  let tileId = targetTileId();
  if (state.reviewTabId) {
    const reviewTile = ws.findTabGlobal(state.reviewTabId);
    ws.ops.closeTab(state.reviewTabId);
    state.reviewTabId = null;
    tileId = reviewTile && ws.findTileGlobal(reviewTile.id) ? reviewTile.id : targetTileId();
  }
  if (!tileId) return;
  ws.ops.openTab(tileId, chatTabDef(s));
  enterReview(tabId);
  syncSessionView(s);
}

export function endExternalDrag() {
  ws?.endDrag();
}

export async function sendMessage(
  sessionId: string,
  text: string,
  opts: { wait?: boolean; images?: { data: string; mimeType: string }[] } = {},
) {
  const s = findSession(sessionId);
  const trimmed = text.trim();
  const images = opts.images ?? [];
  if (!s || (!trimmed && !images.length)) return;
  noteChatInteraction(sessionId);
  state.lastError = '';

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
    if (acked) return;
    const i = s.messages.findIndex((m) => m.id === mid);
    if (i >= 0) {
      s.messages[i] = { ...s.messages[i], sendFailed: true };
    }
    if (!(e instanceof TypeError)) {
      setSessionError(sessionId, e instanceof Error ? e.message : String(e));
    } else {
      state.backend = 'offline';
    }
  }
}

export async function resendMessage(sessionId: string, mid: string) {
  const s = findSession(sessionId);
  if (!s) return;
  const i = s.messages.findIndex((m) => m.id === mid);
  if (i < 0) return;
  const { text, images } = s.messages[i];
  s.messages.splice(i, 1);
  await sendMessage(sessionId, text, { images });
}

export function markCompactFailed(sessionId: string, reason?: string | null) {
  const s = findSession(sessionId);
  if (!s) return;
  s.compacting = false;
  s.compactResult = 'failed';
  s.compactEndedAt = Date.now();
  s.compactError = reason ?? null;
  if (reason) setSessionError(sessionId, reason);
}

export async function stopSession(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  try {
    await api('/api/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file }),
    });
  } catch {}
}

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

export function closeChatView(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);
  if (ws.findTabGlobal(tabId)) ws.ops.closeTab(tabId);
}

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
    if (!(e instanceof TypeError)) state.lastError = String((e as Error)?.message ?? e);
    return false;
  }
}

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
    delete state.sessionErrors[sessionId];
    delete sessionAttachments[sessionId];
    delete sessionOpenGroups[sessionId];
    forgetChatScroll(sessionId);
    saveDrafts();
    await refreshList();
    return true;
  } catch (e) {
    if (!(e instanceof TypeError)) state.lastError = String((e as Error)?.message ?? e);
    return false;
  }
}

export function setRenderMarkdown(on: boolean) {
  state.prefs.renderMarkdown = on;
  savePrefs();
}

const PAGE_SIZE = 50;

export async function fetchMessages(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  const params = new URLSearchParams({ file: s.file, limit: String(PAGE_SIZE) });
  try {
    const data = await api<any>(`/api/sessions/messages?${params.toString()}`);
    s.messages = (data.messages ?? []) as DisplayMessage[];
    s.messagesLoaded = true;
    s.oldestId = data.oldestId ?? null;
    s.hasMoreOlder = !!data.hasMore;
    s.loadingOlder = false;
    applySessionInfo(s, data);
  } catch (e) {
    s.loadingOlder = false;
    if (!(e instanceof TypeError)) {
      setSessionError(sessionId, `Failed to load messages: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export interface OlderPage {
  incoming: DisplayMessage[];
  oldestId: string | null;
  hasMore: boolean;
  payload: unknown;
}

export async function loadOlder(sessionId: string): Promise<OlderPage | null> {
  const s = findSession(sessionId);
  if (!s || s.loadingOlder || !s.hasMoreOlder || !s.oldestId) return null;
  s.loadingOlder = true;
  const params = new URLSearchParams({ file: s.file, limit: String(PAGE_SIZE), before: s.oldestId });
  try {
    const data = await api<any>(`/api/sessions/messages?${params.toString()}`);
    return {
      incoming: (data.messages ?? []) as DisplayMessage[],
      oldestId: data.oldestId ?? null,
      hasMore: !!data.hasMore,
      payload: data,
    };
  } catch (e) {
    s.loadingOlder = false;
    if (!(e instanceof TypeError)) {
      setSessionError(sessionId, `Failed to load messages: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

export function commitOlderPage(sessionId: string, page: OlderPage) {
  const s = findSession(sessionId);
  if (!s) return;
  const known = new Set(s.messages.map((m) => m.id).filter(Boolean));
  s.messages = [...page.incoming.filter((m) => !m.id || !known.has(m.id)), ...s.messages];
  s.oldestId = page.oldestId;
  s.hasMoreOlder = page.hasMore;
  s.loadingOlder = false;
  applySessionInfo(s, page.payload);
}

export async function syncTail(sessionId: string) {
  const s = findSession(sessionId);
  if (!s?.messagesLoaded) return;
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
      const seenId = new Set(s.messages.map((m) => m.id));
      const seenTs = new Set(s.messages.map((m) => `${m.role}:${m.ts}`));
      const fresh: DisplayMessage[] = [];
      for (const m of incoming) {
        if (seenId.has(m.id) || seenTs.has(`${m.role}:${m.ts}`)) continue;
        if (m.role === 'user') {
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
    applySessionInfo(s, data);
  } catch {}
}

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

export const store = {
  get sessions() {
    return state.sessions;
  },
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
  get pingSamples() {
    return state.pingSamples;
  },
  get lastError() {
    return state.lastError;
  },
  clearLastError() {
    state.lastError = '';
  },
  setLastError(message: string) {
    state.lastError = message;
  },
  draftOf(sessionId: string): string {
    return state.drafts[sessionId] ?? '';
  },
  setDraft(sessionId: string, text: string) {
    state.drafts[sessionId] = text;
    saveDrafts();
  },
  windowUiOf,
  setComposerHeight,
  chatScrollOf,
  forgetChatScroll,
  attachmentsOf,
  setAttachments,
  sessionErrorOf,
  setSessionError,
  clearSessionError,
  openGroupsOf,
  setOpenGroup,
  unsetOpenGroup,
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
  commitOlderPage,
  bindWorkspace,
  refreshList,
  appendLocalMessage,
};

export function useChatStore() {
  return store;
}

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

export function fmtCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}
