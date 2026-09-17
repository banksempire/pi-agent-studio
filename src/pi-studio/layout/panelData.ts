import { registerPanelData } from '@sf/registry';
import type {
  BadgeTone,
  DotTone,
  KeyValueItem,
  PanelFormRow,
  PanelListItem,
  PanelTableRow,
  TreeNode,
} from '@sf/types/panel';
import { computed, reactive, ref, watch } from 'vue';
import { requestConfirm } from '../confirm';
import { cronToPattern, describeCron } from '../cronInfo';
import { fmtTime as fmtJobTime, fmtRelative } from '../jobText';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import {
  cachedModelMatches,
  loadSessionModels,
  modelMenuItems,
  setCachedModel,
  setDefaultModel,
  setSessionModel,
} from '../modelInfo';
import {
  deletePeakHours,
  type PeakHourEntry,
  updatePeakHours,
  weekdaysLabel,
  windowLabel,
} from '../peakHours';
import {
  CHAT_DROP_TYPE,
  type ChatSession,
  fmtCompactTokens,
  fmtDateTime,
  fmtTokens,
  type JobRunInfo,
  type SendKeyMode,
  timeAgo,
  useChatStore,
} from '../store/chat';

const store = useChatStore();

function previewOf(s: ChatSession): string {
  const t = (s.preview || s.title).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

function chatRowOptions(s: ChatSession) {
  const pinItem = store.isPinned(s.id)
    ? { id: 'unpin', label: 'Unpin', icon: 'unpin' }
    : { id: 'pin', label: 'Pin', icon: 'pin' };
  return [
    pinItem,
    { id: 'rename', label: 'Rename', icon: '✎' },
    { id: 'delete', label: 'Delete', icon: '🗑', danger: true },
  ];
}

function chatListItem(s: ChatSession): PanelListItem {
  return {
    id: s.id,
    label: s.title,
    meta: timeAgo(s.lastActivity),
    icon: s.status === 'running' ? '⏳' : undefined,
    iconBlink: s.status === 'running',
    detail: previewOf(s),
    title: `Open chat window: ${s.title}`,
    active: s.id === store.activeChatId,
    action: 'chat-history',
    options: chatRowOptions(s),
    dragType: CHAT_DROP_TYPE,
    dragText: s.title,
  };
}

const LOAD_MORE_ITEM_ID = 'sf-load-more-chats';

function chatList(pinned: boolean): { items: PanelListItem[]; empty?: string } {
  const sessions = [...store.filteredSessions]
    .filter((s) => store.isPinned(s.id) === pinned)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  const items = sessions.map(chatListItem);
  if (!pinned && store.hasMoreSessions) {
    const remaining = Math.max(0, store.listTotal - store.listLoaded);
    items.push({
      id: LOAD_MORE_ITEM_ID,
      label: store.loadingMore ? 'Loading…' : 'Load older chats',
      meta: `${remaining} more`,
      title: 'Load more chat history',
      action: 'chat-history-more',
    });
  }
  let empty: string | undefined;
  if (sessions.length === 0) {
    if (store.filteredSessions.length === 0) {
      empty =
        store.selectedDirs.size > 0
          ? 'No chats in this directory.'
          : 'No chats yet — press Ctrl+N or click New Chat above to start one.';
    } else {
      empty = pinned ? 'No pinned chats — right-click one below to pin it.' : 'All chats are pinned.';
    }
  }
  return { items, empty };
}

registerPanelData('chat-pinned', () => chatList(true));
registerPanelData('chat-history', () => chatList(false));

const SESSION_BADGE_TONES: Record<string, BadgeTone> = {
  working: 'ok-blink',
  unread: 'accent',
  error: 'err',
  open: 'accent-soft',
};

function sessionListItem(s: ChatSession): PanelListItem {
  const info = store.syncStateOf(s);
  const st = info?.state ?? 'open';
  const badge = st === 'working' ? (store.isViewOpen(s.id) ? 'working' : 'working · bg') : st;
  const error = info?.state === 'error' ? info.error || 'error' : '';
  const errSuffix = info?.state === 'error' && info.error ? `\n${info.error}` : '';
  return {
    id: s.id,
    label: s.title,
    meta: `${s.stats.messageCount} msgs`,
    badge,
    badgeTone: SESSION_BADGE_TONES[st] ?? 'muted',
    detail: error || s.preview || s.title,
    title: `Open chat window: ${s.title}${errSuffix}`,
    active: s.id === store.activeChatId,
    action: 'chat-sessions',
  };
}

registerPanelData('chat-sessions', () => ({
  items: store
    .syncedSessions()
    .filter((s) => store.stateFilter[store.syncStateOf(s)?.state ?? 'open'])
    .map(sessionListItem),
  empty:
    'No sessions in this view. Sessions that are working, unread, in error, or open elsewhere\nappear here — adjust the status filter (▾ on the title bar).',
}));

function dirNodesOf(): TreeNode[] {
  const root = store.tree;
  if (!root) return [];
  const allSelected = (node: typeof root): boolean => {
    if (store.selectedDirs.has(node.path)) return true;
    if (node.children.length === 0) return false;
    return node.children.every(allSelected);
  };
  const anySelected = (node: typeof root): boolean => {
    if (store.selectedDirs.has(node.path)) return true;
    for (const c of node.children) if (anySelected(c)) return true;
    return false;
  };
  const map = (node: typeof root): TreeNode => {
    const on = store.selectedDirs.has(node.path) || allSelected(node);
    const mid = !on && node.children.some(anySelected);
    return {
      id: node.path,
      label: node.name,
      badge: String(node.count),
      title: `Filter chats under ${node.path}`,
      check: on ? 'on' : mid ? 'mid' : 'off',
      action: 'dir-toggle',
      children: node.children.length ? node.children.map(map) : undefined,
    };
  };
  return [map(root)];
}

registerPanelData('directory-tree', () => dirNodesOf());

void store.loadTree();

const sessionModel = reactive({
  catalog: null as ModelCatalogView | null,
  busy: false,
  error: '',
});

const activeSession = computed<ChatSession | null>(() =>
  store.activeChatId ? (store.findSession(store.activeChatId) ?? null) : null,
);

async function loadSessionModelCatalog(force = false) {
  const s = activeSession.value;
  if (!s?.file) {
    sessionModel.catalog = null;
    return;
  }
  sessionModel.error = '';
  try {
    sessionModel.catalog = await loadSessionModels(s.file, force);
  } catch (e) {
    if (!(e instanceof TypeError)) {
      sessionModel.error = String((e as Error)?.message ?? e);
    }
    sessionModel.catalog = null;
  }
}

const activeFile = computed(() => activeSession.value?.file ?? null);
watch(activeFile, () => void loadSessionModelCatalog());
watch(
  () => activeSession.value?.stats.model ?? null,
  (m) => {
    const f = activeSession.value?.file;
    if (f && cachedModelMatches(f, m)) return;
    void loadSessionModelCatalog(true);
  },
);
void loadSessionModelCatalog();

async function commitSessionModel(m: ModelInfo, thinkLevel: string) {
  const s = activeSession.value;
  if (!s?.file || sessionModel.busy) return;
  sessionModel.busy = true;
  sessionModel.error = '';
  try {
    await setSessionModel(s.file, `${m.provider}/${m.id}`, thinkLevel);
    setCachedModel(s.file, m, thinkLevel);
    void loadSessionModelCatalog(true);
  } catch (e) {
    if (!(e instanceof TypeError)) {
      sessionModel.error = String((e as Error)?.message ?? e);
    }
  } finally {
    sessionModel.busy = false;
  }
}

registerPanelData('model-picker-rows', () => {
  const c = sessionModel.catalog;
  const thinking = c?.currentThinkingLevel;
  return [
    { key: 'Provider', value: c?.current?.provider ?? '—' },
    { key: 'Model', value: c?.current?.name || c?.current?.id || '—' },
    { key: 'Thinking', value: thinking && thinking !== 'off' ? thinking : '(None)' },
  ];
});

registerPanelData('model-picker-menu', () => modelMenuItems(sessionModel.catalog?.models ?? []));

registerPanelData('model-picker-note', () => {
  if (sessionModel.busy) return { text: 'Applying…', tone: 'info' as const };
  if (sessionModel.error) return { text: sessionModel.error, tone: 'error' as const };
  if (!activeSession.value) return { text: 'Open a chat window to change its model.', tone: 'info' as const };
  return { text: undefined, tone: 'info' as const };
});

const SESSION_DOT: Record<string, DotTone> = { idle: 'muted', running: 'ok-pulse' };

registerPanelData('session-header', () => {
  const s = activeSession.value;
  if (!s) return { title: undefined };
  return { dot: SESSION_DOT[s.status] ?? 'muted', title: s.title, tip: s.file };
});

function truncateMiddle(text: string, head: number, tail: number): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function tuiCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

registerPanelData('session-stats', () => {
  const s = activeSession.value;
  if (!s) {
    return {
      items: [],
      empty: 'No chat window activated.\nOpen a chat from the Chat panel to see its session stats here.',
    };
  }
  const st = s.stats;
  const out: KeyValueItem[] = [];
  const section = (label: string) => out.push({ key: label, header: true });
  const push = (label: string, value: string, extra?: Partial<KeyValueItem>) =>
    out.push({ key: label, value, ...extra });

  section('General');
  push('File', truncateMiddle(s.file, 34, 34), { indent: 1, title: s.file });
  const id = s.sessionId;
  push('ID', !id ? '—' : id.length > 16 ? `${id.slice(0, 13)}…` : id, {
    indent: 1,
    title: s.sessionId ?? s.file,
  });
  push('Working dir', s.cwd || '—', { indent: 1, title: s.cwd });
  push('Started', fmtDateTime(st.startedAt), { indent: 1 });
  push('Last activity', fmtDateTime(st.lastActivity), { indent: 1 });

  section('Messages');
  push('Total', fmtTokens(st.messageCount), { indent: 1 });
  push('User', fmtTokens(st.userMessages), { indent: 1 });
  push('Assistant', fmtTokens(st.assistantMessages), { indent: 1 });
  push('Tools', fmtTokens(st.toolResults), { indent: 1 });

  section('Tokens');
  push('Input', fmtTokens(st.promptTokens), { indent: 1 });
  if (st.promptTokens > 0 && (st.cacheRead > 0 || st.cacheWrite > 0)) {
    const hit = ((st.cacheRead / st.promptTokens) * 100).toFixed(1);
    push('Cached', fmtTokens(st.cacheRead), { indent: 1 });
    push('rate%', `${hit}%`, { indent: 2 });
    const written = st.cacheWrite > 0 ? ` (${fmtTokens(st.cacheWrite)} written to cache)` : '';
    push('Uncached', `${fmtTokens(st.tokensIn + st.cacheWrite)}${written}`, { indent: 1 });
  }
  push('Output', fmtTokens(st.tokensOut), { indent: 1 });
  push('Total', fmtTokens(st.promptTokens + st.tokensOut), { indent: 1 });

  if (st.costUsd > 0 || st.cacheWaste.missedTokens > 0) {
    section('Cost');
    push('Total', tuiCost(st.costUsd), { indent: 1 });
    if (st.costBreakdown.length > 1) {
      for (const b of st.costBreakdown) {
        push(b.key, `${tuiCost(b.cost)} (${fmtCompactTokens(b.tokens)})`, { indent: 1 });
      }
    }
    if (st.cacheWaste.missedTokens > 0) {
      push(
        'Cache Re-billed',
        st.cacheWaste.missedCost >= 0.0001
          ? `${tuiCost(st.cacheWaste.missedCost)} (${fmtCompactTokens(st.cacheWaste.missedTokens)})`
          : `(${fmtCompactTokens(st.cacheWaste.missedTokens)})`,
        { indent: 1 },
      );
    }
  }
  return { items: out };
});

const SEND_KEY_TITLES: Record<string, string> = {
  enter: 'Enter sends, Shift+Enter new line',
  shiftEnter: 'Shift+Enter sends, Enter new line',
};

registerPanelData('prefs-rows', () => [
  {
    id: 'sendKey',
    label: 'Send with',
    pills: {
      value: store.prefs.sendKey,
      choices: [
        { value: 'enter', label: 'Enter', title: SEND_KEY_TITLES.enter },
        { value: 'shiftEnter', label: 'Shift+Enter', title: SEND_KEY_TITLES.shiftEnter },
      ],
    },
    action: 'set-pref',
  },
  {
    id: 'renderMarkdown',
    label: 'Render Markdown',
    pills: {
      value: store.prefs.renderMarkdown ? 'yes' : 'no',
      choices: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    action: 'set-pref',
  },
]);

const PATTERN_LABELS: Record<string, string> = {
  minutes: 'Minutes',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

registerPanelData('job-detail-rows', () => {
  const j = store.selectedJob;
  if (!j) {
    return { items: [], empty: 'Select a job in the table to see its details.' };
  }
  const list: KeyValueItem[] = [{ key: 'Job name', value: j.name }];
  const pattern = j.scheduleType === 'cron' && j.cron ? cronToPattern(j.cron) : null;
  if (j.scheduleType === 'once') {
    list.push({ key: 'Schedule', value: 'Once' });
    list.push({ key: 'Run at', value: `${fmtJobTime(j.runAt)} · ${fmtRelative(j.runAt)}` });
  } else if (j.scheduleType === 'nonpeak') {
    list.push({ key: 'Schedule', value: 'Advanced — off peak' });
    list.push({
      key: 'Off peak',
      value: `once a day at ${j.payload.model ?? '—'}’s first open moment`,
    });
  } else {
    list.push({
      key: 'Schedule',
      value: pattern ? `Periodic — ${PATTERN_LABELS[pattern.pattern] ?? pattern.pattern}` : 'Advanced — cron',
    });
  }
  if (j.cron) {
    const desc = describeCron(j.cron);
    list.push({ key: 'Cron', value: desc ? `${j.cron} (${desc})` : j.cron });
  }
  list.push({
    key: 'If missed',
    value: j.missedPolicy === 'skip' ? 'skip, wait for the next occurrence' : 'run once on catch-up',
  });
  list.push({
    key: 'Next run',
    value: j.enabled ? `${fmtJobTime(j.nextDue)} · ${fmtRelative(j.nextDue)}` : '—',
  });
  list.push({
    key: 'Last run',
    value: j.lastRun ? `${j.lastRun.status} ${fmtRelative(j.lastRun.finishedAt ?? j.lastRun.queuedAt)}` : '—',
  });
  const model = j.payload.model;
  list.push({
    key: 'Model override',
    value: model ? (j.payload.thinkLevel ? `${model}·${j.payload.thinkLevel}` : model) : 'Session default',
  });
  const t = j.payload.target;
  list.push({
    key: 'Session',
    value:
      t.mode === 'file'
        ? `Existing session — ${(t.sessionFile ?? '').split('/').pop()}`
        : t.mode === 'new'
          ? `Fresh per run — ${t.cwd ?? ''}`
          : `One per cwd — ${t.cwd ?? ''}`,
  });
  list.push({ key: 'Message', value: j.payload.message });
  return { items: list, empty: undefined };
});

const jobRuns = reactive<{ runs: JobRunInfo[]; busy: boolean; error: string }>({
  runs: [],
  busy: false,
  error: '',
});

watch(
  () => store.selectedJob?.id ?? null,
  async (id) => {
    if (!id) {
      jobRuns.runs = [];
      jobRuns.error = '';
      jobRuns.busy = false;
      return;
    }
    jobRuns.busy = true;
    jobRuns.error = '';
    try {
      jobRuns.runs = await store.fetchJobRuns(id);
    } catch (e) {
      if (!(e instanceof TypeError)) jobRuns.error = String((e as Error)?.message ?? e);
      jobRuns.runs = [];
    } finally {
      jobRuns.busy = false;
    }
  },
  { immediate: true },
);

registerPanelData('job-runs', () => {
  if (!store.selectedJob) {
    return { rows: [], empty: 'Select a job to see its run history.', note: undefined };
  }
  if (jobRuns.busy) return { rows: [], empty: 'loading…', note: undefined };
  if (jobRuns.error) return { rows: [], empty: undefined, note: jobRuns.error, noteTone: 'error' as const };
  const rows: PanelTableRow[] = jobRuns.runs.map((r) => ({
    id: String(r.id),
    cells: {
      status: r.status,
      time: fmtRelative(r.queuedAt),
      session: r.sessionFile ? (r.sessionFile.split('/').pop() as string) : '—',
      error: r.error ?? '',
    },
    titles: {
      time: fmtJobTime(r.queuedAt),
      session: r.sessionFile ?? '',
      error: r.error ?? '',
    },
  }));
  return { rows, empty: 'no runs yet', note: undefined };
});

const schedulerForm = reactive({ globalMax: 2, providerMax: 2, modelMax: 1 });
const schedulerError = ref('');
const SCHEDULER_SAVE_DEBOUNCE_MS = 500;

watch(
  () => store.scheduler,
  (s) => {
    if (!s || schedulerBusy) return;
    schedulerForm.globalMax = s.limits.globalMax;
    schedulerForm.providerMax = s.limits.providerMax;
    schedulerForm.modelMax = s.limits.modelMax;
  },
  { immediate: true },
);

let schedulerBusy = false;
let schedulerTimer: number | null = null;

function schedulerDirty(): boolean {
  const s = store.scheduler;
  if (!s) return false;
  return (
    schedulerForm.globalMax !== s.limits.globalMax ||
    schedulerForm.providerMax !== s.limits.providerMax ||
    schedulerForm.modelMax !== s.limits.modelMax
  );
}

async function saveScheduler() {
  if (schedulerBusy || !schedulerDirty()) return;
  schedulerBusy = true;
  schedulerError.value = '';
  try {
    await store.updateSchedulerConfig({
      globalMax: schedulerForm.globalMax,
      providerMax: schedulerForm.providerMax,
      modelMax: schedulerForm.modelMax,
    });
  } catch (e) {
    if (!(e instanceof TypeError)) schedulerError.value = String((e as Error)?.message ?? e);
  } finally {
    schedulerBusy = false;
    if (!schedulerError.value && schedulerDirty() && schedulerTimer === null) {
      schedulerTimer = window.setTimeout(() => {
        schedulerTimer = null;
        void saveScheduler();
      }, SCHEDULER_SAVE_DEBOUNCE_MS);
    }
  }
}

function setSchedulerCap(key: 'globalMax' | 'providerMax' | 'modelMax', value: number) {
  if (!Number.isInteger(value) || value < 1) return;
  schedulerForm[key] = value;
  if (schedulerTimer !== null) return;
  schedulerTimer = window.setTimeout(() => {
    schedulerTimer = null;
    void saveScheduler();
  }, SCHEDULER_SAVE_DEBOUNCE_MS);
}

const SCHEDULER_ROWS: Array<{ id: keyof typeof schedulerForm; label: string; title: string }> = [
  { id: 'globalMax', label: 'Global', title: 'Global concurrent job runs' },
  { id: 'providerMax', label: 'Per Provider', title: 'Concurrent job runs per provider' },
  { id: 'modelMax', label: 'Per Model', title: 'Concurrent job runs per model' },
];

registerPanelData('scheduler-caps', () => {
  const rows: PanelFormRow[] = SCHEDULER_ROWS.map((r) => ({
    id: r.id,
    label: r.label,
    stepper: { value: schedulerForm[r.id], min: 1, max: 10, step: 1, title: r.title },
    action: 'set-scheduler-cap',
  }));
  if (schedulerError.value) {
    rows.push({ id: 'error', note: schedulerError.value, noteTone: 'error' });
  }
  return { rows };
});

function fmtContext(window: number): string {
  if (!window) return '—';
  return window >= 1000 ? `${Math.round(window / 1000).toLocaleString()}k` : String(window);
}

function fmtModelTokens(n?: number): string {
  if (!n) return '—';
  return n.toLocaleString();
}

function fmtRate(v?: number): string {
  if (v === undefined || v === null) return '—';
  return `$${v.toFixed(2)}`;
}

registerPanelData('model-detail-rows', () => {
  const m = store.modelDetail?.model ?? null;
  if (!m) return { items: [] };
  const cost = m.cost;
  const input = m.input?.length ? m.input.join(' + ') : 'text';
  return {
    items: [
      { key: 'Provider', value: m.provider },
      { key: 'Model', value: m.name || m.id },
      { key: 'ID', value: m.id },
      { key: 'API', value: m.api || '—' },
      { key: 'Endpoint', value: m.baseUrl || '—' },
      { key: 'Input', value: input },
      { key: 'Reasoning', value: m.reasoning ? 'yes' : 'no' },
      { key: 'Context', value: fmtContext(m.contextWindow) },
      { key: 'Max Output', value: fmtModelTokens(m.maxTokens) },
      { key: 'Cost In/Out', value: cost ? `${fmtRate(cost.input)} / ${fmtRate(cost.output)}` : '—' },
      {
        key: 'Cache R/W',
        value: cost ? `${fmtRate(cost.cacheRead)} / ${fmtRate(cost.cacheWrite)}` : '—',
      },
      {
        key: 'Thinking',
        value: m.reasoning ? m.thinkingLevels.filter((l) => l !== 'off').join(', ') || 'off' : '—',
      },
    ],
  };
});

const modelPrefBusy = ref(false);
const modelPrefError = ref('');

async function toggleModelDefault() {
  const d = store.modelDetail;
  if (!d || modelPrefBusy.value) return;
  modelPrefBusy.value = true;
  modelPrefError.value = '';
  try {
    const key = `${d.model.provider}/${d.model.id}`;
    const level = store.modelDefaultLevel ?? undefined;
    const res = d.isDefault ? await setDefaultModel(null) : await setDefaultModel(key, level);
    store.applyModelDefault(res);
  } catch (e) {
    if (!(e instanceof TypeError)) modelPrefError.value = String((e as Error)?.message ?? e);
  } finally {
    modelPrefBusy.value = false;
  }
}

async function setModelDefaultLevel(lvl: string) {
  const d = store.modelDetail;
  if (!d || modelPrefBusy.value) return;
  modelPrefBusy.value = true;
  modelPrefError.value = '';
  try {
    const res = await setDefaultModel(`${d.model.provider}/${d.model.id}`, lvl);
    store.applyModelDefault(res);
  } catch (e) {
    if (!(e instanceof TypeError)) modelPrefError.value = String((e as Error)?.message ?? e);
  } finally {
    modelPrefBusy.value = false;
  }
}

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

registerPanelData('model-preference-rows', () => {
  const detail = store.modelDetail;
  if (!detail) return { rows: [], empty: 'Select a model to change preferences.' };
  const rows: PanelFormRow[] = [
    {
      id: 'default',
      label: 'Default model',
      pills: { value: detail.isDefault ? 'yes' : 'no', choices: YES_NO },
      action: 'set-model-pref',
    },
  ];
  if (detail.isDefault) {
    const levels = detail.model.thinkingLevels ?? [];
    const activeLevel =
      store.modelDefaultLevel && levels.includes(store.modelDefaultLevel)
        ? store.modelDefaultLevel
        : (levels[0] ?? null);
    rows.push({
      id: 'think',
      label: 'Thinking',
      pills: {
        value: activeLevel ?? '',
        choices: levels.map((l) => ({
          value: l,
          label: l.charAt(0).toUpperCase() + l.slice(1),
        })),
      },
      action: 'set-model-pref',
    });
    if (store.modelDefaultSource === 'latest-chat') {
      rows.push({ id: 'src', note: 'via latest new chat', noteTone: 'muted' });
    }
  }
  if (modelPrefError.value) {
    rows.push({ id: 'error', note: modelPrefError.value, noteTone: 'error' });
  }
  return { rows };
});

const peakActionError = ref('');

const peakModelKey = computed(() => {
  const d = store.modelDetail;
  return d ? `${d.model.provider}/${d.model.id}` : '';
});

registerPanelData('peak-model', () => ({
  title: peakModelKey.value || 'select a model in the catalog',
  disabled: !peakModelKey.value,
}));

function windowText(e: PeakHourEntry): string {
  const days = weekdaysLabel(e.weekdays);
  const base = windowLabel(e.start, e.end, e.utcOffset);
  return days && days !== 'daily' ? `${base} · ${days}` : base;
}

function utcText(e: PeakHourEntry): string {
  return `(UTC) ${e.startUtc}-${e.endUtc}${e.wrapsMidnightUtc ? ' ↻' : ''}`;
}

registerPanelData('peak-hours-rows', () => ({
  items: store.peakHours
    .filter((e) => e.key === peakModelKey.value)
    .map((e) => ({
      id: e.id,
      label: windowText(e),
      title: `peak ${windowText(e)}`,
      detail: utcText(e),
      note: e.note || undefined,
      muted: !e.enabled,
      switch: {
        on: e.enabled,
        title: e.enabled ? 'Disable window' : 'Enable window',
      },
      buttons: [
        { id: 'edit', icon: '✎', title: 'Edit window' },
        { id: 'delete', icon: '✕', title: 'Delete window', danger: true },
      ],
      action: 'peak-row',
    })),
}));

registerPanelData('peak-error', () => {
  const text = store.peakHoursError || peakActionError.value;
  return text ? { text, tone: 'error' as const } : { text: undefined, tone: 'error' as const };
});

async function togglePeakEntry(id: string) {
  const entry = store.peakHours.find((e) => e.id === id);
  if (!entry) return;
  peakActionError.value = '';
  try {
    await updatePeakHours(id, { enabled: !entry.enabled });
    await store.refreshPeakHours();
  } catch (e) {
    if (!(e instanceof TypeError)) peakActionError.value = String((e as Error)?.message ?? e);
  }
}

async function removePeakEntry(id: string) {
  const entry = store.peakHours.find((e) => e.id === id);
  if (!entry) return;
  if (
    !(await requestConfirm({
      title: 'Delete peak hours?',
      text: `This deletes the peak-hours window for ${entry.key}.`,
      confirmLabel: 'Delete',
    }))
  ) {
    return;
  }
  peakActionError.value = '';
  try {
    await deletePeakHours(id);
    if (peakDialog.entryId === id) closePeakDialog();
    await store.refreshPeakHours();
  } catch (e) {
    if (!(e instanceof TypeError)) peakActionError.value = String((e as Error)?.message ?? e);
  }
}

const peakDialog = reactive<{ open: boolean; entryId: string | null }>({ open: false, entryId: null });

function openPeakAdd() {
  if (!peakModelKey.value) return;
  peakDialog.entryId = null;
  peakDialog.open = true;
}

function openPeakEdit(id: string) {
  peakDialog.entryId = id;
  peakDialog.open = true;
}

function closePeakDialog() {
  peakDialog.open = false;
  peakDialog.entryId = null;
}

async function onPeakSaved() {
  closePeakDialog();
  await store.refreshPeakHours();
}

const renameDialog = reactive<{ open: boolean; sessionId: string | null; value: string }>({
  open: false,
  sessionId: null,
  value: '',
});

function openRename(sessionId: string) {
  const s = store.findSession(sessionId);
  if (!s) return;
  renameDialog.value = s.title;
  renameDialog.sessionId = sessionId;
  renameDialog.open = true;
}

async function confirmRename() {
  const id = renameDialog.sessionId;
  const name = renameDialog.value.trim();
  renameDialog.open = false;
  if (!id) return;
  const s = store.findSession(id);
  if (s && name && name !== s.title) await store.renameSession(id, name);
}

export function handlePanelAction(action: string | undefined, payload: unknown): void {
  const p = (payload ?? {}) as {
    gesture?: string;
    id?: string;
    option?: string;
    button?: string;
    value?: unknown;
    row?: string;
  };
  switch (action) {
    case 'chat-history':
      if (p.gesture === 'activate') store.openChat(p.id ?? '');
      else if (p.gesture === 'menu') {
        if (p.option === 'pin' || p.option === 'unpin') store.togglePinned(p.id ?? '');
        else if (p.option === 'rename') openRename(p.id ?? '');
        else if (p.option === 'delete') void store.deleteSession(p.id ?? '');
      }
      break;
    case 'chat-history-more':
      if (p.gesture === 'activate') void store.loadMoreSessions();
      break;
    case 'chat-sessions':
      if (p.gesture === 'activate') store.openChat(p.id ?? '');
      break;
    case 'dir-toggle':
      if (p.id) store.toggleDir(p.id);
      break;
    case 'set-pref':
      if (p.row === 'sendKey' && typeof p.value === 'string') store.setSendKey(p.value as SendKeyMode);
      else if (p.row === 'renderMarkdown' && typeof p.value === 'string')
        store.setRenderMarkdown(p.value === 'yes');
      break;
    case 'set-scheduler-cap':
      if (
        (p.row === 'globalMax' || p.row === 'providerMax' || p.row === 'modelMax') &&
        typeof p.value === 'number'
      ) {
        setSchedulerCap(p.row, p.value);
      }
      break;
    case 'pick-model': {
      const data = (payload as { data?: { model?: ModelInfo; level?: string } } | undefined)?.data;
      if (data?.model && data.level !== undefined) void commitSessionModel(data.model, data.level);
      break;
    }
    case 'set-model-pref':
      if (p.row === 'default' && typeof p.value === 'string') {
        const want = p.value === 'yes';
        const d = store.modelDetail;
        if (d && want !== d.isDefault) void toggleModelDefault();
      } else if (p.row === 'think' && typeof p.value === 'string') {
        void setModelDefaultLevel(p.value);
      }
      break;
    case 'peak-add':
      openPeakAdd();
      break;
    case 'peak-row':
      if (p.gesture === 'switch') void togglePeakEntry(p.id ?? '');
      else if (p.gesture === 'button' && p.button === 'edit') openPeakEdit(p.id ?? '');
      else if (p.gesture === 'button' && p.button === 'delete') void removePeakEntry(p.id ?? '');
      break;
    default:
      break;
  }
}

const MOBILE_BREAKPOINT = 500;

if (typeof window !== 'undefined') {
  let wasMobile = window.innerWidth < MOBILE_BREAKPOINT;
  window.addEventListener('resize', () => {
    const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
    if (isMobile !== wasMobile) {
      wasMobile = isMobile;
      closePeakDialog();
      renameDialog.open = false;
    }
  });
}

export function usePanelDialogs() {
  return {
    peakDialog,
    renameDialog,
    closePeakDialog,
    onPeakSaved,
    confirmRename,
    peakModelKey,
  };
}

registerPanelData('app-cwd', () => '/workspace/sf');

void store.refreshPeakHours();
