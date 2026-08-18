<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ActionBubble, ActionGroup, type ActionKind, type ActionStatus, actionName } from '../actionBubble';
import { dataUrlOf, processImageFile } from '../imageAttach';
import {
  allSlashCommands,
  type ParsedSlash,
  parseSlash,
  runSlash,
  type SlashCommandInfo,
  type SlashPicker,
  type SlashResult,
} from '../slash/commands';
import {
  attachmentsOf,
  type ChatAttachment,
  type ChatSession,
  chatScrollOf,
  clearSessionError,
  type DisplayMessage,
  fmtTime,
  openGroupsOf,
  sessionErrorOf,
  setAttachments,
  setOpenGroup,
  setSessionError,
  unsetOpenGroup,
  useChatStore,
} from '../store/chat';
import ImageReview from './ImageReview.vue';
import MessageImages, { type MessageImage } from './MessageImages.vue';

const props = defineProps<{ sessionId: string }>();
const store = useChatStore();

const session = computed<ChatSession | undefined>(() => store.findSession(props.sessionId));
const renderMd = computed(() => store.prefs.renderMarkdown);

const open = computed(() => openGroupsOf(props.sessionId));
function toggle(id: string) {
  setOpenGroup(props.sessionId, id, !open.value[id]);
}

const mdCache = new WeakMap<DisplayMessage, { text: string; html: string }>();
function md(m: DisplayMessage): string {
  const hit = mdCache.get(m);
  if (hit && hit.text === m.text) return hit.html;
  const html = m.text ? DOMPurify.sanitize(marked.parse(m.text) as string) : '';
  mdCache.set(m, { text: m.text, html });
  return html;
}

function summaryPreview(text: string): string {
  const t = text.trim();
  const capped = t.length > 300 ? t.slice(0, 300) : t;
  const flat = capped.replace(/\s+/g, ' ');
  return (t.length > 300 ? `${flat}…` : flat) || '…';
}
const input = computed({
  get: () => store.draftOf(props.sessionId),
  set: (v: string) => store.setDraft(props.sessionId, v),
});
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

const contextDisplay = computed(() => {
  const ctx = session.value?.context;
  if (!ctx?.window) return '';
  const win = formatTokens(ctx.window);
  return ctx.percent === null ? `?/${win}` : `${ctx.percent.toFixed(1)}%/${win}`;
});
const contextTitle = computed(() => {
  const ctx = session.value?.context;
  if (!ctx?.window) return '';
  const win = formatTokens(ctx.window);
  const hint = session.value?.compacting ? '' : ' Click to compact the context.';
  return ctx.percent === null
    ? `Context in use: unknown until the next response (${win} window).${hint}`
    : `${Math.round(ctx.tokens ?? 0).toLocaleString()} of ${win} tokens (${ctx.percent.toFixed(1)}%).${hint}`;
});
const contextClass = computed(() => {
  const p = session.value?.context?.percent;
  if (p === null || p === undefined) return '';
  return p > 90 ? 'chat-context--error' : p > 70 ? 'chat-context--warn' : '';
});

function sticky() {
  return chatScrollOf(props.sessionId).sticky;
}
function setSticky(v: boolean) {
  chatScrollOf(props.sessionId).sticky = v;
}

function scrollToBottom() {
  const el = listEl.value;
  if (!el) return;
  const { max } = posInfo(el);
  el.scrollTop = zeroIsBottom ? 0 : max;
}

let zeroIsBottom: boolean | null = null;
function detectScrollConvention(): boolean {
  if (zeroIsBottom !== null) return zeroIsBottom;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;display:flex;flex-direction:column-reverse;overflow:auto;height:10px';
  const child = document.createElement('div');
  child.style.height = '100px';
  probe.appendChild(child);
  document.body.appendChild(probe);
  const pMax = probe.scrollHeight - probe.clientHeight;
  const pSt = probe.scrollTop;
  probe.remove();
  zeroIsBottom = pMax <= 0 ? true : Math.abs(pSt) < pMax / 2;
  return zeroIsBottom;
}

const LOAD_OLDER_ZONE = 80;
const STICKY_ZONE = 48;

function posInfo(el: HTMLElement) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const st = el.scrollTop;
  return { max, st, distFromTop: detectScrollConvention() ? st + max : st };
}

function clampScroll(max: number, v: number): number {
  return zeroIsBottom ? Math.max(-max, Math.min(0, v)) : Math.max(0, Math.min(max, v));
}

let sepJumpAt = 0;

let touchDownCount = 0;
let gestureScrolled = false;

function maybeLoadOlder() {
  const el = listEl.value;
  if (!el) return;
  if (posInfo(el).distFromTop < LOAD_OLDER_ZONE && performance.now() - sepJumpAt > 250) {
    void loadOlder();
  }
}

function onTouchStart() {
  touchDownCount += 1;
  gestureScrolled = false;
}

function onTouchEnd() {
  touchDownCount = Math.max(0, touchDownCount - 1);
  if (gestureScrolled) maybeLoadOlder();
}

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  if (touchDownCount > 0) gestureScrolled = true;
  const st = chatScrollOf(props.sessionId);
  const { max, st: stv, distFromTop } = posInfo(el);
  st.sticky = distFromTop > max - STICKY_ZONE;
  st.top = stv;
  if (touchDownCount === 0) maybeLoadOlder();
}

async function loadOlder() {
  const s = session.value;
  if (!s || s.loadingOlder || !s.hasMoreOlder) return;
  const sid = props.sessionId;
  const page = await store.loadOlder(s.id);
  if (!page) return;
  store.commitOlderPage(sid, page);
}

const keepBottom = () => {
  if (sticky()) nextTick(scrollToBottom);
};
watch(() => {
  const s = session.value;
  if (!s) return '';
  const last = s.messages[s.messages.length - 1];
  const tcs = last?.toolCalls;
  const tcKey = tcs?.length
    ? tcs
        .map(
          (t) =>
            `${t.id}:${t.name}:${(t.args ?? '').length}:${(t.result ?? '').length}${t.isError ? ':e' : ''}`,
        )
        .join('|')
    : '';
  const key = last
    ? `${s.messages.length}:${last.id}:${last.text.length}:${(last.thinking ?? '').length}:${tcKey}:${last.error ?? ''}`
    : `${s.messages.length}:`;
  return key + (s.compacting ? ':c' : '');
}, keepBottom);

const lastMessage = computed<DisplayMessage | undefined>(() => {
  const msgs = session.value?.messages ?? [];
  return msgs[msgs.length - 1];
});

const streaming = computed(
  () => session.value?.status === 'running' && lastMessage.value?.role === 'assistant',
);

const ROLE_LABELS: Record<string, string> = {
  user: 'You',
  assistant: 'pi',
  summary: 'summary',
  bash: 'bash',
  system: 'system',
};
function roleLabel(m: DisplayMessage): string {
  return ROLE_LABELS[m.role] ?? 'custom';
}

export type AgentPart = { kind: 'group'; group: ActionGroup } | { kind: 'reply'; msg: DisplayMessage };

export type ChatItem =
  | { kind: 'user' | 'system' | 'summary' | 'custom'; msg: DisplayMessage }
  | { kind: 'agent'; header: TurnHeader | null; parts: AgentPart[] };

export interface TurnHeader {
  provider?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
}

interface PendingMove {
  kind: ActionKind;
  name: string;
  thinking?: string;
  args?: string;
  result?: string;
  isError?: boolean;
  text?: string;
}

function groupDoneLabel(g: ActionGroup): string {
  const n = g.bubbles.length;
  if (n === 1 && g.bubbles[0].kind === 'compaction' && g.bubbles[0].status === 'fail') {
    return 'Compaction failed';
  }
  return `${n} action${n === 1 ? '' : 's'} done`;
}

function subClass(b: ActionBubble): string {
  if (b.status === 'fail') return 'chat-ab-sub--fail';
  if ((b.kind === 'tool' || b.kind === 'compaction') && b.status === 'ok') return 'chat-ab-sub--ok';
  return '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMsgTime(ts: number): string {
  const d = new Date(ts);
  const hhmm = fmtTime(ts);
  return d.toDateString() === new Date().toDateString()
    ? hhmm
    : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hhmm}`;
}

function ensureHeader(header: TurnHeader, m: DisplayMessage) {
  if (!header.provider && m.provider) header.provider = m.provider;
  if (!header.model && m.model) header.model = m.model;
  if (!header.thinkingLevel && m.thinkingLevel) header.thinkingLevel = m.thinkingLevel;
}

function agentSepLabel(h: TurnHeader): string {
  const id = [h.provider, h.model, h.thinkingLevel && h.thinkingLevel !== 'off' ? h.thinkingLevel : '']
    .filter(Boolean)
    .join('/');
  return `pi · ${id}`;
}

function userSepLabel(m: DisplayMessage): string {
  return `User · ${fmtMsgTime(m.ts)}`;
}

function sepLabel(item: ChatItem): string {
  if (item.kind === 'user') return userSepLabel(item.msg);
  if (item.kind === 'agent' && item.header) return agentSepLabel(item.header);
  return '';
}

function rowKey(item: ChatItem): string {
  if (item.kind === 'agent') {
    const first = item.parts[0];
    return first.kind === 'group' ? first.group.id : first.msg.id;
  }
  return item.msg.id;
}

function jumpToSep(e: MouseEvent) {
  const el = listEl.value;
  const sep = e.currentTarget as HTMLElement;
  if (!el || !sep) return;
  const row = sep.nextElementSibling as HTMLElement | null;
  if (!row) return;
  const { max } = posInfo(el);
  const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
  const target =
    el.scrollTop +
    (row.getBoundingClientRect().top - el.getBoundingClientRect().top) -
    padTop -
    sep.offsetHeight;
  el.scrollTop = clampScroll(max, target);
  sepJumpAt = performance.now();
}

function fmtSec(ms: number): string {
  if (ms <= 0) return '';
  const s = ms / 1000;
  if (s < 1) return '<1s';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

const items = computed<ChatItem[]>(() => {
  const msgs = session.value?.messages ?? [];
  const n = msgs.length;
  const out: ChatItem[] = [];
  const work: { src: number; mv: PendingMove }[] = [];
  let workId = '';
  const parts: AgentPart[] = [];
  let header: TurnHeader = {};

  const endTurn = () => {
    if (parts.length) {
      out.push({ kind: 'agent', header, parts: [...parts] });
      parts.length = 0;
      header = {};
    }
  };

  const flush = (endTs: number | null, wip: boolean) => {
    if (work.length === 0) return;
    const startTs = msgs[work[0].src].ts;
    const end = endTs ?? msgs[work[work.length - 1].src].ts;
    const group = new ActionGroup(workId, startTs);
    group.wip = wip;
    group.durMs = Math.max(0, end - startTs);
    work.forEach(({ src, mv }, i) => {
      const live = wip && i === work.length - 1;
      const b = new ActionBubble(mv.kind, `${workId}:${i}`, mv.name, msgs[src].ts);
      b.live = live;
      b.durMs = Math.max(0, (msgs[src + 1]?.ts ?? end) - msgs[src].ts);
      if (mv.kind === 'thinking') {
        b.detail = mv.thinking ?? '';
        b.status = live ? 'pending' : 'ok';
      } else if (mv.kind === 'bash') {
        b.detail = mv.text ?? '';
        b.status = mv.text ? 'ok' : 'pending';
      } else {
        b.args = mv.args;
        b.detail = mv.result ?? '';
        b.isError = !!mv.isError;
        b.status = mv.isError ? 'fail' : mv.result !== undefined ? 'ok' : 'pending';
      }
      group.bubbles.push(b);
    });
    parts.push({ kind: 'group', group });
    work.length = 0;
    workId = '';
  };

  const addMove = (
    src: number,
    msgId: string,
    kind: ActionKind,
    mv: Omit<PendingMove, 'kind' | 'name'> & { name?: string },
  ) => {
    if (!workId) workId = `work-${msgId}`;
    ensureHeader(header, msgs[src]);
    work.push({ src, mv: { ...mv, kind, name: actionName(kind, mv.name) } });
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user' || m.role === 'system' || m.role === 'summary') {
      flush(m.ts, false);
      endTurn();
      out.push({ kind: m.role, msg: m });
      continue;
    }
    if (m.role === 'bash') {
      addMove(i, m.id, 'bash', { text: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      let added = false;
      if (m.thinking) {
        addMove(i, m.id, 'thinking', { thinking: m.thinking });
        added = true;
      }
      for (const tc of m.toolCalls ?? []) {
        addMove(i, m.id, 'tool', { name: tc.name, args: tc.args, result: tc.result, isError: tc.isError });
        added = true;
      }
      if (m.text.trim() || m.error || m.stopReason === 'error' || m.stopReason === 'aborted') {
        flush(added ? (msgs[i + 1]?.ts ?? m.ts) : m.ts, false);
        ensureHeader(header, m);
        parts.push({ kind: 'reply', msg: m });
      }
      continue;
    }
    flush(m.ts, false);
    endTurn();
    out.push({ kind: 'custom', msg: m });
  }
  flush(null, session.value?.status === 'running');
  endTurn();

  const s = session.value;
  if (s && (s.compacting || s.compactResult === 'failed')) {
    const started = s.compactStartedAt || Date.now();
    const group = new ActionGroup('compact', started);
    const b = new ActionBubble('compaction', 'compact:0', 'Compaction', started);
    if (s.compacting) {
      group.wip = true;
      b.live = true;
      b.status = 'pending';
    } else {
      b.status = 'fail';
      b.isError = true;
      b.durMs = Math.max(0, (s.compactEndedAt || started) - started);
      b.detail = s.compactError || '';
    }
    group.bubbles.push(b);
    out.push({ kind: 'agent', header: null, parts: [{ kind: 'group', group }] });
  }
  return out;
});

const now = ref(Date.now());
const dots = ref(1);
let nowTimer: number | null = null;
watch(
  () => {
    const last = items.value[items.value.length - 1];
    return last?.kind === 'agent' && last.parts.some((p) => p.kind === 'group' && p.group.wip);
  },
  (active) => {
    if (active && nowTimer === null) {
      nowTimer = window.setInterval(() => {
        now.value = Date.now();
        dots.value = (dots.value % 3) + 1;
      }, 300);
    } else if (!active && nowTimer !== null) {
      window.clearInterval(nowTimer);
      nowTimer = null;
    }
  },
  { immediate: true },
);

function resetCompactOpen() {
  unsetOpenGroup(props.sessionId, 'compact');
  unsetOpenGroup(props.sessionId, 'compact:0');
}
watch(
  () => session.value?.compactResult,
  (res) => {
    if (!res) return;
    if (res === 'done') {
      if (session.value) session.value.compactResult = null;
      resetCompactOpen();
    } else {
      const sid = props.sessionId;
      flash.value = { ...flash.value, compact: 'fail' };
      setOpenGroup(sid, 'compact', true);
      setOpenGroup(sid, 'compact:0', true);
      window.setTimeout(() => {
        if (props.sessionId !== sid) return;
        const next = { ...flash.value };
        delete next.compact;
        flash.value = next;
        if (session.value?.compactResult === 'failed') {
          session.value.compactResult = null;
          resetCompactOpen();
        }
      }, 1500);
    }
  },
);

const flash = ref<Record<string, 'ok' | 'fail'>>({});
const prevBubbleStatus = new Map<string, ActionStatus>();
watch(items, (list) => {
  for (const item of list) {
    if (item.kind !== 'agent') continue;
    for (const part of item.parts) {
      if (part.kind !== 'group') continue;
      for (const b of part.group.bubbles) {
        const prev = prevBubbleStatus.get(b.key);
        if (prev === 'pending' && b.status !== 'pending') {
          const kind = b.status === 'ok' ? 'ok' : 'fail';
          const gid = part.group.id;
          const sid = props.sessionId;
          flash.value = { ...flash.value, [gid]: kind };
          window.setTimeout(() => {
            if (props.sessionId !== sid) return;
            if (flash.value[gid]) {
              const next = { ...flash.value };
              delete next[gid];
              flash.value = next;
            }
          }, 1400);
        }
        prevBubbleStatus.set(b.key, b.status);
      }
    }
  }
});

const commandCatalog = ref<SlashCommandInfo[]>([]);
const completionOpen = ref(false);
const completionIndex = ref(0);
const completionItems = ref<SlashCommandInfo[]>([]);
let catalogLoaded = false;

const LOCAL_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'wait',
    description: 'Queue this message — it runs after the current turn finishes, instead of interrupting it',
    argumentHint: '<message>',
    available: true,
  },
];

function ensureCatalog() {
  if (catalogLoaded) return;
  catalogLoaded = true;
  void allSlashCommands().then((cmds) => {
    commandCatalog.value = [...LOCAL_COMMANDS, ...cmds];
    updateCompletions();
  });
}

function isKnownCommand(name: string): boolean {
  return commandCatalog.value.some((c) => c.name === name);
}

function updateCompletions() {
  const t = input.value;
  if (!t.startsWith('/') || t.startsWith('//')) {
    completionOpen.value = false;
    return;
  }
  const sp = t.indexOf(' ');
  const prefix = (sp < 0 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  const items = commandCatalog.value.filter((c) => c.name.startsWith(prefix));
  completionItems.value = items;
  completionIndex.value = 0;
  completionOpen.value = items.length > 0;
}

watch(input, () => {
  ensureCatalog();
  updateCompletions();
});

function completeWith(cmd: SlashCommandInfo) {
  input.value = `/${cmd.name} `;
  completionOpen.value = false;
  nextTick(() => inputEl.value?.focus());
}

function moveCompletion(delta: number) {
  const n = completionItems.value.length;
  if (n === 0) return;
  completionIndex.value = (completionIndex.value + delta + n) % n;
}

const picker = ref<SlashPicker | null>(null);
const pickerIndex = ref(0);

const review = ref<{ images: MessageImage[]; start: number } | null>(null);

const composerBlock = computed(() => {
  if (!session.value) return 'Session not found — this window can no longer send messages.';
  return '';
});

const windowError = computed(() => {
  const own = sessionErrorOf(props.sessionId);
  if (own) return own;
  return store.activeChatId === props.sessionId ? store.lastError : '';
});
function dismissError() {
  clearSessionError(props.sessionId);
  if (store.activeChatId === props.sessionId) store.clearLastError();
}
function openReview(images: MessageImage[], start: number) {
  review.value = { images, start };
}

async function handleSlashResult(r: SlashResult) {
  switch (r.kind) {
    case 'none':
      break;
    case 'notice':
      store.appendLocalMessage(props.sessionId, { text: r.text });
      break;
    case 'error':
      store.appendLocalMessage(props.sessionId, { text: r.text, isError: true });
      break;
    case 'clipboard':
      try {
        await navigator.clipboard.writeText(r.text);
        store.appendLocalMessage(props.sessionId, { text: 'Copied last agent message to clipboard.' });
      } catch {
        store.appendLocalMessage(props.sessionId, {
          text: `Clipboard unavailable — last agent message:\n\n${r.text}`,
        });
      }
      break;
    case 'download': {
      const blob = new Blob([r.content], { type: r.mime || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename || 'export';
      a.click();
      URL.revokeObjectURL(url);
      store.appendLocalMessage(props.sessionId, { text: `Exported session — downloaded ${r.filename}.` });
      break;
    }
    case 'picker':
      picker.value = r;
      pickerIndex.value = 0;
      break;
  }
}

function runCommand(parsed: ParsedSlash) {
  store.clearSessionError(props.sessionId);
  input.value = '';
  completionOpen.value = false;
  void runCommandAsync(parsed);
}

function compactContext() {
  const s = session.value;
  if (!s || s.compacting) return;
  const parsed = parseSlash('/compact');
  if (!parsed) return;
  store.clearSessionError(props.sessionId);
  void runCommandAsync(parsed);
}

async function runCommandAsync(parsed: ParsedSlash) {
  const r = await runSlash(props.sessionId, parsed);
  await handleSlashResult(r);
  pinToBottom();
}

async function onPickerSelect(id: string) {
  const p = picker.value;
  if (!p) return;
  picker.value = null;
  const r = await p.onSelect(id);
  if (r) await handleSlashResult(r);
}

const MOBILE_INPUT_MAX_PX = 120;
const isMobile = ref(window.innerWidth < 500);

function autoGrowMobileInput() {
  const el = inputEl.value;
  if (!el || !isMobile.value) return;
  const borders = el.offsetHeight - el.clientHeight;
  const contentH = el.scrollHeight + borders;
  el.style.height = 'auto';
  el.style.height = `${Math.min(contentH, MOBILE_INPUT_MAX_PX)}px`;
  el.style.overflowY = contentH > MOBILE_INPUT_MAX_PX ? 'auto' : 'hidden';
}

function resetMobileInputHeight() {
  const el = inputEl.value;
  if (!el) return;
  if (!isMobile.value && manualHeight.value !== null) return;
  el.style.height = '';
  el.style.overflowY = '';
}

function onViewportResize() {
  isMobile.value = window.innerWidth < 500;
  if (isMobile.value) autoGrowMobileInput();
  else resetMobileInputHeight();
}

watch(input, () => {
  nextTick(() => {
    if (input.value) autoGrowMobileInput();
    else resetMobileInputHeight();
  });
});

function send() {
  const text = input.value.trim();
  const imgs = attachments.value.map((a) => ({ data: a.data, mimeType: a.mimeType }));
  if ((!text && !imgs.length) || !session.value) return;
  const parsed = text ? parseSlash(text) : null;
  if (parsed && parsed.command === 'wait') {
    const rest = parsed.args.trim();
    if (!rest && !imgs.length) {
      store.appendLocalMessage(props.sessionId, {
        text: 'Usage: /wait <message> — the message queues and runs after the current turn finishes, instead of interrupting it.',
      });
      input.value = '';
      completionOpen.value = false;
      inputEl.value?.focus();
      return;
    }
    store.clearSessionError(props.sessionId);
    void store.sendMessage(props.sessionId, rest, { wait: true, images: imgs });
    input.value = '';
    attachments.value = [];
    pinToBottom();
    return;
  }
  if (parsed) {
    void runCommand(parsed);
    return;
  }
  store.clearSessionError(props.sessionId);
  void store.sendMessage(props.sessionId, text, { images: imgs });
  input.value = '';
  attachments.value = [];
  pinToBottom();
}

const attachments = computed({
  get: () => attachmentsOf(props.sessionId),
  set: (v: ChatAttachment[]) => setAttachments(props.sessionId, v),
});
const fileInput = ref<HTMLInputElement | null>(null);

function pickImages() {
  fileInput.value?.click();
}

async function onFilesChosen(e: Event) {
  const el = e.target as HTMLInputElement | null;
  const files = el?.files ? Array.from(el.files) : [];
  if (el) el.value = '';
  if (files.length) store.noteChatInteraction(props.sessionId);
  for (const f of files) {
    if (attachments.value.length >= 4) {
      setSessionError(props.sessionId, 'At most 4 images per message.');
      return;
    }
    try {
      const im = await processImageFile(f);
      attachments.value.push({ ...im, url: dataUrlOf(im) });
    } catch (err) {
      setSessionError(
        props.sessionId,
        `Could not attach ${f.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function removeAttachment(i: number) {
  attachments.value.splice(i, 1);
  store.noteChatInteraction(props.sessionId);
}

let shiftDown = false;
let lastShiftDown = 0;
const SHIFT_TRUST_WINDOW = 3000;

function onWindowShiftKey(e: KeyboardEvent) {
  if (e.key !== 'Shift') return;
  if (e.type === 'keydown') {
    shiftDown = true;
    lastShiftDown = performance.now();
  } else {
    shiftDown = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (picker.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pickerIndex.value = (pickerIndex.value + 1) % picker.value.items.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      pickerIndex.value = (pickerIndex.value - 1 + picker.value.items.length) % picker.value.items.length;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void onPickerSelect(picker.value.items[pickerIndex.value].id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      picker.value = null;
      return;
    }
    return;
  }

  if (completionOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCompletion(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCompletion(-1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      completionOpen.value = false;
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const items = completionItems.value;
      if (items[completionIndex.value]) completeWith(items[completionIndex.value]);
      return;
    }
  }

  const realShift = e.shiftKey && (shiftDown || performance.now() - lastShiftDown < SHIFT_TRUST_WINDOW);
  const sendPressed =
    e.key === 'Enter' && !e.isComposing && (store.prefs.sendKey === 'enter' ? !realShift : realShift);
  if (sendPressed) {
    e.preventDefault();
    const parsed = parseSlash(input.value);
    if (
      completionOpen.value &&
      parsed &&
      !isKnownCommand(parsed.command) &&
      completionItems.value.length > 0
    ) {
      completeWith(completionItems.value[completionIndex.value]);
      return;
    }
    send();
  }
}

function onComposerInput() {
  store.noteChatInteraction(props.sessionId);
}

function pinToBottom() {
  setSticky(true);
  nextTick(scrollToBottom);
  inputEl.value?.focus();
}

function scrollToBottomNow() {
  setSticky(true);
  scrollToBottom();
}

const manualHeight = computed({
  get: () => store.windowUiOf(props.sessionId)?.composerHeight ?? null,
  set: (v: number | null) => store.setComposerHeight(props.sessionId, v),
});
const MIN_INPUT_EM = 1.4 + 2 * 0.44 + 2 / 16;
const MAX_INPUT_EM = 320 / 16;

let resizeCleanup: (() => void) | null = null;

function startResize(e: MouseEvent) {
  if (isMobile.value) return;
  e.preventDefault();
  const startY = e.clientY;
  const startH = manualHeight.value ?? inputEl.value?.offsetHeight ?? 80;
  const el = inputEl.value;
  const fs = parseFloat(el ? getComputedStyle(el).fontSize : '') || 16;
  const minH = fs * MIN_INPUT_EM;
  const maxH = fs * MAX_INPUT_EM;
  const onMove = (ev: MouseEvent) => {
    manualHeight.value = Math.min(maxH, Math.max(minH, startH + (startY - ev.clientY)));
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    resizeCleanup = null;
  };
  resizeCleanup = onUp;
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function resetResize() {
  manualHeight.value = null;
}

onMounted(() => {
  now.value = Date.now();
  const el = listEl.value;
  const st = chatScrollOf(props.sessionId);
  if (st.sticky) {
    scrollToBottom();
  } else if (el && el.scrollHeight > el.clientHeight) {
    nextTick(() => restoreScroll(props.sessionId));
  }
  inputEl.value?.focus();
  window.addEventListener('resize', onViewportResize);
  window.addEventListener('keydown', onWindowShiftKey, true);
  window.addEventListener('keyup', onWindowShiftKey, true);
  el?.addEventListener('touchstart', onTouchStart);
  el?.addEventListener('touchend', onTouchEnd);
  el?.addEventListener('touchcancel', onTouchEnd);
  if (isMobile.value) nextTick(autoGrowMobileInput);
  if (el) {
    let firstObs = true;
    listObserver = new ResizeObserver(() => {
      if (firstObs) {
        firstObs = false;
        return;
      }
      if (sticky()) scrollToBottom();
    });
    listObserver.observe(el);
  }
});

onUnmounted(() => {
  const el = listEl.value;
  if (el) captureScroll(el, chatScrollOf(props.sessionId));
  window.removeEventListener('resize', onViewportResize);
  window.removeEventListener('keydown', onWindowShiftKey, true);
  window.removeEventListener('keyup', onWindowShiftKey, true);
  el?.removeEventListener('touchstart', onTouchStart);
  el?.removeEventListener('touchend', onTouchEnd);
  el?.removeEventListener('touchcancel', onTouchEnd);
  resizeCleanup?.();
  listObserver?.disconnect();
});

let listObserver: ResizeObserver | null = null;

function captureScroll(el: HTMLElement, mem: ReturnType<typeof chatScrollOf>) {
  const { max, st, distFromTop } = posInfo(el);
  mem.top = st;
  mem.sticky = distFromTop > max - STICKY_ZONE;
}

function restoreScroll(sessionId: string) {
  nextTick(() => {
    const el = listEl.value;
    if (!el || props.sessionId !== sessionId) return;
    const st = chatScrollOf(sessionId);
    const { max } = posInfo(el);
    if (st.sticky) {
      scrollToBottom();
    } else {
      el.scrollTop = clampScroll(max, st.top);
      captureScroll(el, st);
    }
  });
}

watch(
  () => props.sessionId,
  (newId, oldId) => {
    const el = listEl.value;
    if (el && oldId) {
      captureScroll(el, chatScrollOf(oldId));
    }
    if (newId) {
      review.value = null;
      picker.value = null;
      flash.value = {};
      prevBubbleStatus.clear();
      restoreScroll(newId);
    }
  },
);
</script>

<template>
  <div class="chat-window">
    <div ref="listEl" class="chat-messages" @scroll="onScroll">
      <div class="chat-flow">
        <div v-if="!session" class="chat-empty">Session not found.</div>
        <div v-else-if="session.messages.length === 0" class="chat-empty">
          No messages yet — say hello. Type <code>/</code> for slash commands.
        </div>
        <template v-else>
        <div
          class="chat-load-older"
          :class="{
            'chat-load-older--loading': session.loadingOlder,
            'chat-load-older--done': !session.hasMoreOlder && !session.loadingOlder,
          }"
          @click="session.hasMoreOlder && !session.loadingOlder && loadOlder()"
        >
          <span class="chat-load-older-icon">
            <SvgIcon v-if="!session.loadingOlder && session.hasMoreOlder" name="↑" />
            <span v-else-if="session.loadingOlder" class="chat-load-older-spinner" />
            <span v-else class="chat-load-older-dot" />
          </span>
          <span v-if="session.loadingOlder">older messages…</span>
          <span v-else-if="session.hasMoreOlder">older messages</span>
          <span v-else>beginning of conversation</span>
        </div>
        <div v-for="item in items" :key="rowKey(item)" class="chat-group">
          <div
            v-if="item.kind === 'user' || (item.kind === 'agent' && item.header)"
            class="chat-sep"
            title="Jump to the start of this message"
            @click="jumpToSep"
          >
            <span class="chat-sep-line" /><span class="chat-sep-text">{{ sepLabel(item) }}</span><span class="chat-sep-line" />
          </div>
          <div
            class="chat-msg"
            :data-msg-id="rowKey(item)"
            :class="[
              item.kind === 'user' ? '' : 'chat-msg--' + item.kind,
              { 'chat-msg--error': item.kind === 'system' && item.msg.isError },
            ]"
          >
          <template v-if="item.kind === 'agent'">
            <div
              v-for="part in item.parts"
              :key="part.kind === 'group' ? part.group.id : part.msg.id"
              :data-part-id="part.kind === 'group' ? part.group.id : part.msg.id"
              class="chat-agent-part"
            >
              <div
                v-if="part.kind === 'group'"
                class="chat-work"
                :class="[
                  flash[part.group.id] === 'ok' ? 'chat-work--flash-ok' : '',
                  flash[part.group.id] === 'fail' ? 'chat-work--flash-fail' : '',
                  part.group.id === 'compact' && flash.compact === 'fail' ? 'chat-work--flash-fail' : '',
                  part.group.id === 'compact' ? 'chat-compacting' : '',
                  part.group.id === 'compact' && !part.group.wip ? 'chat-compacting--failed' : '',
                ]"
              >
                <div class="chat-work-head" @click="toggle(part.group.id)">
                  <span class="chat-work-toggle"><SvgIcon :name="open[part.group.id] ? '▾' : '▸'" /></span>
                  <template v-if="part.group.wip && part.group.latest">
                    <span class="chat-ab-name">{{ part.group.latest.name }}</span>
                    <span class="chat-ab-dots">{{ '.'.repeat(dots) }}</span>
                    <span class="chat-ab-content">{{ part.group.latest.preview() }}</span>
                    <span class="chat-ab-time">{{ fmtSec(now - part.group.latest.startTs) }}</span>
                  </template>
                  <template v-else>
                    <span class="chat-ab-name">{{ groupDoneLabel(part.group) }}</span>
                    <span class="chat-ab-time">{{ fmtSec(part.group.durMs) }}</span>
                  </template>
                </div>
                <div v-if="open[part.group.id]" class="chat-work-body">
                  <div
                    v-for="b in part.group.bubbles"
                    :key="b.key"
                    class="chat-ab-sub"
                    :class="subClass(b)"
                  >
                    <div class="chat-ab-sub-head" @click="toggle(b.key)">
                      <span class="chat-ab-sub-toggle"><SvgIcon :name="open[b.key] ? '▾' : '▸'" /></span>
                      <span class="chat-ab-sub-name">{{ b.name }}</span>
                      <span class="chat-ab-sub-time">{{ b.live ? fmtSec(now - b.startTs) : fmtSec(b.durMs) }}</span>
                    </div>
                    <div v-if="open[b.key]" class="chat-ab-sub-details">
                      <pre v-if="b.kind === 'thinking'" class="chat-ab-code">{{ b.detail }}</pre>
                      <template v-else-if="b.kind === 'tool' || b.kind === 'compaction'">
                        <pre v-if="b.args" class="chat-ab-code">{{ b.args }}</pre>
                        <div v-if="b.status !== 'pending'" class="chat-ab-result" :class="{ 'chat-ab-result--error': b.isError }">
                          <pre class="chat-ab-code chat-ab-result-body">{{ b.detail }}</pre>
                        </div>
                      </template>
                      <pre v-else class="chat-ab-code chat-ab-bash">{{ b.detail }}</pre>
                    </div>
                  </div>
                </div>
              </div>

              <template v-else>
                <div v-if="renderMd" class="chat-msg-md" v-html="md(part.msg)" />
                <template v-else>{{ part.msg.text }}</template>
                <div v-if="part.msg.error" class="chat-aborted chat-aborted--error"><SvgIcon name="⚠" /> {{ part.msg.error }}</div>
              </template>
            </div>
          </template>

          <template v-else-if="item.kind === 'user'">
            <MessageImages
              v-if="item.msg.images?.length"
              :images="item.msg.images"
              @open="openReview(item.msg.images, $event)"
            />
            <div v-if="item.msg.text" class="chat-user-bubble">
              <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
              <template v-else>{{ item.msg.text }}</template>
            </div>
            <div v-if="item.msg.sendFailed" class="chat-resend" title="The backend did not accept this message — send it again">
              <span class="chat-resend-mark"><SvgIcon name="⚠" /></span> not sent
              <button class="chat-resend-btn" @click="store.resendMessage(props.sessionId, item.msg.id)"><SvgIcon name="↻" /> Resend</button>
            </div>
          </template>

          <template v-else-if="item.kind === 'custom'">
            <div class="chat-msg-meta">{{ roleLabel(item.msg) }} · {{ fmtMsgTime(item.msg.ts) }}</div>
            <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
            <template v-else>{{ item.msg.text }}</template>
            <div v-if="item.msg.sendFailed" class="chat-resend" title="The backend did not accept this message — send it again">
              <span class="chat-resend-mark"><SvgIcon name="⚠" /></span> not sent
              <button class="chat-resend-btn" @click="store.resendMessage(props.sessionId, item.msg.id)"><SvgIcon name="↻" /> Resend</button>
            </div>
            <div class="chat-msg-time">{{ fmtTime(item.msg.ts) }}</div>
          </template>

          <pre v-else-if="item.kind === 'system'" class="chat-system">{{ item.msg.text }}</pre>

          <div
            v-else-if="item.kind === 'summary'"
            class="chat-work chat-summary-ab"
            @click="toggle('sum-' + item.msg.id)"
          >
            <div class="chat-work-head">
              <span class="chat-work-toggle"><SvgIcon :name="open['sum-' + item.msg.id] ? '▾' : '▸'" /></span>
              <span class="chat-ab-name">Compaction summary</span>
              <span class="chat-ab-content chat-summary-ab-preview">{{ summaryPreview(item.msg.text) }}</span>
            </div>
            <div v-if="open['sum-' + item.msg.id]" class="chat-work-body">
              <pre class="chat-ab-code chat-summary-ab-body">{{ item.msg.text }}</pre>
            </div>
          </div>

        </div>
        </div>
      </template>
      </div>
    </div>

    <div class="chat-composer">
      <div
        class="chat-composer-handle"
        title="Drag to resize the input · double-click to reset"
        @mousedown="startResize"
        @dblclick="resetResize"
      ><span class="chat-composer-grip" /></div>
      <div
        v-if="windowError"
        class="chat-banner chat-banner--error"
        @click="dismissError"
      >
        <SvgIcon name="⚠" /> {{ windowError }} (click to dismiss)
      </div>
        <div v-if="completionOpen && !picker" class="chat-completions">
          <div
            v-for="(c, i) in completionItems"
            :key="c.name"
            class="chat-completion"
            :class="{ 'chat-completion--selected': i === completionIndex }"
            @mouseenter="completionIndex = i"
            @click="completeWith(c)"
          >
            <span class="chat-completion-name">/{{ c.name }}</span>
            <span class="chat-completion-hint">{{ c.argumentHint ?? '' }}</span>
            <span class="chat-completion-desc">{{ c.description }}</span>
          </div>
        </div>

        <div v-if="attachments.length" class="chat-attach-row">
          <div v-for="(a, i) in attachments" :key="i" class="chat-attach-chip">
            <img :src="a.url" class="chat-attach-thumb" alt="attachment" />
            <button
              class="chat-attach-remove"
              :title="'Remove attachment ' + (i + 1)"
              :disabled="!!composerBlock"
              @click="removeAttachment(i)"
            ><SvgIcon name="✕" /></button>
          </div>
        </div>

        <textarea
          ref="inputEl"
          v-model="input"
          class="chat-input"
          rows="1"
          :disabled="!!composerBlock"
          :style="!isMobile && manualHeight !== null ? { height: manualHeight + 'px', maxHeight: manualHeight + 'px' } : {}"
          @keydown="onKeydown"
          @input="onComposerInput"
        />
        <div class="chat-composer-actions">
          <button
            v-if="contextDisplay"
            class="chat-context"
            :class="contextClass"
            :title="contextTitle"
            :disabled="!!composerBlock || session?.compacting"
            @click="compactContext"
          >{{ contextDisplay }}</button>
          <button
            class="chat-scroll-btn"
            title="Scroll to bottom"
            :disabled="!!composerBlock"
            @click="scrollToBottomNow"
          ><SvgIcon name="↓" /></button>
          <button
            class="chat-image-btn"
            :title="attachments.length ? `Attach another image (${attachments.length}/4)` : 'Attach an image to send with your message'"
            :disabled="!!composerBlock || attachments.length >= 4"
            @click="pickImages"
          ><SvgIcon name="🖼" /></button>
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            class="chat-image-input"
            @change="onFilesChosen"
          />
          <button
            class="chat-send-btn"
            :disabled="!!composerBlock || (!input.trim() && !attachments.length)"
            @click="send"
          >Send</button>
        </div>

        <div v-if="composerBlock" class="chat-composer-block" role="alert">
          <div class="chat-composer-block-banner">
            <SvgIcon name="⚠" /> {{ composerBlock }}
          </div>
        </div>
    </div>

    <ImageReview
      v-if="review"
      :images="review.images"
      :start="review.start"
      @close="review = null"
    />

    <div v-if="picker" class="chat-picker-backdrop" @click.self="picker = null">
      <div class="chat-picker">
        <div class="chat-picker-title">{{ picker.title }}</div>
        <div class="chat-picker-list">
          <div
            v-for="(item, i) in picker.items"
            :key="item.id"
            class="chat-picker-item"
            :class="{ 'chat-picker-item--selected': i === pickerIndex }"
            @mouseenter="pickerIndex = i"
            @click="onPickerSelect(item.id)"
          >
            <span class="chat-picker-label">{{ item.label }}</span>
            <span v-if="item.detail" class="chat-picker-detail">{{ item.detail }}</span>
          </div>
          <div v-if="picker.items.length === 0" class="chat-picker-empty">Nothing to pick from.</div>
        </div>
        <div class="chat-picker-footer">↑↓ navigate · Enter pick · Esc cancel</div>
      </div>
    </div>
  </div>
</template>
