<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  useChatStore, fmtTime, type ChatSession, type DisplayMessage,
} from '../store/chat';
import {
  allSlashCommands, parseSlash, runSlash,
  type SlashCommandInfo, type SlashPicker, type SlashResult,
} from '../slash/commands';

const props = defineProps<{ sessionId: string }>();
const store = useChatStore();

const session = computed<ChatSession | undefined>(() => store.findSession(props.sessionId));
/** Global preference (right panel): render message text as markdown. */
const renderMd = computed(() => store.prefs.renderMarkdown);

/**
 * Compacted-context summaries stay collapsed until clicked (a summary can be
 * tens of thousands of characters — showing it inline as a wall of text was
 * the #1 complaint). They render as ActionBubble-style boxes (no yellow box);
 * toggling the header expands/collapses the text.
 */
const expandedSummaries = ref<Set<string>>(new Set());
/** id of the summary box currently glowing after click-to-audit */
const flashingSummary = ref<string | null>(null);
function toggleSummary(id: string) {
  const next = new Set(expandedSummaries.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedSummaries.value = next;
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
  return (t.length > 300 ? flat + '…' : flat) || '…';
}
const input = ref('');
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

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
// O(1) key (count + last message identity/lengths) is enough: messages are
// append-only except the live tail being streamed, so a change always
// shows up in the last message or in the count. The DOM must be updated
// before measuring, so scroll runs after the render flush.
const keepBottom = () => { if (sticky) nextTick(scrollToBottom); };
// Re-run on new messages and on streaming text/thinking growth. A cheap
// O(1) key (count + last message identity/lengths) is enough: messages are
// append-only except the live tail being streamed, so a change always
// shows up in the last message or in the count. The DOM must be updated
// before measuring, so scroll runs after the render flush.
watch(
  () => {
    const s = session.value;
    if (!s) return '';
    const last = s.messages[s.messages.length - 1];
    return last
      ? `${s.messages.length}:${last.id}:${last.text.length}:${(last.thinking ?? '').length}`
      : `${s.messages.length}:`;
  },
  keepBottom,
);

// The /compact progress box toggles without changing messages.
watch(() => session.value?.compacting, keepBottom);

const lastMessage = computed<DisplayMessage | undefined>(() => {
  const msgs = session.value?.messages ?? [];
  return msgs[msgs.length - 1];
});

/** The agent is producing the tail message right now. */
const streaming = computed(() =>
  session.value?.status === 'running' && lastMessage.value?.role === 'assistant',
);

const ROLE_LABELS: Record<string, string> = {
  user: 'You', assistant: 'pi', summary: 'summary', bash: 'bash', system: 'system',
};
function roleLabel(m: DisplayMessage): string { return ROLE_LABELS[m.role] ?? 'custom'; }

// ── ActionBubble work groups ─────────────────────────────────────────────
// Consecutive "unofficial" replies (thinking blocks + tool calls) between a
// user message and the final text reply collapse into ONE ActionGroup box:
//   - group in progress: header shows the LATEST bubble: name + dots + live
//     content preview + elapsed (the bubble's own format)
//   - group finished:    "n actions done" + total elapsed — click to expand
//     the stacked sub-bubbles; a sub-bubble click reveals its detail.

import { ActionBubble, ActionGroup, actionName, type ActionKind, type ActionStatus } from '../actionBubble';

export type ChatItem =
  | { kind: 'user' | 'system' | 'summary' | 'custom'; msg: DisplayMessage }
  | { kind: 'reply'; msg: DisplayMessage; timeUsedMs: number; endTs: number; lastInTurn: boolean; trailing: boolean }
  | { kind: 'work'; group: ActionGroup };

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

/** Agent reply footer: "pi · model[ · thinking] · time[ · time used]". */
function agentMeta(item: Extract<ChatItem, { kind: 'reply' }>): string {
  const m = item.msg;
  const thinking = m.thinking ? ' · thinking' : '';
  const used = item.timeUsedMs > 0 ? ` · ${fmtSec(item.timeUsedMs)}` : '';
  return `${roleLabel(m)} · ${m.model ?? '—'}${thinking} · ${fmtMsgTime(item.endTs)}${used}`;
}

/** Short duration: "<1s" / "12.3s" / "1m 30s". */
function fmtSec(ms: number): string {
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

  // Turn-boundary precompute (single O(n) pass): the old per-reply forward
  // scans were O(turn²) and re-ran on every streamed token/tool partial.
  const nextUser: number[] = new Array(n).fill(n);   // first user index > i
  const prevUserTs: number[] = new Array(n).fill(0); // ts of the last user < i
  const lastTextReply: boolean[] = new Array(n).fill(false);
  let next = n;
  for (let i = n - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') next = i;
    nextUser[i] = next;
  }
  let prevTs = 0;
  let turnLastText = -1;
  for (let i = 0; i < n; i++) {
    prevUserTs[i] = prevTs;
    if (msgs[i].role === 'user') {
      if (turnLastText >= 0) lastTextReply[turnLastText] = true;
      turnLastText = -1;
      prevTs = msgs[i].ts;
    } else if (msgs[i].role === 'assistant' && msgs[i].text) {
      turnLastText = i;
    }
  }
  if (turnLastText >= 0) lastTextReply[turnLastText] = true;

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
    out.push({ kind: 'work', group });
    work.length = 0;
    workId = '';
  };

  const addMove = (src: number, msgId: string, kind: ActionKind, mv: Omit<PendingMove, 'kind' | 'name'> & { name?: string }) => {
    if (!workId) workId = 'work-' + msgId;
    work.push({ src, mv: { ...mv, kind, name: actionName(kind, mv.name) } });
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user' || m.role === 'system' || m.role === 'summary') {
      flush(m.ts, false);
      out.push({ kind: m.role, msg: m });
      continue;
    }
    if (m.role === 'bash') {
      addMove(i, m.id, 'bash', { text: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      let added = false;
      if (m.thinking) { addMove(i, m.id, 'thinking', { thinking: m.thinking }); added = true; }
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
        // Whole-job footer timing from the precomputed turn boundaries:
        // time = when the turn finished (last message of the turn),
        // time used = from the user's input until then.
        const end = nextUser[i];
        const endTs = end > i ? msgs[end - 1].ts : m.ts;
        const lastInTurn = lastTextReply[i];
        out.push({
          kind: 'reply', msg: m,
          // Textless error messages are never the turn's last text reply
          // (lastInTurn=false), so timeUsedMs falls back to 0.
          timeUsedMs: lastInTurn && prevUserTs[i] > 0 ? Math.max(0, endTs - prevUserTs[i]) : 0,
          endTs,
          lastInTurn,
          trailing: end === n,
        });
      }
      continue;
    }
    flush(m.ts, false);
    out.push({ kind: 'custom', msg: m });
  }
  // A trailing work run is still in progress while the agent is working.
  flush(null, session.value?.status === 'running');

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
      b.detail = 'Summarizing the conversation…';
    } else {
      b.status = 'fail';
      b.isError = true;
      b.durMs = Math.max(0, (s.compactEndedAt || started) - started);
      b.detail = s.compactError || '';
    }
    group.bubbles.push(b);
    out.push({ kind: 'work', group });
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
    const workWip = last?.kind === 'work' && last.group.wip;
    return workWip || session.value?.compacting === true;
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
const compactFlash = ref<'fail' | null>(null);
/** The compaction work group uses a fixed id ('compact'), so its open state
 *  must not leak into the next run — reset both toggle levels. */
function resetCompactOpen() {
  const wo = { ...workOpen.value };
  delete wo.compact;
  workOpen.value = wo;
  const mo = { ...moveOpen.value };
  delete mo['compact:0'];
  moveOpen.value = mo;
}
watch(
  () => session.value?.compactResult,
  (res) => {
    if (!res) return;
    if (res === 'done') {
      session.value!.compactResult = null;
      resetCompactOpen();
    } else {
      compactFlash.value = 'fail';
      // Auto-reveal the failed sub-bubble AND its detail so the reason is
      // visible during the flash without a click.
      workOpen.value = { ...workOpen.value, compact: true };
      moveOpen.value = { ...moveOpen.value, 'compact:0': true };
      window.setTimeout(() => {
        compactFlash.value = null;
        if (session.value?.compactResult === 'failed') {
          session.value.compactResult = null;
          resetCompactOpen();
        }
      }, 1500);
    }
  },
);

/** The /compact status is a regular work item (see the items computed) —
 *  no separate group/kind. */
onMounted(() => { now.value = Date.now(); });

/**
 * Flash the work box green/red when an action bubble completes (success/
 * failure). Detects pending → ok/fail transitions on every bubble kind; the
 * class is removed after the animation so a later completion re-triggers it.
 */
const flash = ref<Record<string, 'ok' | 'fail'>>({});
const prevBubbleStatus = new Map<string, ActionStatus>();
watch(
  items,
  (list) => {
    for (const item of list) {
      if (item.kind !== 'work') continue;
      for (const b of item.group.bubbles) {
        const prev = prevBubbleStatus.get(b.key);
        if (prev === 'pending' && b.status !== 'pending') {
          const kind = b.status === 'ok' ? 'ok' : 'fail';
          flash.value = { ...flash.value, [item.group.id]: kind };
          window.setTimeout(() => {
            if (flash.value[item.group.id]) {
              const next = { ...flash.value };
              delete next[item.group.id];
              flash.value = next;
            }
          }, 1400);
        }
        prevBubbleStatus.set(b.key, b.status);
      }
    }
  },
);

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

watch(input, () => { ensureCatalog(); updateCompletions(); });

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
        store.appendLocalMessage(props.sessionId, { text: `Clipboard unavailable — last agent message:\n\n${r.text}` });
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
async function runCommand() {
  const text = input.value.trim();
  if (!text) return;
  const parsed = parseSlash(text);
  if (!parsed) return;
  store.clearLastError();
  input.value = '';
  completionOpen.value = false;
  const r = await runSlash(props.sessionId, text);
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
    void runCommand();
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
    if (e.key === 'ArrowDown') { e.preventDefault(); pickerIndex.value = (pickerIndex.value + 1) % picker.value.items.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); pickerIndex.value = (pickerIndex.value - 1 + picker.value.items.length) % picker.value.items.length; return; }
    if (e.key === 'Enter') { e.preventDefault(); void onPickerSelect(picker.value.items[pickerIndex.value].id); return; }
    if (e.key === 'Escape') { e.preventDefault(); picker.value = null; return; }
    return;
  }

  if (completionOpen.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCompletion(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveCompletion(-1); return; }
    if (e.key === 'Escape') { e.preventDefault(); completionOpen.value = false; return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const items = completionItems.value;
      if (items[completionIndex.value]) completeWith(items[completionIndex.value]);
      return;
    }
  }

  // Send-key mode (global preference): 'enter' → Enter sends, Shift+Enter
  // newline; 'shiftEnter' → Shift+Enter sends, Enter newline (textarea default).
  const sendPressed = e.key === 'Enter'
    && (store.prefs.sendKey === 'enter' ? !e.shiftKey : e.shiftKey);
  if (sendPressed) {
    e.preventDefault();
    const parsed = parseSlash(input.value);
    if (completionOpen.value && parsed && !isKnownCommand(parsed.command) && completionItems.value.length > 0) {
      // Partial command: fill in the highlighted name, then run on next send key.
      completeWith(completionItems.value[completionIndex.value]);
      return;
    }
    send();
  }
}

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  if (manualHeight.value !== null) {
    // Drag-set height: fixed, no auto-grow.
    el.style.height = manualHeight.value + 'px';
    return;
  }
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

/** Composer height set by dragging the handle (null = auto-grow). */
const manualHeight = ref<number | null>(null);
const MIN_INPUT_H = 60;
const MAX_INPUT_H = 320;

let resizeCleanup: (() => void) | null = null;

/** Drag the composer's top handle to set a fixed input height. */
function startResize(e: MouseEvent) {
  e.preventDefault();
  const startY = e.clientY;
  const startH = manualHeight.value ?? (inputEl.value?.offsetHeight ?? 80);
  const onMove = (ev: MouseEvent) => {
    manualHeight.value = Math.min(MAX_INPUT_H, Math.max(MIN_INPUT_H, startH + (startY - ev.clientY)));
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

/** Reset to auto-grow on double-click of the handle. */
function resetResize() {
  manualHeight.value = null;
  nextTick(autoGrow);
}

onMounted(() => {
  scrollToBottom();
  inputEl.value?.focus();
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
        anchorBottom = el.scrollTop + h;   // first observation: seed the anchor
      } else if (h !== prevListH) {
        el.scrollTop = Math.max(0, Math.min(anchorBottom - h, el.scrollHeight - el.clientHeight));
      }
      prevListH = h;
    });
    listObserver.observe(el);
  }
});

onUnmounted(() => { resizeCleanup?.(); listObserver?.disconnect(); });

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
      <div class="chat-header-right">
        <span v-if="session?.stats.model" class="chat-model">{{ session.stats.model }}</span>
        <button
          v-if="session?.status === 'running'"
          class="chat-stop-btn"
          title="Abort generation (the session stays open)"
          @click="store.stopSession(props.sessionId)"
        >■ Stop</button>
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
        >↑ older messages</div>
        <div v-if="session.loadingOlder" class="chat-load-older chat-load-older--loading">loading older messages…</div>
        <div
          v-for="item in items"
          :key="item.kind === 'work' ? item.group.id : item.msg.id"
          class="chat-msg"
          :data-msg-id="item.kind === 'work' ? item.group.id : item.msg.id"
          :class="[
            'chat-msg--' + item.kind,
            { 'chat-msg--error': item.kind === 'system' && item.msg.isError },
          ]"
        >
          <!-- ActionBubble group: consecutive thinking/tool/bash actions in
               one collapsible box. WIP header = the latest bubble; done
               header = "n actions done". Click to reveal the stacked
               sub-bubbles; a sub-bubble click reveals its detail. -->
          <div
            v-if="item.kind === 'work'"
            class="chat-work"
            :class="[
              { 'chat-work--open': workOpen[item.group.id] },
              flash[item.group.id] === 'ok' ? 'chat-work--flash-ok' : '',
              flash[item.group.id] === 'fail' ? 'chat-work--flash-fail' : '',
              compactFlash === 'fail' ? 'chat-work--flash-fail' : '',
              item.group.id === 'compact' ? 'chat-compacting' : '',
              item.group.id === 'compact' && !item.group.wip ? 'chat-compacting--failed' : '',
            ]"
          >
            <div class="chat-work-head" @click="toggleWork(item.group.id)">
              <span class="chat-work-toggle">{{ workOpen[item.group.id] ? '▾' : '▸' }}</span>
              <!-- While working the group shows the same thing as the latest bubble:
                   [action name|ani|content|time elapsed] -->
              <template v-if="item.group.wip && item.group.latest">
                <span class="chat-ab-name">{{ item.group.latest.name }}</span>
                <span class="chat-ab-dots">{{ '.'.repeat(dots) }}</span>
                <span class="chat-ab-content">{{ item.group.latest.preview() }}</span>
                <span class="chat-ab-time">{{ fmtSec(now - item.group.latest.startTs) }}</span>
              </template>
              <!-- All done: [n actions done|total time elapsed] -->
              <template v-else>
                <span class="chat-ab-name">{{ groupDoneLabel(item.group) }}</span>
                <span class="chat-ab-time">{{ fmtSec(item.group.durMs) }}</span>
              </template>
            </div>
            <div v-if="workOpen[item.group.id]" class="chat-work-body">
              <div
                v-for="b in item.group.bubbles"
                :key="b.key"
                class="chat-ab-sub"
                :class="[subClass(b), { 'chat-ab-sub--open': moveOpen[b.key] }]"
              >
                <!-- Completed bubble: [action name|time elapsed] -->
                <div class="chat-ab-sub-head" @click="toggleMove(b.key)">
                  <span class="chat-ab-sub-toggle">{{ moveOpen[b.key] ? '▾' : '▸' }}</span>
                  <span class="chat-ab-sub-name">{{ b.name }}</span>
                  <span class="chat-ab-sub-time">{{ b.live ? fmtSec(now - b.startTs) : fmtSec(b.durMs) }}</span>
                </div>
                <div v-if="moveOpen[b.key]" class="chat-ab-sub-details">
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

          <!-- User / custom: boxed, full width; meta on top -->
          <template v-else-if="item.kind === 'user' || item.kind === 'custom'">
            <div class="chat-msg-meta">{{ roleLabel(item.msg) }} · {{ fmtMsgTime(item.msg.ts) }}</div>
            <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
            <template v-else>{{ item.msg.text }}</template>
            <div v-if="item.msg.sendFailed" class="chat-resend" title="The backend did not accept this message — send it again">
              <span class="chat-resend-mark">⚠</span> not sent
              <button class="chat-resend-btn" @click="store.resendMessage(props.sessionId, item.msg.id)">↻ Resend</button>
            </div>
            <div v-if="item.kind === 'custom'" class="chat-msg-time">{{ fmtTime(item.msg.ts) }}</div>
          </template>

          <!-- Assistant official reply: full width, no box; meta footer -->
          <template v-else-if="item.kind === 'reply'">
            <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
            <template v-else>{{ item.msg.text }}</template>
            <span v-if="streaming && item.msg.id === lastMessage?.id" class="chat-cursor">▌</span>
            <div v-if="item.msg.stopReason === 'aborted'" class="chat-aborted">⏹ generation aborted</div>
            <div v-if="item.msg.error" class="chat-aborted chat-aborted--error">⚠ {{ item.msg.error }}</div>
            <div v-if="item.lastInTurn && !(item.trailing && streaming)" class="chat-msg-meta chat-msg-meta--agent">{{ agentMeta(item) }}</div>
          </template>

          <!-- System (slash command output) -->
          <pre v-else-if="item.kind === 'system'" class="chat-system">{{ item.msg.text }}</pre>

          <!-- Summary: compacted context as an ActionBubble box (same look as
               the /compact status bubble — no separate yellow box). Collapsed
               until clicked; the compact done-box click auto-expands it. -->
          <div
            v-else-if="item.kind === 'summary'"
            class="chat-work chat-summary-ab"
            :class="{
              'chat-summary-ab--open': expandedSummaries.has(item.msg.id),
              'chat-msg--flash': flashingSummary === item.msg.id,
            }"
            @click="toggleSummary(item.msg.id)"
          >
            <div class="chat-work-head">
              <span class="chat-work-toggle">{{ expandedSummaries.has(item.msg.id) ? '▾' : '▸' }}</span>
              <span class="chat-ab-name">Compaction summary</span>
              <!-- Same content slot as the tool bubbles: the collapsed head
                   carries a capped preview of the summary (as much text as
                   fits — ellipsis only when narrow), not an empty box. -->
              <span class="chat-ab-content chat-summary-ab-preview">{{ summaryPreview(item.msg.text) }}</span>
            </div>
            <div v-if="expandedSummaries.has(item.msg.id)" class="chat-work-body">
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
        ⚠ {{ store.lastError }} (click to dismiss)
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
          :style="manualHeight !== null ? { height: manualHeight + 'px', maxHeight: manualHeight + 'px' } : {}"
          @keydown="onKeydown"
          @input="autoGrow"
        />
        <button
          class="chat-send-btn"
          :disabled="!input.trim() || session?.status === 'running'"
          @click="send"
        >{{ session?.status === 'running' ? '…' : 'Send' }}</button>
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
