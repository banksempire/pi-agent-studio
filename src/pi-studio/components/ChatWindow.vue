<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  allSlashCommands,
  type ParsedSlash,
  parseSlash,
  runSlash,
  type SlashCommandInfo,
  type SlashPicker,
  type SlashResult,
} from '../slash/commands';
import { type ChatSession, type DisplayMessage, fmtTime, useChatStore } from '../store/chat';

const props = defineProps<{ sessionId: string }>();
const store = useChatStore();

const session = computed<ChatSession | undefined>(() => store.findSession(props.sessionId));
/** Global preference (right panel): render message text as markdown. */
const renderMd = computed(() => store.prefs.renderMarkdown);

/**
 * Boxes are collapsed by default; `open` holds the expanded ones — one map
 * for all three kinds, ids namespaced: work groups 'work-…', their
 * sub-bubbles '…:…', compaction summaries 'sum-…'.
 */
const open = ref<Record<string, boolean>>({});
function toggle(id: string) {
  open.value = { ...open.value, [id]: !open.value[id] };
}

/**
 * Markdown → sanitized HTML (agent output may echo untrusted content).
 * Memoized per message object: while the agent streams, only the mutated
 * tail message re-parses — history stays cache-hit (avoids O(n²) re-parsing).
 */
const mdCache = new WeakMap<DisplayMessage, { text: string; html: string }>();
function md(m: DisplayMessage): string {
  const hit = mdCache.get(m);
  if (hit && hit.text === m.text) return hit.html;
  const html = m.text ? DOMPurify.sanitize(marked.parse(m.text) as string) : '';
  mdCache.set(m, { text: m.text, html });
  return html;
}

/**
 * Collapsed-head preview of a compaction summary, capped the same way the
 * tool bubbles cap their preview: rendering the raw summary in the head span
 * makes the browser lay out the FULL text (tens of KB) as a single nowrap
 * line on every render (~160k px wide). The expanded body shows it all.
 */
function summaryPreview(text: string): string {
  const t = text.trim();
  const capped = t.length > 300 ? t.slice(0, 300) : t;
  const flat = capped.replace(/\s+/g, ' ');
  return (t.length > 300 ? `${flat}…` : flat) || '…';
}
/** Composer text lives in the store PER SESSION: the framework reuses the
 *  same ChatWindow instance across tab switches (only the sessionId prop
 *  changes), so a local ref would leak one window's text into the next.
 *  The getter/setter keeps every existing input.value read/write working. */
const input = computed({
  get: () => store.draftOf(props.sessionId),
  set: (v: string) => store.setDraft(props.sessionId, v),
});
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

/**
 * Context gauge (pi TUI footer parity: "10.0%/1M" — percent of the model's
 * context window in use; "?/…" when unknown right after a compaction).
 */
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
  // The gauge doubles as the click-to-compact affordance (unless a
  // compaction is already running — then it is disabled).
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

/** Auto-scroll only while the user is already at the bottom. */
let sticky = true;

function scrollToBottom() {
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  // Re-anchor on genuine user scrolls only: scroll events fired while a
  // resize is in flight carry a half-applied state (old scrollTop + new
  // height) that would corrupt the anchor.
  if (el.clientHeight === prevListH) anchorBottom = el.scrollTop + el.clientHeight;
  sticky = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  // Scroll-up pagination: near the top → load older messages.
  if (el.scrollTop < 80) void loadOlder();
}

/** Load the previous page and keep the viewport anchored. */
async function loadOlder() {
  const s = session.value;
  const el = listEl.value;
  if (!s || !el || s.loadingOlder || !s.hasMoreOlder) return;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  await store.loadOlder(s.id);
  await nextTick();
  el.scrollTop = el.scrollHeight - prevHeight + prevTop;
}

// Re-run on new messages and on streaming text/thinking growth. A cheap
// key (count + last message identity/lengths + toolCalls digest) is enough:
// messages are append-only except the live tail being streamed, so a change
// always shows up in the last message or in the count. The toolCalls digest
// is required because tool_start / tool_partial / tool_result MUTATE the
// tail message's toolCalls in place (id/text/thinking unchanged) — without
// it the scroll never re-anchors while a tool runs. The DOM must be updated
// before measuring, so scroll runs after the render flush.
const keepBottom = () => {
  if (sticky) nextTick(scrollToBottom);
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
  // The /compact box appears/disappears without messages changing — the
  // compacting flag is part of the key so it still re-anchors the scroll.
  return key + (s.compacting ? ':c' : '');
}, keepBottom);

const lastMessage = computed<DisplayMessage | undefined>(() => {
  const msgs = session.value?.messages ?? [];
  return msgs[msgs.length - 1];
});

/** The agent is producing the tail message right now. */
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

// ── ActionBubble work groups ─────────────────────────────────────────────
// Consecutive "unofficial" replies (thinking blocks + tool calls) between a
// user message and the final text reply collapse into ONE ActionGroup box:
//   - group in progress: header shows the LATEST bubble: name + dots + live
//     content preview + elapsed (the bubble's own format)
//   - group finished:    "n actions done" + total elapsed — click to expand
//     the stacked sub-bubbles; a sub-bubble click reveals its detail.

import { ActionBubble, ActionGroup, type ActionKind, type ActionStatus, actionName } from '../actionBubble';

export type AgentPart = { kind: 'group'; group: ActionGroup } | { kind: 'reply'; msg: DisplayMessage };

export type ChatItem =
  | { kind: 'user' | 'system' | 'summary' | 'custom'; msg: DisplayMessage }
  /** One row per agent TURN: every work run + reply of the turn grouped
   *  together, so the separator's sticky pin spans the whole turn (a long
   *  multi-reply keeps the line at the top of the window). header: null for
   *  the /compact status box (no separator). */
  | { kind: 'agent'; header: TurnHeader | null; parts: AgentPart[] };

/** Identity shown in an agent turn's separator: pi · provider · model · level. */
export interface TurnHeader {
  provider?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
}

/** Intermediate move record before it becomes an ActionBubble (timing/status
 *  are only known when the run is flushed). */
interface PendingMove {
  kind: ActionKind;
  /** final display name (from actionName()) */
  name: string;
  thinking?: string;
  args?: string;
  result?: string;
  isError?: boolean;
  text?: string;
}

function groupDoneLabel(g: ActionGroup): string {
  const n = g.bubbles.length;
  // A failed compaction is a single failed bubble — say what happened,
  // not "1 action done".
  if (n === 1 && g.bubbles[0].kind === 'compaction' && g.bubbles[0].status === 'fail') {
    return 'Compaction failed';
  }
  return `${n} action${n === 1 ? '' : 's'} done`;
}

/** Sub-bubble rows are tinted by outcome: green on success, red on failure. */
function subClass(b: ActionBubble): string {
  if (b.status === 'fail') return 'chat-ab-sub--fail';
  if ((b.kind === 'tool' || b.kind === 'compaction') && b.status === 'ok') return 'chat-ab-sub--ok';
  return '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Chat timestamp: HH:MM today, "Mon D, HH:MM" for older messages. */
function fmtMsgTime(ts: number): string {
  const d = new Date(ts);
  const hhmm = fmtTime(ts);
  return d.toDateString() === new Date().toDateString()
    ? hhmm
    : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hhmm}`;
}

/** Turn identity from an assistant message. */
function ensureHeader(header: TurnHeader, m: DisplayMessage) {
  if (!header.provider && m.provider) header.provider = m.provider;
  if (!header.model && m.model) header.model = m.model;
  if (!header.thinkingLevel && m.thinkingLevel) header.thinkingLevel = m.thinkingLevel;
}

/** Agent-turn separator label: "pi · provider/model/level". */
function agentSepLabel(h: TurnHeader): string {
  const id = [h.provider, h.model, h.thinkingLevel && h.thinkingLevel !== 'off' ? h.thinkingLevel : '']
    .filter(Boolean)
    .join('/');
  return `pi · ${id}`;
}

/** User-message separator label: "User · time" (datetime on other days). */
function userSepLabel(m: DisplayMessage): string {
  return `User · ${fmtMsgTime(m.ts)}`;
}

/** Stable row key: user/system/summary/custom rows by message id; agent
 *  turns by their FIRST part (group or reply id) — fixed once the turn
 *  starts, so streaming parts never remount the row (open/flash state
 *  survives across recomputes). */
function rowKey(item: ChatItem): string {
  if (item.kind === 'agent') {
    const first = item.parts[0];
    return first.kind === 'group' ? first.group.id : first.msg.id;
  }
  return item.msg.id;
}

/** Clicking a pinned separator jumps to the start of that message (its row
 *  aligns with the list's content top, where the separator pins). */
function jumpToSep(e: MouseEvent) {
  const el = listEl.value;
  const row = (e.currentTarget as HTMLElement).closest('.chat-msg') as HTMLElement | null;
  if (!el || !row) return;
  const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
  const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - padTop;
  el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
}

/** Short duration: "<1s" / "12.3s" / "1m 30s". */ function fmtSec(ms: number): string {
  if (ms <= 0) return '';
  const s = ms / 1000;
  if (s < 1) return '<1s';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

/**
 * The conversation as render items: work runs collapse into one box each.
 *
 * Timing: a message is one agent step (thinking + tool call + maybe text)
 * starting at its ts. A move's duration is its step's duration — from this
 * message's ts to the NEXT message's ts (or the run end for the last step).
 * The trailing step of a WIP run (live) measures against the live clock.
 */
const items = computed<ChatItem[]>(() => {
  const msgs = session.value?.messages ?? [];
  const n = msgs.length;
  const out: ChatItem[] = [];
  const work: { src: number; mv: PendingMove }[] = [];
  let workId = '';
  /** The agent turn being accumulated: ALL of a turn's work runs + replies
   *  become ONE row (see ChatItem) so the separator pins across the whole
   *  turn — not just the first reply. */
  const parts: AgentPart[] = [];
  let header: TurnHeader = {};

  /** Close the current agent turn (if it has any content). */
  const endTurn = () => {
    if (parts.length) {
      out.push({ kind: 'agent', header, parts: [...parts] });
      parts.length = 0;
      header = {};
    }
  };

  /** endTs = ts of the message that follows the run (null = the run is the tail). */
  const flush = (endTs: number | null, wip: boolean) => {
    if (work.length === 0) return;
    const startTs = msgs[work[0].src].ts;
    const end = endTs ?? msgs[work[work.length - 1].src].ts;
    const group = new ActionGroup(workId, startTs);
    group.wip = wip;
    group.durMs = Math.max(0, end - startTs);
    work.forEach(({ src, mv }, i) => {
      // A bubble's duration spans its step: from this message's ts to the
      // NEXT message's ts (or the run end for the last step).
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

  /** Fill the turn's separator identity from any available source message. */
  const ensureTurnHeader = (m: DisplayMessage) => ensureHeader(header, m);

  const addMove = (
    src: number,
    msgId: string,
    kind: ActionKind,
    mv: Omit<PendingMove, 'kind' | 'name'> & { name?: string },
  ) => {
    if (!workId) workId = `work-${msgId}`;
    ensureTurnHeader(msgs[src]);
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
      if (m.text || m.error || m.stopReason === 'error' || m.stopReason === 'aborted') {
        // The reply (or LLM API error / abort — textless error messages must
        // surface too, like in the TUI) ends the work phase. If THIS message
        // also contributed moves, the run ends at the next message's step
        // boundary (this message's own ts would measure 0).
        flush(added ? (msgs[i + 1]?.ts ?? m.ts) : m.ts, false);
        ensureTurnHeader(m);
        parts.push({ kind: 'reply', msg: m });
      }
      continue;
    }
    flush(m.ts, false);
    endTurn();
    out.push({ kind: 'custom', msg: m });
  }
  // A trailing work run is still in progress while the agent is working.
  flush(null, session.value?.status === 'running');
  endTurn();

  // The /compact status rides the SAME work pipeline as the thinking/tool
  // bubbles: one compaction ActionBubble in its own ActionGroup, appended as
  // a regular work item (no separate kind — it IS a work group). WIP while
  // compacting; on failure the bubble flips to fail and the work-bubble
  // flash watch + auto-dismiss timer handle the rest.
  const s = session.value;
  if (s && (s.compacting || s.compactResult === 'failed')) {
    const started = s.compactStartedAt || Date.now();
    const group = new ActionGroup('compact', started);
    const b = new ActionBubble('compaction', 'compact:0', 'Compaction', started);
    if (s.compacting) {
      group.wip = true;
      b.live = true;
      b.status = 'pending';
      // No detail text: the running dots already signal in-progress, and the
      // name is "Compaction" — "Summarizing the conversation…" was redundant.
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

/** Live clock for WIP elapsed times + loading dots — ticks only while a work
 *  run is in progress. 300ms also drives the ". → …" dot animation. */
const now = ref(Date.now());
const dots = ref(1);
let nowTimer: number | null = null;
watch(
  () => {
    const last = items.value[items.value.length - 1];
    // The /compact WIP group is an agent item with one group part and no
    // header — its presence is covered by this check too.
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

/**
 * /compact result handling: the status box exists ONLY while compacting.
 * On success it vanishes immediately — the compaction summary entry that
 * lands in the flow is the record. On failure it stays briefly with a red
 * flash so the failure is visible, then dismisses itself.
 */
/** The compaction work group uses a fixed id ('compact'), so its open state
 *  must not leak into the next run — reset both toggle levels. */
function resetCompactOpen() {
  const next = { ...open.value };
  delete next.compact;
  delete next['compact:0'];
  open.value = next;
}
watch(
  () => session.value?.compactResult,
  (res) => {
    if (!res) return;
    if (res === 'done') {
      if (session.value) session.value.compactResult = null;
      resetCompactOpen();
    } else {
      // Same flash mechanism as bubble completion (flash is defined below):
      // the instant-fail path has no pending→fail transition for the items
      // watch to catch, so flash the fixed 'compact' group id directly.
      flash.value = { ...flash.value, compact: 'fail' };
      // Auto-reveal the failed sub-bubble AND its detail so the reason is
      // visible during the flash without a click.
      open.value = { ...open.value, compact: true, 'compact:0': true };
      window.setTimeout(() => {
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

/**
 * Flash the work box green/red when an action bubble completes (success/
 * failure). Detects pending → ok/fail transitions on every bubble kind; the
 * class is removed after the animation so a later completion re-triggers it.
 */
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
          flash.value = { ...flash.value, [part.group.id]: kind };
          window.setTimeout(() => {
            if (flash.value[part.group.id]) {
              const next = { ...flash.value };
              delete next[part.group.id];
              flash.value = next;
            }
          }, 1400);
        }
        prevBubbleStatus.set(b.key, b.status);
      }
    }
  }
});

/** work-group id → expanded (audit view) */
const workOpen = ref<Record<string, boolean>>({});
function toggleWork(id: string) {
  workOpen.value = { ...workOpen.value, [id]: !workOpen.value[id] };
}

/** move key → details expanded */
const moveOpen = ref<Record<string, boolean>>({});
function toggleMove(key: string) {
  moveOpen.value = { ...moveOpen.value, [key]: !moveOpen.value[key] };
}

// ── Slash commands: autocomplete ───────────────────────────────────────────

const commandCatalog = ref<SlashCommandInfo[]>([]);
const completionOpen = ref(false);
const completionIndex = ref(0);
const completionItems = ref<SlashCommandInfo[]>([]);
let catalogLoaded = false;

/** Frontend-only commands (not executed by the backend — message modifiers). */
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

/** Does the typed command name exist in the catalog? */
function isKnownCommand(name: string): boolean {
  return commandCatalog.value.some((c) => c.name === name);
}

/** Filter the catalog by the text between `/` and the first space. */
function updateCompletions() {
  const t = input.value;
  if (!t.startsWith('/') || t.startsWith('//')) {
    completionOpen.value = false;
    return;
  }
  // Bare `/` lists everything.
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

// ── Slash command execution ───────────────────────────────────────────────

/** Picker dialog state (model, tree, fork, resume, scoped-models…). */
const picker = ref<SlashPicker | null>(null);
const pickerIndex = ref(0);

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
        // Clipboard denied (permissions) — show the content inline instead.
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

/** Route the composer: slash command → backend, otherwise a normal message. */
function runCommand(parsed: ParsedSlash) {
  store.clearLastError();
  input.value = '';
  completionOpen.value = false;
  void runCommandAsync(parsed);
}

/** The context gauge is click-to-compact — same /compact pipeline as the
 *  composer (backend decides; the WIP bubble shows progress, failures
 *  flash the bubble red). */
function compactContext() {
  const s = session.value;
  if (!s || s.compacting) return;
  const parsed = parseSlash('/compact');
  if (!parsed) return;
  store.clearLastError();
  void runCommandAsync(parsed);
}

async function runCommandAsync(parsed: ParsedSlash) {
  const r = await runSlash(props.sessionId, parsed);
  await handleSlashResult(r);
  sticky = true;
  nextTick(scrollToBottom);
  inputEl.value?.focus();
}

async function onPickerSelect(id: string) {
  const p = picker.value;
  if (!p) return;
  picker.value = null;
  const r = await p.onSelect(id);
  if (r) await handleSlashResult(r);
}

// ── Composer ───────────────────────────────────────────────────────────────

/** Mobile auto-grow cap for the input box (px); the box grows with content
 *  up to this height, then scrolls internally. Desktop keeps its fixed
 *  one-line box + drag handle. */
const MOBILE_INPUT_MAX_PX = 120;
const isMobile = ref(window.innerWidth < 500);

/** Grow the textarea to fit its content, capped at MOBILE_INPUT_MAX_PX. */
function autoGrowMobileInput() {
  const el = inputEl.value;
  if (!el || !isMobile.value) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MOBILE_INPUT_MAX_PX)}px`;
  el.style.overflowY = el.scrollHeight > MOBILE_INPUT_MAX_PX ? 'auto' : 'hidden';
}

/** Back to the stylesheet's fixed one-line box (also on desktop). */
function resetMobileInputHeight() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = '';
  el.style.overflowY = '';
}

function onViewportResize() {
  isMobile.value = window.innerWidth < 500;
  if (isMobile.value) autoGrowMobileInput();
  else resetMobileInputHeight();
}

// Typing / programmatic changes (send clears input, completions insert
// text) re-measure the box; an empty box returns to one line.
watch(input, () => {
  nextTick(() => {
    if (input.value) autoGrowMobileInput();
    else resetMobileInputHeight();
  });
});

function send() {
  const text = input.value.trim();
  if (!text || !session.value) return;
  const parsed = parseSlash(text);
  if (parsed && parsed.command === 'wait') {
    // /wait <message>: queue instead of interrupting. Default is interrupt:
    // a plain message cuts the current turn and runs promptly.
    const rest = parsed.args.trim();
    if (!rest) {
      store.appendLocalMessage(props.sessionId, {
        text: 'Usage: /wait <message> — the message queues and runs after the current turn finishes, instead of interrupting it.',
      });
      input.value = '';
      completionOpen.value = false;
      inputEl.value?.focus();
      return;
    }
    store.clearLastError();
    void store.sendMessage(props.sessionId, rest, { wait: true });
    input.value = '';
    sticky = true;
    nextTick(scrollToBottom);
    inputEl.value?.focus();
    return;
  }
  if (parsed) {
    void runCommand(parsed);
    return;
  }
  store.clearLastError();
  void store.sendMessage(props.sessionId, text);
  input.value = '';
  sticky = true;
  nextTick(scrollToBottom);
  inputEl.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  // Picker dialog takes over the keyboard while open.
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

  // Send-key mode (global preference): 'enter' → Enter sends, Shift+Enter
  // newline; 'shiftEnter' → Shift+Enter sends, Enter newline (textarea default).
  const sendPressed = e.key === 'Enter' && (store.prefs.sendKey === 'enter' ? !e.shiftKey : e.shiftKey);
  if (sendPressed) {
    e.preventDefault();
    const parsed = parseSlash(input.value);
    if (
      completionOpen.value &&
      parsed &&
      !isKnownCommand(parsed.command) &&
      completionItems.value.length > 0
    ) {
      // Partial command: fill in the highlighted name, then run on next send key.
      completeWith(completionItems.value[completionIndex.value]);
      return;
    }
    send();
  }
}

/** Typing in the composer is a real interaction: pin the window if it was
 *  in review mode. */
function onComposerInput() {
  store.noteChatInteraction(props.sessionId);
}

/** Scroll the message list to the bottom and re-anchor auto-scroll so new
 *  content keeps the view at the bottom. */
function scrollToBottomNow() {
  sticky = true;
  scrollToBottom();
}

/** Composer height set by dragging the handle (null = fixed one-line box).
 *  Store-backed so it survives workspace persistence: the store's
 *  window-state provider captures it into snapshots and restores it on
 *  apply (the workspace API flushes pending state at bind time). */
const manualHeight = computed({
  get: () => store.windowUiOf(props.sessionId)?.composerHeight ?? null,
  set: (v: number | null) => store.setComposerHeight(props.sessionId, v),
});
// Drag-resize limits, expressed per-em so they scale with font-size.
// Minimum = the fixed one-line box (line + padding + borders).
const MIN_INPUT_EM = 1.4 + 2 * 0.44 + 2 / 16;
const MAX_INPUT_EM = 320 / 16;

let resizeCleanup: (() => void) | null = null;

/** Drag the composer's top handle to set a fixed input height. */
function startResize(e: MouseEvent) {
  if (isMobile.value) return; // mobile auto-grows; no drag handle
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

/** Reset to the default one-line height on double-click of the handle. */
function resetResize() {
  manualHeight.value = null;
}

onMounted(() => {
  now.value = Date.now();
  scrollToBottom();
  inputEl.value?.focus();
  window.addEventListener('resize', onViewportResize);
  // Mobile layout swaps remount this component (flat tile) — the mount
  // happens after the resize event, so re-apply the auto-grow height.
  if (isMobile.value) nextTick(autoGrowMobileInput);
  // When the messages area resizes (e.g. the composer grows/shrinks via its
  // drag handle), keep the bottom edge of the visible text anchored in both
  // directions: the content moves UP as the area shrinks and DOWN as it
  // grows (clamped at the scroll bounds, so at-bottom stays at the bottom).
  const el = listEl.value;
  if (el) {
    listObserver = new ResizeObserver(() => {
      // Keep the content that sits at the viewport's bottom edge anchored
      // while the messages area resizes. The anchor is a content offset that
      // only changes on user scrolls, so repeated resizes round-trip exactly
      // (delta-based shifting accumulated sub-pixel drift).
      const h = el.clientHeight;
      if (prevListH === 0) {
        anchorBottom = el.scrollTop + h; // first observation: seed the anchor
      } else if (h !== prevListH) {
        if (sticky) {
          // At the bottom: stay pinned. (Mobile send clears + shrinks the
          // composer AFTER the scroll, so the anchor math would yank the
          // view back up by the shrink amount and disarm sticky.)
          el.scrollTop = el.scrollHeight;
        } else {
          el.scrollTop = Math.max(0, Math.min(anchorBottom - h, el.scrollHeight - el.clientHeight));
        }
      }
      prevListH = h;
    });
    listObserver.observe(el);
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', onViewportResize);
  resizeCleanup?.();
  listObserver?.disconnect();
});

let listObserver: ResizeObserver | null = null;
let prevListH = 0;
/** content offset kept at the viewport's bottom edge (resize anchor) */
let anchorBottom = 0;
</script>

<template>
  <div class="chat-window">
    <!-- Header -->
    <div class="chat-header">
      <div class="chat-header-title">
        <span class="chat-status-dot" :class="'chat-status-dot--' + (session?.status ?? 'idle')" />
        <span class="chat-title-text">{{ session?.title ?? 'Chat' }}</span>
      </div>
    </div>

    <!-- Messages -->
    <div ref="listEl" class="chat-messages" @scroll="onScroll">
      <div v-if="!session" class="chat-empty">Session not found.</div>
      <div v-else-if="session.messages.length === 0" class="chat-empty">
        No messages yet — say hello. Type <code>/</code> for slash commands.
      </div>
      <template v-else>
        <!-- Scroll-up pagination: older messages load on demand -->
        <div
          v-if="session.hasMoreOlder && !session.loadingOlder"
          class="chat-load-older"
          @click="loadOlder()"
        ><SvgIcon name="↑" /> older messages</div>
        <div v-if="session.loadingOlder" class="chat-load-older chat-load-older--loading">loading older messages…</div>
        <div
          v-for="item in items"
          :key="rowKey(item)"
          class="chat-msg"
          :data-msg-id="rowKey(item)"
          :class="[
            item.kind === 'user' ? '' : 'chat-msg--' + item.kind,
            { 'chat-msg--error': item.kind === 'system' && item.msg.isError },
          ]"
        >
          <!-- Agent turn: ONE separator for the whole turn. Every work run
               and reply of the turn is a PART of this single row, so the
               sticky separator's containing block spans the entire turn —
               the line stays pinned at the top even through a very long
               multi-reply. -->
          <template v-if="item.kind === 'agent'">
            <div
              v-if="item.header"
              class="chat-sep"
              title="Jump to the start of this message"
              @click="jumpToSep"
            >
              <span class="chat-sep-line" /><span class="chat-sep-text">{{ agentSepLabel(item.header) }}</span><span class="chat-sep-line" />
            </div>
            <div
              v-for="part in item.parts"
              :key="part.kind === 'group' ? part.group.id : part.msg.id"
              class="chat-agent-part"
            >
              <!-- ActionBubble group: consecutive thinking/tool/bash actions
                   in one collapsible box. WIP header = the latest bubble;
                   done header = "n actions done". Click to reveal the
                   stacked sub-bubbles; a sub-bubble click reveals its
                   detail. -->
              <div
                v-if="part.kind === 'group'"
                class="chat-work"
                :class="[
                  flash[part.group.id] === 'ok' ? 'chat-work--flash-ok' : '',
                  flash[part.group.id] === 'fail' ? 'chat-work--flash-fail' : '',
                  flash['compact'] === 'fail' ? 'chat-work--flash-fail' : '',
                  part.group.id === 'compact' ? 'chat-compacting' : '',
                  part.group.id === 'compact' && !part.group.wip ? 'chat-compacting--failed' : '',
                ]"
              >
                <div class="chat-work-head" @click="toggle(part.group.id)">
                  <span class="chat-work-toggle"><SvgIcon :name="open[part.group.id] ? '▾' : '▸'" /></span>
                  <!-- While working the group shows the same thing as the latest bubble:
                       [action name|ani|content|time elapsed] -->
                  <template v-if="part.group.wip && part.group.latest">
                    <span class="chat-ab-name">{{ part.group.latest.name }}</span>
                    <span class="chat-ab-dots">{{ '.'.repeat(dots) }}</span>
                    <span class="chat-ab-content">{{ part.group.latest.preview() }}</span>
                    <span class="chat-ab-time">{{ fmtSec(now - part.group.latest.startTs) }}</span>
                  </template>
                  <!-- All done: [n actions done|total time elapsed] -->
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
                    <!-- Completed bubble: [action name|time elapsed] -->
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

              <!-- Assistant official reply: full width, no bubble; error
                   banner below the text -->
              <template v-else>
                <div v-if="renderMd" class="chat-msg-md" v-html="md(part.msg)" />
                <template v-else>{{ part.msg.text }}</template>
                <span v-if="streaming && part.msg.id === lastMessage?.id" class="chat-cursor"><SvgIcon name="▌" /></span>
                <div v-if="part.msg.error" class="chat-aborted chat-aborted--error"><SvgIcon name="⚠" /> {{ part.msg.error }}</div>
              </template>
            </div>
          </template>

          <!-- User message: sticky separator + blue bubble -->
          <template v-else-if="item.kind === 'user'">
            <div
              class="chat-sep"
              title="Jump to the start of this message"
              @click="jumpToSep"
            >
              <span class="chat-sep-line" /><span class="chat-sep-text">{{ userSepLabel(item.msg) }}</span><span class="chat-sep-line" />
            </div>
            <div class="chat-user-bubble">
              <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
              <template v-else>{{ item.msg.text }}</template>
            </div>
            <div v-if="item.msg.sendFailed" class="chat-resend" title="The backend did not accept this message — send it again">
              <span class="chat-resend-mark"><SvgIcon name="⚠" /></span> not sent
              <button class="chat-resend-btn" @click="store.resendMessage(props.sessionId, item.msg.id)"><SvgIcon name="↻" /> Resend</button>
            </div>
          </template>

          <!-- Custom: boxed, full width; meta on top (slash output rows) -->
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

          <!-- System (slash command output) -->
          <pre v-else-if="item.kind === 'system'" class="chat-system">{{ item.msg.text }}</pre>

          <!-- Summary: compacted context as an ActionBubble box (same look as
               the /compact status bubble — no separate yellow box). Collapsed
               until clicked; the compact done-box click auto-expands it. -->
          <div
            v-else-if="item.kind === 'summary'"
            class="chat-work chat-summary-ab"
            @click="toggle('sum-' + item.msg.id)"
          >
            <div class="chat-work-head">
              <span class="chat-work-toggle"><SvgIcon :name="open['sum-' + item.msg.id] ? '▾' : '▸'" /></span>
              <span class="chat-ab-name">Compaction summary</span>
              <!-- Same content slot as the tool bubbles: the collapsed head
                   carries a capped preview of the summary (as much text as
                   fits — ellipsis only when narrow), not an empty box. -->
              <span class="chat-ab-content chat-summary-ab-preview">{{ summaryPreview(item.msg.text) }}</span>
            </div>
            <div v-if="open['sum-' + item.msg.id]" class="chat-work-body">
              <pre class="chat-ab-code chat-summary-ab-body">{{ item.msg.text }}</pre>
            </div>
          </div>

        </div>
      </template>
    </div>

    <div class="chat-composer">
      <div
        class="chat-composer-handle"
        title="Drag to resize the input · double-click to reset"
        @mousedown="startResize"
        @dblclick="resetResize"
      ><span class="chat-composer-grip" /></div>
      <div v-if="store.lastError" class="chat-banner chat-banner--error" @click="store.clearLastError()">
        <SvgIcon name="⚠" /> {{ store.lastError }} (click to dismiss)
      </div>
      <!-- Slash command autocomplete -->
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

        <textarea
          ref="inputEl"
          v-model="input"
          class="chat-input"
          rows="1"
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
            :disabled="session?.compacting"
            @click="compactContext"
          >{{ contextDisplay }}</button>
          <button
            class="chat-scroll-btn"
            title="Scroll to bottom"
            @click="scrollToBottomNow"
          ><SvgIcon name="↓" /></button>
          <button
            class="chat-send-btn"
            :disabled="!input.trim()"
            @click="send"
          >Send</button>
        </div>
    </div>

    <!-- Picker dialog (model / scoped-models / tree / fork / resume) -->
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
