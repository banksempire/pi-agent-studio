import { BLANK_CONTENT, type ExternalDropTarget, type WorkspaceApi } from '@sf/composables/useWorkspace';
import type { WorkspaceTabDef } from '@sf/types/layout';
import { readUiValue, removeUiValue, uiEpoch, writeUiValue } from '@sf/uiState';
import { collectAllTabs, firstTile } from '@sf/workspace/tree';
import { reactive, ref, watch } from 'vue';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import { loadPeakHours, type PeakHourEntry } from '../peakHours';

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

export type SessionSyncState = 'working' | 'unread' | 'error' | 'open';

export interface SessionStateInfo {
  state: SessionSyncState;
  error: string;
}

export type StateFilter = Record<SessionSyncState, boolean>;

export const SYNC_STATES: SessionSyncState[] = ['working', 'unread', 'error', 'open'];

export type PingSample = { t: number; ms: number | null };

export type SendKeyMode = 'enter' | 'shiftEnter';

export interface JobRunInfo {
  id: number;
  jobId: string;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: string;
  error: string;
  sessionFile: string;
  queueItemId: number | null;
}

export interface JobTarget {
  mode: 'file' | 'new' | 'reuse';
  sessionFile?: string;
  cwd?: string;
}

export interface JobInfo {
  id: string;
  name: string;
  enabled: boolean;
  kind: string;
  scheduleType: 'once' | 'cron' | 'nonpeak';
  runAt: number | null;
  cron: string | null;
  payload: { message: string; target: JobTarget; model?: string | null; thinkLevel?: string | null };
  nextDue: number;
  missedPolicy: 'coalesce' | 'skip';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastRun: JobRunInfo | null;
}

export interface SchedulerInfo {
  running: number;
  waiting: number;
  limits: { globalMax: number; providerMax: number; modelMax: number };
}

export interface JobInput {
  name?: string;
  enabled?: boolean;
  scheduleType?: 'once' | 'cron' | 'nonpeak';
  runAt?: number;
  cron?: string;
  message?: string;
  targetMode?: 'file' | 'new' | 'reuse';
  sessionFile?: string;
  cwd?: string;
  model?: string | null;
  thinkLevel?: string | null;
  missedPolicy?: 'coalesce' | 'skip';
  createdBy?: string;
}

const JOBS_TAB_ID = 'jobs';
const JOBS_CONTENT = 'jobs';
const MODEL_CATALOG_TAB_ID = 'model-catalog';
const MODEL_CATALOG_CONTENT = 'model-catalog';
const PEAK_HOURS_TAB_ID = 'peak-hours';
const PEAK_HOURS_CONTENT = 'peak-hours';

interface ChatState {
  sessions: ChatSession[];
  activeChatId: string | null;
  openViewTabIds: Set<string>;
  reviewTabId: string | null;
  selectedDirs: Set<string>;
  tree: DirNode | null;
  treeCollapsed: Set<string>;
  pinnedIds: Set<string>;
  backend: BackendStatus;
  backendPing: number | null;
  backendLost: boolean;
  pingSamples: PingSample[];
  lastError: string;
  sessionErrors: Record<string, string>;
  drafts: Record<string, string>;
  sessionStates: Record<string, SessionStateInfo>;
  stateFilter: StateFilter;
  prefs: {
    sendKey: SendKeyMode;
    renderMarkdown: boolean;
  };
  jobs: JobInfo[];
  jobsLoaded: boolean;
  scheduler: SchedulerInfo | null;
  listTotal: number;
  listLoaded: number;
  loadingMore: boolean;
}

const PREFS_KEY = 'sf-chat:prefs';
const STATE_FILTER_KEY = 'sf-chat:stateFilter';
const DRAFTS_KEY = 'sf-chat:drafts';
const LEGACY_PINNED_KEY = 'sf-chat:pinned';

function readPersistedObject(uiKey: string, legacyKey: string): Record<string, unknown> | null {
  const v = readUiValue(uiKey);
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  try {
    const raw = localStorage.getItem(legacyKey);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function writePersistedObject(uiKey: string, legacyKey: string, value: unknown): void {
  writeUiValue(uiKey, value);
  try {
    if (localStorage.getItem(legacyKey) !== null) localStorage.removeItem(legacyKey);
  } catch {}
}

function loadStateFilter(): StateFilter {
  const base: StateFilter = { working: true, unread: true, error: true, open: true };
  const j = readPersistedObject('app.chat.stateFilter', STATE_FILTER_KEY);
  if (j) {
    for (const k of SYNC_STATES) {
      if (typeof j[k] === 'boolean') base[k] = j[k];
    }
  }
  return base;
}

function saveStateFilter() {
  writePersistedObject('app.chat.stateFilter', STATE_FILTER_KEY, state.stateFilter);
}

function isPinned(sessionId: string): boolean {
  return state.pinnedIds.has(sessionId);
}

function applyPins(files: string[]) {
  state.pinnedIds = new Set(files.map((f) => encodeURIComponent(f)));
}

async function fetchPins(): Promise<void> {
  try {
    const { pins } = await api<{ pins: string[] }>('/api/pins');
    applyPins(pins ?? []);
    migrateLegacyPins();
  } catch {}
}

function ensurePinnedSessionsVisible() {
  const known = new Set(state.sessions.map((s) => s.file));
  const missing: string[] = [];
  for (const id of state.pinnedIds) {
    try {
      const file = decodeURIComponent(id);
      if (!known.has(file)) missing.push(file);
    } catch {}
  }
  if (missing.length === 0) return;
  void fetchSessionsByFiles(missing).then((raws) => {
    if (raws.length > 0) mergeSessionPage(raws, false);
  });
}

function migrateLegacyPins() {
  const local = readPersistedObject('app.chat.pinned', LEGACY_PINNED_KEY);
  const files: string[] = [];
  if (local) {
    for (const [id, v] of Object.entries(local)) {
      if (!id || v !== true) continue;
      try {
        files.push(decodeURIComponent(id));
      } catch {}
    }
  }
  void (async () => {
    if (files.length > 0 && state.pinnedIds.size === 0) {
      for (const file of files) {
        await api('/api/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, pinned: true }),
        }).catch(() => null);
      }
      applyPins([...pinFiles(), ...files]);
    }
    removeUiValue('app.chat.pinned');
    try {
      localStorage.removeItem(LEGACY_PINNED_KEY);
    } catch {}
  })();
}

function pinFiles(): string[] {
  return [...state.pinnedIds].map((id) => {
    try {
      return decodeURIComponent(id);
    } catch {
      return id;
    }
  });
}

function togglePinned(sessionId: string) {
  let file = sessionId;
  try {
    file = decodeURIComponent(sessionId);
  } catch {}
  const nowPinned = !state.pinnedIds.has(sessionId);
  if (nowPinned) state.pinnedIds.add(sessionId);
  else state.pinnedIds.delete(sessionId);
  if (nowPinned) ensurePinnedSessionsVisible();
  void api('/api/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, pinned: nowPinned }),
  }).catch(() => {
    if (nowPinned) state.pinnedIds.delete(sessionId);
    else state.pinnedIds.add(sessionId);
    state.lastError = 'Could not sync pin — backend unreachable';
  });
}

const modelDetail = ref<{ model: ModelInfo; isDefault: boolean } | null>(null);
const modelDefaultLevel = ref<string | null>(null);
const modelDefaultSource = ref<'settings' | 'latest-chat' | 'fallback'>('fallback');

function requestModelDetail(model: ModelInfo, isDefault: boolean) {
  modelDetail.value = { model, isDefault };
}

const modelDefaultTick = ref(0);

const peakHours = ref<PeakHourEntry[]>([]);
const peakHoursError = ref('');
const peakHoursLoaded = ref(false);

async function refreshPeakHours() {
  try {
    peakHours.value = await loadPeakHours();
    peakHoursError.value = '';
  } catch (e) {
    if (!(e instanceof TypeError)) peakHoursError.value = String((e as Error)?.message ?? e);
  } finally {
    peakHoursLoaded.value = true;
  }
}

function syncModelDefault(view: ModelCatalogView) {
  modelDefaultLevel.value = view.defaultThinkingLevel ?? null;
  modelDefaultSource.value = view.defaultSource ?? 'fallback';
}

function applyModelDefault(view: ModelCatalogView) {
  syncModelDefault(view);
  const d = modelDetail.value;
  const key = view.default ? `${view.default.provider}/${view.default.id}` : null;
  if (d) {
    const selKey = `${d.model.provider}/${d.model.id}`;
    modelDetail.value = { model: d.model, isDefault: key === selKey };
  } else if (view.default) {
    modelDetail.value = { model: view.default, isDefault: true };
  }
  modelDefaultTick.value += 1;
}

function toggleStateFilter(s: SessionSyncState) {
  state.stateFilter = { ...state.stateFilter, [s]: !state.stateFilter[s] };
  saveStateFilter();
}
function loadPrefs(): ChatState['prefs'] {
  const j = readPersistedObject('app.chat.prefs', PREFS_KEY);
  if (j) {
    return {
      sendKey: j.sendKey === 'shiftEnter' ? 'shiftEnter' : 'enter',
      renderMarkdown: j.renderMarkdown !== false,
    };
  }
  return { sendKey: 'enter', renderMarkdown: true };
}
function savePrefs() {
  writePersistedObject('app.chat.prefs', PREFS_KEY, state.prefs);
}
function setSendKey(mode: SendKeyMode) {
  state.prefs.sendKey = mode;
  savePrefs();
}

function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const out: Record<string, string> = {};
        for (const [id, text] of Object.entries(j)) {
          if (typeof text === 'string') out[id] = text;
        }
        return out;
      }
    }
  } catch {}
  return {};
}
let draftsFlushTimer: number | null = null;

function saveDraftsNow() {
  if (state.listTotal > 0 && state.listLoaded >= state.listTotal) {
    const known = new Set(state.sessions.map((s) => s.id));
    for (const id of Object.keys(state.drafts)) {
      if (!known.has(id)) delete state.drafts[id];
    }
  }
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts));
  } catch {}
}

function saveDrafts() {
  if (draftsFlushTimer !== null) return;
  draftsFlushTimer = window.setTimeout(() => {
    draftsFlushTimer = null;
    saveDraftsNow();
  }, 300);
}

window.addEventListener('pagehide', () => {
  if (draftsFlushTimer !== null) {
    window.clearTimeout(draftsFlushTimer);
    draftsFlushTimer = null;
  }
  saveDraftsNow();
});

function migrateDraftsOutOfUiStore(): void {
  const v = readUiValue('app.chat.drafts');
  if (v === undefined) return;
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    try {
      if (localStorage.getItem(DRAFTS_KEY) === null) {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(v));
      }
    } catch {}
  }
  removeUiValue('app.chat.drafts');
}

migrateDraftsOutOfUiStore();

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
  jobs: [],
  jobsLoaded: false,
  scheduler: null,
  listTotal: 0,
  listLoaded: 0,
  loadingMore: false,
  activeChatId: null,
  openViewTabIds: new Set(),
  reviewTabId: null,
  selectedDirs: new Set(),
  tree: null,
  treeCollapsed: new Set(),
  pinnedIds: new Set<string>(),
  backend: 'connecting',
  backendPing: null,
  backendLost: false,
  pingSamples: [],
  lastError: '',
  sessionErrors: {},
  drafts: loadDrafts(),
  sessionStates: {},
  stateFilter: loadStateFilter(),
  prefs: loadPrefs(),
});

watch(uiEpoch, () => {
  state.stateFilter = loadStateFilter();
  state.prefs = loadPrefs();
});

if (readUiValue('app.chat.stateFilter') === undefined)
  writeUiValue('app.chat.stateFilter', state.stateFilter);
if (readUiValue('app.chat.prefs') === undefined) writeUiValue('app.chat.prefs', state.prefs);

try {
  localStorage.removeItem('sf-chat:pending');
} catch {}

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
    tab.tabClass = statusTabClass(tabId, s);
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
  state?: SessionSyncState | 'close';
  stateError?: string;
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
let refreshListTimer: number | null = null;

function scheduleRefreshList() {
  if (refreshListTimer !== null) return;
  refreshListTimer = window.setTimeout(() => {
    refreshListTimer = null;
    void fetchList();
  }, 350);
}

function sameSessionStates(
  a: Record<string, SessionStateInfo>,
  b: Record<string, SessionStateInfo>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const y = b[k];
    if (!y || a[k].state !== y.state || a[k].error !== y.error) return false;
  }
  return true;
}

let jobsRefreshTimer: number | null = null;

async function refreshJobs() {
  try {
    const { jobs, scheduler } = await api<{ jobs: JobInfo[]; scheduler: SchedulerInfo | null }>('/api/jobs');
    state.jobs = jobs;
    state.scheduler = scheduler;
    state.jobsLoaded = true;
  } catch {}
}

function scheduleJobsRefresh() {
  if (jobsRefreshTimer !== null) return;
  jobsRefreshTimer = window.setTimeout(() => {
    jobsRefreshTimer = null;
    void refreshJobs();
  }, 300);
}

async function createJob(input: JobInput): Promise<JobInfo> {
  const { job } = await api<{ job: JobInfo }>('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  await refreshJobs();
  return job;
}

async function updateJob(id: string, input: JobInput): Promise<JobInfo> {
  const { job } = await api<{ job: JobInfo }>(`/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  await refreshJobs();
  return job;
}

async function deleteJob(id: string): Promise<void> {
  await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshJobs();
}

async function runJobNow(id: string): Promise<void> {
  await api(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' });
  await refreshJobs();
}

async function fetchJobRuns(id: string): Promise<JobRunInfo[]> {
  const { runs } = await api<{ runs: JobRunInfo[] }>(`/api/jobs/${encodeURIComponent(id)}/runs?limit=50`);
  return runs;
}

async function updateSchedulerConfig(config: {
  globalMax?: number;
  providerMax?: number;
  modelMax?: number;
}): Promise<void> {
  await api('/api/scheduler/config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  await refreshJobs();
}

const selectedJobId = ref<string | null>(null);
const jobEditor = reactive<{ open: boolean; jobId: string | null }>({ open: false, jobId: null });

function selectJob(id: string | null) {
  selectedJobId.value = id;
}

function openJobEditor(jobId: string | null) {
  jobEditor.open = true;
  jobEditor.jobId = jobId;
}

function closeJobEditor() {
  jobEditor.open = false;
  jobEditor.jobId = null;
}

function openJobs() {
  if (!ws) return;
  const existing = ws.findTabGlobal(JOBS_TAB_ID);
  if (existing) {
    ws.ops.activateTab(existing.id, JOBS_TAB_ID);
    return;
  }
  const tileId = targetTileId();
  if (!tileId) return;
  ws.ops.openTab(tileId, {
    id: JOBS_TAB_ID,
    label: 'Scheduler',
    icon: '⏰',
    content: JOBS_CONTENT,
    props: {},
  });
}

function openModelCatalog() {
  if (!ws) return;
  const existing = ws.findTabGlobal(MODEL_CATALOG_TAB_ID);
  if (existing) {
    ws.ops.activateTab(existing.id, MODEL_CATALOG_TAB_ID);
    return;
  }
  const tileId = targetTileId();
  if (!tileId) return;
  ws.ops.openTab(tileId, {
    id: MODEL_CATALOG_TAB_ID,
    label: 'Model Catalog',
    icon: '🤖',
    content: MODEL_CATALOG_CONTENT,
    props: {},
  });
}

function openPeakHours() {
  if (!ws) return;
  const existing = ws.findTabGlobal(PEAK_HOURS_TAB_ID);
  if (existing) {
    ws.ops.activateTab(existing.id, PEAK_HOURS_TAB_ID);
    return;
  }
  const tileId = targetTileId();
  if (!tileId) return;
  ws.ops.openTab(tileId, {
    id: PEAK_HOURS_TAB_ID,
    label: 'Peak Hours',
    icon: '🕒',
    content: PEAK_HOURS_CONTENT,
    props: {},
  });
}

const CHAT_PAGE_SIZE = 50;

async function fetchSessionsPage(
  offset: number,
  limit: number,
): Promise<{ raws: SessionInfo[]; total: number }> {
  const r = await api<{ sessions: SessionInfo[]; total: number }>(
    `/api/sessions?limit=${limit}&offset=${offset}`,
  );
  return { raws: r.sessions ?? [], total: r.total ?? 0 };
}

async function fetchSessionsByFiles(files: string[]): Promise<SessionInfo[]> {
  if (files.length === 0) return [];
  try {
    const r = await api<{ sessions: SessionInfo[] }>(
      `/api/sessions?files=${encodeURIComponent(files.join(','))}`,
    );
    return r.sessions ?? [];
  } catch {
    return [];
  }
}

function initialInterestFiles(): string[] {
  const files = new Set<string>();
  const pushId = (id: string) => {
    try {
      files.add(decodeURIComponent(id));
    } catch {}
  };
  for (const id of state.pinnedIds) pushId(id);
  if (ws) {
    for (const tabId of Object.keys(ws.tabDefs)) {
      if (!tabId.startsWith(TAB_PREFIX)) continue;
      pushId(tabId.slice(TAB_PREFIX.length));
    }
  }
  return [...files];
}

function sessionFromRaw(raw: SessionInfo, old: ChatSession | undefined): ChatSession {
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
}

function mergeSessionPage(allRaws: SessionInfo[], fullList: boolean): void {
  const raws: SessionInfo[] = [];
  const seenRaw = new Set<string>();
  for (const raw of allRaws) {
    if (seenRaw.has(raw.file)) continue;
    seenRaw.add(raw.file);
    raws.push(raw);
  }
  const prev = new Map(state.sessions.map((s) => [s.file, s]));
  const unchanged =
    raws.every((raw) => {
      const old = prev.get(raw.file);
      return old?.onDisk && oldListSignature(old) === listSignature(raw);
    }) &&
    (!fullList || prev.size === raws.length);
  const synced: Record<string, SessionStateInfo> = {};
  for (const raw of raws) {
    if (raw.state && raw.state !== 'close') {
      synced[raw.file] = { state: raw.state, error: raw.stateError ?? '' };
    }
  }
  if (fullList) {
    if (!sameSessionStates(state.sessionStates, synced)) state.sessionStates = synced;
    pruneVisits(new Set(Object.keys(synced)));
    if (unchanged) return;
  } else {
    const nextStates = { ...state.sessionStates };
    let statesChanged = false;
    for (const raw of raws) {
      const info = synced[raw.file];
      const cur = nextStates[raw.file];
      if (info) {
        if (!cur || cur.state !== info.state || cur.error !== info.error) {
          nextStates[raw.file] = info;
          statesChanged = true;
        }
      } else if (cur) {
        delete nextStates[raw.file];
        statesChanged = true;
      }
    }
    if (statesChanged) state.sessionStates = nextStates;
    if (unchanged) return;
  }
  const rawsByFile = new Map(raws.map((raw) => [raw.file, raw]));
  const memoryOnly = state.sessions.filter((s) => !s.onDisk && !rawsByFile.has(s.file));
  const onDisk: ChatSession[] = fullList
    ? raws.map((raw) => sessionFromRaw(raw, prev.get(raw.file)))
    : (() => {
        const kept: ChatSession[] = [];
        for (const s of state.sessions) {
          if (!s.onDisk) continue;
          const raw = rawsByFile.get(s.file);
          kept.push(raw ? sessionFromRaw(raw, s) : s);
        }
        for (const raw of raws) {
          if (prev.has(raw.file)) continue;
          kept.push(sessionFromRaw(raw, prev.get(raw.file)));
        }
        return kept;
      })();
  onDisk.sort((a, b) => b.lastActivity - a.lastActivity);
  state.sessions = [...memoryOnly, ...onDisk];
}

async function fetchList() {
  try {
    const initial = state.listTotal === 0 && state.listLoaded === 0;
    const [page, pinRaws] = await Promise.all([
      fetchSessionsPage(0, CHAT_PAGE_SIZE),
      initial ? fetchSessionsByFiles(initialInterestFiles()) : Promise.resolve<SessionInfo[]>([]),
    ]);
    state.listTotal = page.total;
    state.listLoaded = Math.max(state.listLoaded, page.raws.length);
    mergeSessionPage([...page.raws, ...pinRaws], page.raws.length >= page.total);
    syncTabStatuses();
    state.backend = 'online';
    saveDrafts();
    sweepGhostChatTabs();
    sweepRestoredChatTabs();
  } catch (_e) {
    state.backend = 'offline';
  }
}

export async function loadMoreSessions(): Promise<void> {
  if (state.loadingMore || state.listLoaded >= state.listTotal) return;
  state.loadingMore = true;
  try {
    const offset = state.listLoaded;
    const { raws, total } = await fetchSessionsPage(offset, CHAT_PAGE_SIZE);
    state.listTotal = total;
    state.listLoaded = raws.length === 0 ? total : offset + raws.length;
    mergeSessionPage(raws, offset === 0 && raws.length >= total);
  } catch (e) {
    if (!(e instanceof TypeError)) state.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    state.loadingMore = false;
  }
}

function sweepGhostChatTabs() {
  if (!ws) return;
  for (const tabId of Object.keys(ws.tabDefs)) {
    if (!tabId.startsWith(TAB_PREFIX)) continue;
    if (ws.tabDefs[tabId].content !== BLANK_CONTENT) continue;
    if (findSession(tabId.slice(TAB_PREFIX.length))) continue;
    ws.ops.closeTab(tabId);
  }
}

let restoredChatTabs: Set<string> | null = null;

function sweepRestoredChatTabs() {
  if (!ws || !restoredChatTabs || restoredChatTabs.size === 0) return;
  for (const tabId of [...restoredChatTabs]) {
    restoredChatTabs.delete(tabId);
    if (findSession(tabId.slice(TAB_PREFIX.length))) continue;
    ws.ops.closeTab(tabId);
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
  const msgs = s.messages;
  const lastIdx = msgs.length - 1;
  if (lastIdx >= 0 && msgs[lastIdx].id === m.id) {
    msgs[lastIdx] = m;
    return;
  }
  const i = msgs.findIndex((x) => x.id === m.id);
  if (i >= 0) msgs[i] = m;
  else msgs.push(m);
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
    case 'session_state': {
      if (ev.state === 'close') delete state.sessionStates[ev.file];
      else state.sessionStates[ev.file] = { state: ev.state, error: ev.error ?? '' };
      break;
    }
    case 'session_states': {
      const synced: Record<string, SessionStateInfo> = {};
      for (const s of ev.states ?? []) {
        if (s?.file && s.state && s.state !== 'close') {
          synced[s.file] = { state: s.state, error: s.error ?? '' };
        }
      }
      state.sessionStates = synced;
      break;
    }
    case 'session_status': {
      const s = byFile(ev.file);
      if (ev.status === 'running') forgetVisit(ev.file);
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
      scheduleRefreshList();
      break;
    }
    case 'tree': {
      if (ev.tree && typeof ev.tree.name === 'string') applyTree(ev.tree);
      break;
    }
    case 'job_event': {
      scheduleJobsRefresh();
      break;
    }
    case 'queue_update': {
      setQueue(ev.file, Array.isArray(ev.items) ? ev.items : []);
      break;
    }
    case 'pins_update': {
      applyPins(Array.isArray(ev.pins) ? ev.pins : []);
      ensurePinnedSessionsVisible();
      break;
    }
    case 'session_upsert': {
      if (ev.session?.file) {
        mergeSessionPage([ev.session as SessionInfo], false);
        syncTabStatuses();
      }
      break;
    }
    case 'session_remove': {
      if (state.sessions.some((s) => s.file === ev.file)) {
        state.sessions = state.sessions.filter((s) => s.file !== ev.file);
        sweepGhostChatTabs();
      }
      break;
    }
  }
}

let es: EventSource | null = null;
let esClientId: string | null = null;
let esReconnectTimer: number | null = null;
let hbTimer: number | null = null;
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

function postStreamSignal(endpoint: string, files: string[]): Promise<void> {
  if (!esClientId || files.length === 0) return Promise.resolve();
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: esClientId, files }),
  }).then(
    () => {},
    () => {},
  );
}

const visitSentAt: Record<string, number> = {};

function forgetVisit(file: string) {
  delete visitSentAt[file];
}

function pruneVisits(known: Set<string>) {
  for (const f of Object.keys(visitSentAt)) {
    if (!known.has(f)) delete visitSentAt[f];
  }
}

export function noteVisit(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  const st = state.sessionStates[s.file];
  if (!st) return;
  if (st.state === 'working') {
    if (visitSentAt[s.file] !== undefined) return;
    visitSentAt[s.file] = Date.now();
  } else {
    if (st.state !== 'unread' && st.state !== 'error') return;
    const last = visitSentAt[s.file] ?? 0;
    if (Date.now() - last < 1000) return;
    visitSentAt[s.file] = Date.now();
    state.sessionStates[s.file] = { state: 'open', error: '' };
  }
  if (!esClientId) return;
  fetch('/api/events/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: esClientId, file: s.file }),
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
      if (!j || j.ok === false) {
        pingLostStreak += 1;
        state.backendLost = true;
        state.backendPing = null;
        pushPingSample(null);
        if (j && j.ok === false) {
          if (es) {
            try {
              es.close();
            } catch {}
            es = null;
          }
          esClientId = null;
          scheduleEsReconnect();
        }
        return;
      }
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

function scheduleEsReconnect() {
  if (esReconnectTimer !== null || es !== null) return;
  esReconnectTimer = window.setTimeout(() => {
    esReconnectTimer = null;
    if (es === null) connectEvents();
  }, 2000);
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
    void refreshQueues();
    migrateLegacyQueues();
    void fetchPins();
  });
  es.onopen = () => {
    state.backend = 'online';
    syncAllTails();
    void refreshQueues();
  };
  es.onerror = () => {
    state.backend = 'offline';
    esClientId = null;
    if (es !== null && es.readyState === EventSource.CLOSED) {
      try {
        es.close();
      } catch {}
      es = null;
    }
    scheduleEsReconnect();
  };
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {}
  };

  heartbeatTick();
  if (hbTimer === null) {
    const timer = window.setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
    hbTimer = timer;
    window.addEventListener('beforeunload', () => window.clearInterval(timer));
  }
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
  restoredChatTabs = new Set(Object.keys(api.tabDefs).filter((id) => id.startsWith(TAB_PREFIX)));

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
      sweepLazySessions(new Set(ids));
      syncViewSubscriptions();
    },
    { immediate: true },
  );

  api.setNewTabHandler(() => {
    void newChat();
  }, 'New Chat');

  api.setTabClickHandler((tabId) => {
    if (tabId === state.reviewTabId) exitReview();
    if (tabId.startsWith(TAB_PREFIX)) noteVisit(tabId.slice(TAB_PREFIX.length));
  });

  api.setTabLongPressHandler((tabId) => {
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
        const next = (def.tabClass ?? '')
          .split(/\s+/)
          .filter((c) => c && c !== REVIEW_TAB_CLASS)
          .join(' ');
        if (next !== (def.tabClass ?? '')) {
          def.tabClass = next;
          def.transient = false;
        }
      }
    },
  );

  connectEvents();
  void fetchPins()
    .then(() => fetchList())
    .then(() => {
      if (firstBind) {
        firstBind = false;
        if (!hasPersistedLayout() && state.sessions.length > 0) {
          openChat(state.sessions[0].id, { visit: false });
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
    const s = findSession(id.slice(TAB_PREFIX.length));
    if (!s) continue;
    const def = ws.tabDefs[id];
    if (def.content === BLANK_CONTENT) {
      ws.tabDefs[id] = chatTabDef(s);
      syncSessionView(s);
      continue;
    }
    const st = tabStatusOf(s);
    def.icon = st.icon;
    def.tabClass = statusTabClass(id, s);
    def.label = s.title;
    if (!s.messagesLoaded) syncSessionView(s);
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

export function syncedSessions(): ChatSession[] {
  return state.sessions
    .filter((s) => state.sessionStates[s.file] && cwdMatches(s, state.selectedDirs))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

export function syncStateOf(s: ChatSession): SessionStateInfo | undefined {
  return state.sessionStates[s.file];
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

function statusTabClass(tabId: string, s: ChatSession | undefined): string {
  const base = s ? tabStatusOf(s).tabClass : '';
  return tabId === state.reviewTabId ? (base ? `${base} ${REVIEW_TAB_CLASS}` : REVIEW_TAB_CLASS) : base;
}

function enterReview(tabId: string) {
  state.reviewTabId = tabId;
  if (ws) {
    ws.tabDefs[tabId].tabClass = statusTabClass(tabId, findSession(tabId.slice(TAB_PREFIX.length)));
    ws.tabDefs[tabId].transient = true;
  }
}

function exitReview() {
  if (!state.reviewTabId || !ws) return;
  const tabId = state.reviewTabId;
  const def = ws.tabDefs[tabId];
  state.reviewTabId = null;
  if (def) {
    def.tabClass = statusTabClass(tabId, findSession(tabId.slice(TAB_PREFIX.length)));
    def.transient = false;
  }
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

export function openChat(sessionId: string, opts: { visit?: boolean } = {}) {
  const s = findSession(sessionId);
  if (!s || !ws) return;
  const tabId = chatTabId(sessionId);

  const existing = ws.findTabGlobal(tabId);
  if (existing) {
    ws.ops.activateTab(existing.id, tabId);
    syncSessionView(s);
    if (opts.visit !== false) noteVisit(sessionId);
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
  if (opts.visit !== false) noteVisit(sessionId);
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

export interface QueuedChatMessage {
  id: number;
  text: string;
  images?: { data: string; mimeType: string }[];
}

const LEGACY_QUEUES_KEY = 'sf-chat:queues';
const LEGACY_CLAIMS_KEY = 'sf-chat:queue-claims';

const queuesByFile = reactive<Record<string, QueuedChatMessage[]>>({});
const queueHoldBeats = new Map<string, { stop: () => void }>();
let queueHoldMs = 15000;

function queueListOf(file: string): QueuedChatMessage[] {
  let q = queuesByFile[file];
  if (!q) {
    q = reactive<QueuedChatMessage[]>([]);
    queuesByFile[file] = q;
  }
  return q;
}

export function queuedMessagesOf(sessionId: string): QueuedChatMessage[] {
  const s = findSession(sessionId);
  if (!s) return reactive<QueuedChatMessage[]>([]);
  return queueListOf(s.file);
}

function cloneItems(items: QueuedChatMessage[]): QueuedChatMessage[] {
  return items.map((m) => ({
    id: m.id,
    text: m.text,
    ...(m.images?.length ? { images: m.images.map((im) => ({ ...im })) } : {}),
  }));
}

function setQueue(file: string, items: QueuedChatMessage[]) {
  queuesByFile[file] = reactive(cloneItems(items));
}

function applyQueueMap(queues: Record<string, QueuedChatMessage[]>) {
  for (const k of Object.keys(queuesByFile)) delete queuesByFile[k];
  for (const [file, items] of Object.entries(queues)) {
    if (Array.isArray(items) && items.length) setQueue(file, items);
  }
}

async function refreshQueues(): Promise<void> {
  try {
    const j = await api<{ queues: Record<string, QueuedChatMessage[]> }>('/api/queue');
    applyQueueMap(j.queues ?? {});
  } catch {}
}

function sanitizeQueueList(list: unknown): QueuedChatMessage[] {
  if (!Array.isArray(list)) return [];
  const msgs: QueuedChatMessage[] = [];
  for (const m of list) {
    if (!(m && typeof m === 'object' && typeof (m as any).text === 'string')) continue;
    const rawImages: unknown[] = Array.isArray((m as any).images) ? (m as any).images : [];
    const images = rawImages
      .filter((im): im is { data: string; mimeType: string } => {
        const x = im as { data?: unknown; mimeType?: unknown } | null | undefined;
        return (
          !!x &&
          typeof x.data === 'string' &&
          typeof x.mimeType === 'string' &&
          x.data !== '' &&
          /^image\//.test(x.mimeType)
        );
      })
      .slice(0, 4);
    const text = (m as any).text as string;
    if (!text.trim() && !images.length) continue;
    msgs.push({ id: 0, text, ...(images.length ? { images } : {}) });
  }
  return msgs;
}

function migrateLegacyQueues() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_QUEUES_KEY);
  } catch {}
  if (!raw) return;
  const byFile = new Map<string, QueuedChatMessage[]>();
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      for (const [key, list] of Object.entries(j)) {
        const msgs = sanitizeQueueList(list);
        if (msgs.length) byFile.set(decodeURIComponent(key), msgs);
      }
    }
  } catch {}
  if (byFile.size === 0) {
    try {
      localStorage.removeItem(LEGACY_QUEUES_KEY);
      localStorage.removeItem(LEGACY_CLAIMS_KEY);
    } catch {}
    return;
  }
  void (async () => {
    for (const [file, msgs] of byFile) {
      for (const m of msgs) {
        await fetch('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, message: m.text, ...(m.images?.length ? { images: m.images } : {}) }),
        }).catch(() => null);
      }
    }
    try {
      if (localStorage.getItem(LEGACY_QUEUES_KEY) === raw) localStorage.removeItem(LEGACY_QUEUES_KEY);
      localStorage.removeItem(LEGACY_CLAIMS_KEY);
    } catch {}
    void refreshQueues();
  })();
}

export async function enqueueMessage(
  sessionId: string,
  text: string,
  images: { data: string; mimeType: string }[] = [],
): Promise<boolean> {
  const s = findSession(sessionId);
  const trimmed = text.trim();
  if (!s || (!trimmed && !images.length)) return false;
  const temp: QueuedChatMessage = { id: -Date.now(), text: trimmed };
  if (images.length) temp.images = images.map((im) => ({ ...im }));
  queueListOf(s.file).push(temp);
  try {
    const { items } = await api<{ items: QueuedChatMessage[] }>('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: s.file,
        message: trimmed,
        ...(images.length ? { images } : {}),
      }),
    });
    setQueue(s.file, items ?? []);
    return true;
  } catch (e) {
    const q = queuesByFile[s.file];
    if (q) {
      const i = q.findIndex((m) => m.id === temp.id);
      if (i >= 0) q.splice(i, 1);
    }
    if (!(e instanceof TypeError)) {
      setSessionError(sessionId, e instanceof Error ? e.message : String(e));
    } else {
      state.backend = 'offline';
    }
    return false;
  }
}

export async function removeQueuedMessage(sessionId: string, id: number) {
  const s = findSession(sessionId);
  if (!s) return;
  const q = queuesByFile[s.file];
  if (q) {
    const i = q.findIndex((m) => m.id === id);
    if (i >= 0) q.splice(i, 1);
  }
  try {
    const { items } = await api<{ items: QueuedChatMessage[] }>(
      `/api/queue/${id}?file=${encodeURIComponent(s.file)}`,
      { method: 'DELETE' },
    );
    setQueue(s.file, items ?? []);
  } catch {}
}

export async function updateQueuedMessage(sessionId: string, id: number, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const s = findSession(sessionId);
  if (!s) return;
  const m = queuesByFile[s.file]?.find((x) => x.id === id);
  if (m) m.text = trimmed;
  try {
    const { items } = await api<{ items: QueuedChatMessage[] }>(
      `/api/queue/${id}?file=${encodeURIComponent(s.file)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      },
    );
    setQueue(s.file, items ?? []);
  } catch {}
}

export function queueEditHold(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  queueEditRelease(sessionId);
  const entry = { timer: null as number | null, stopped: false };
  const arm = () => {
    if (entry.stopped || entry.timer !== null) return;
    entry.timer = window.setInterval(beat, Math.max(1000, Math.floor(queueHoldMs / 3)));
  };
  const beat = () => {
    if (entry.stopped) return;
    api<{ holdMs?: number }>('/api/queue/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file }),
    })
      .then((j) => {
        if (j?.holdMs && j.holdMs !== queueHoldMs) queueHoldMs = j.holdMs;
        arm();
      })
      .catch(arm);
  };
  beat();
  queueHoldBeats.set(sessionId, {
    stop: () => {
      entry.stopped = true;
      if (entry.timer !== null) window.clearInterval(entry.timer);
      entry.timer = null;
    },
  });
}

export function queueEditRelease(sessionId: string) {
  queueHoldBeats.get(sessionId)?.stop();
  queueHoldBeats.delete(sessionId);
  const s = findSession(sessionId);
  if (!s) return;
  api('/api/queue/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: s.file }),
  }).catch(() => {});
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

export async function compactSession(sessionId: string) {
  const s = findSession(sessionId);
  if (!s) return;
  try {
    const j = await api<any>('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file, command: 'compact' }),
    });
    if (!j.ok) markCompactFailed(sessionId, j.error ?? null);
  } catch (e) {
    markCompactFailed(sessionId, `Compaction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

function forgetSessionUi(s: ChatSession) {
  forgetVisit(s.file);
  state.pinnedIds.delete(s.id);
  delete state.drafts[s.id];
  delete windowUi[s.id];
  delete state.sessionErrors[s.id];
  delete sessionAttachments[s.id];
  delete sessionOpenGroups[s.id];
  forgetChatScroll(s.id);
  if (s.file) delete queuesByFile[s.file];
  saveDrafts();
}

function sweepLazySessions(openIds: Set<string>) {
  const keep: ChatSession[] = [];
  let changed = false;
  for (const s of state.sessions) {
    if (!s.onDisk && s.messages.length === 0 && !openIds.has(chatTabId(s.id))) {
      forgetSessionUi(s);
      changed = true;
    } else {
      keep.push(s);
    }
  }
  if (changed) state.sessions = keep;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const s = findSession(sessionId);
  if (!s) return false;
  closeChatView(sessionId);
  await postStreamSignal('/api/events/close', [s.file]);
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
    forgetSessionUi(s);
    state.sessions = state.sessions.filter((x) => x.id !== sessionId);
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

const messagesInflight = new Set<string>();

export async function fetchMessages(sessionId: string) {
  const s = findSession(sessionId);
  if (!s || messagesInflight.has(sessionId)) return;
  messagesInflight.add(sessionId);
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
  } finally {
    messagesInflight.delete(sessionId);
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
  if (!lastEntryId && s.messages.length === 0) return;
  const query = lastEntryId
    ? `file=${encodeURIComponent(s.file)}&after=${encodeURIComponent(lastEntryId)}`
    : `file=${encodeURIComponent(s.file)}&limit=${String(PAGE_SIZE)}`;
  try {
    const data = await api<any>(`/api/sessions/messages?${query}`);
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
    if (!lastEntryId) {
      s.oldestId = data.oldestId ?? s.oldestId;
      s.hasMoreOlder = !!data.hasMore;
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
  get listTotal() {
    return state.listTotal;
  },
  get listLoaded() {
    return state.listLoaded;
  },
  get hasMoreSessions() {
    return state.listTotal > state.listLoaded;
  },
  get loadingMore() {
    return state.loadingMore;
  },
  loadMoreSessions,
  get filteredSessions() {
    return state.sessions.filter((s) => s.onDisk && cwdMatches(s, state.selectedDirs));
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
  queuedMessagesOf,
  enqueueMessage,
  removeQueuedMessage,
  updateQueuedMessage,
  queueEditHold,
  queueEditRelease,
  sessionErrorOf,
  setSessionError,
  clearSessionError,
  openGroupsOf,
  setOpenGroup,
  unsetOpenGroup,
  findSession,
  isViewOpen,
  syncedSessions,
  syncStateOf,
  noteVisit,
  newChat,
  openChat,
  noteChatInteraction,
  sendMessage,
  resendMessage,
  refreshJobs,
  createJob,
  updateJob,
  deleteJob,
  runJobNow,
  fetchJobRuns,
  updateSchedulerConfig,
  openJobs,
  openModelCatalog,
  openPeakHours,
  refreshPeakHours,
  requestModelDetail,
  applyModelDefault,
  syncModelDefault,
  compactSession,
  stopSession,
  closeChatView,
  renameSession,
  deleteSession,
  isPinned,
  togglePinned,
  get prefs() {
    return state.prefs;
  },
  get jobs() {
    return state.jobs;
  },
  get scheduler() {
    return state.scheduler;
  },
  get jobsLoaded() {
    return state.jobsLoaded;
  },
  get modelDetail() {
    return modelDetail.value;
  },
  get selectedJob() {
    return state.jobs.find((j) => j.id === selectedJobId.value) ?? null;
  },
  get jobEditor() {
    return jobEditor;
  },
  selectJob,
  openJobEditor,
  closeJobEditor,
  get modelDefaultTick() {
    return modelDefaultTick.value;
  },
  get peakHours() {
    return peakHours.value;
  },
  get peakHoursError() {
    return peakHoursError.value;
  },
  get peakHoursLoaded() {
    return peakHoursLoaded.value;
  },
  get modelDefaultLevel() {
    return modelDefaultLevel.value;
  },
  get modelDefaultSource() {
    return modelDefaultSource.value;
  },
  get stateFilter() {
    return state.stateFilter;
  },
  toggleStateFilter,
  get sessionStates() {
    return state.sessionStates;
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
