<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
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
/** Per-window toggle (right panel): render message text as markdown. */
const renderMd = computed(() => session.value?.renderMarkdown ?? true);

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
watch(
  () => {
    const s = session.value;
    if (!s) return '';
    const last = s.messages[s.messages.length - 1];
    return last
      ? `${s.messages.length}:${last.id}:${last.text.length}:${(last.thinking ?? '').length}`
      : `${s.messages.length}:`;
  },
  () => { if (sticky) nextTick(scrollToBottom); },
);

const lastMessage = computed<DisplayMessage | undefined>(() => {
  const msgs = session.value?.messages ?? [];
  return msgs[msgs.length - 1];
});

/** The agent is producing the tail message right now. */
const streaming = computed(() =>
  session.value?.status === 'running' && lastMessage.value?.role === 'assistant',
);

function roleLabel(m: DisplayMessage): string {
  if (m.role === 'user') return 'You';
  if (m.role === 'assistant') return 'pi';
  if (m.role === 'summary') return 'summary';
  if (m.role === 'bash') return 'bash';
  if (m.role === 'system') return 'system';
  return 'custom';
}

// ── Unofficial-reply work groups ──────────────────────────────────────────
// Consecutive "unofficial" replies (thinking blocks + tool calls) between a
// user message and the final text reply collapse into ONE box per run:
//   - run in progress:  "Working on: <latest move>" (one line)
//   - run finished:     "Work done" — click to expand and audit the details

export interface WorkMove {
  key: string;
  kind: 'thinking' | 'tool' | 'bash';
  done: boolean;
  isError?: boolean;
  thinking?: string;
  name?: string;
  args?: string;
  result?: string;
  text?: string;
}

export type ChatItem =
  | { kind: 'user' | 'system' | 'summary' | 'reply' | 'custom'; msg: DisplayMessage }
  | { kind: 'work'; id: string; moves: WorkMove[]; wip: boolean };

function moveLabel(mv: WorkMove): string {
  if (mv.kind === 'thinking') return 'thinking';
  if (mv.kind === 'bash') return mv.done ? 'bash ✓' : 'bash';
  if (mv.isError) return `${mv.name} ✗`;
  return mv.done ? `${mv.name} ✓` : `calling ${mv.name}`;
}

function latestMoveLabel(moves: WorkMove[]): string {
  const last = moves[moves.length - 1];
  return last ? moveLabel(last) : '';
}

/** The conversation as render items: work runs collapsed into one box each. */
const items = computed<ChatItem[]>(() => {
  const msgs = session.value?.messages ?? [];
  const out: ChatItem[] = [];
  let work: WorkMove[] = [];
  let workId = '';

  const flush = (wip: boolean) => {
    if (work.length === 0) return;
    out.push({ kind: 'work', id: workId, moves: work, wip });
    work = [];
    workId = '';
  };

  const addMove = (msgId: string, mv: Omit<WorkMove, 'key' | 'done'>) => {
    if (!workId) workId = 'work-' + msgId;
    work.push({
      ...mv,
      key: `${workId}:${work.length}`,
      done: mv.kind === 'tool' ? mv.result !== undefined : true,
    });
  };

  for (const m of msgs) {
    if (m.role === 'user' || m.role === 'system' || m.role === 'summary') {
      flush(false);
      out.push({ kind: m.role, msg: m });
      continue;
    }
    if (m.role === 'bash') {
      addMove(m.id, { kind: 'bash', text: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.thinking) addMove(m.id, { kind: 'thinking', thinking: m.thinking });
      for (const tc of m.toolCalls ?? []) {
        addMove(m.id, { kind: 'tool', name: tc.name, args: tc.args, result: tc.result, isError: tc.isError });
      }
      if (m.text) {
        // The official reply ends the work phase.
        flush(false);
        out.push({ kind: 'reply', msg: m });
      }
      continue;
    }
    flush(false);
    out.push({ kind: 'custom', msg: m });
  }
  // A trailing work run is still in progress while the agent is working.
  flush(session.value?.status === 'running');
  return out;
});

/** work-group id → expanded (audit view) */
const workOpen = ref<Record<string, boolean>>({});
function toggleWork(id: string) {
  workOpen.value = { ...workOpen.value, [id]: !workOpen.value[id] };
}

// ── Slash commands: autocomplete ───────────────────────────────────────────

const commandCatalog = ref<SlashCommandInfo[]>([]);
const completionOpen = ref(false);
const completionIndex = ref(0);
const completionItems = ref<SlashCommandInfo[]>([]);
let catalogLoaded = false;

function ensureCatalog() {
  if (catalogLoaded) return;
  catalogLoaded = true;
  void allSlashCommands().then((cmds) => {
    commandCatalog.value = cmds;
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
  if (parseSlash(text)) {
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

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const parsed = parseSlash(input.value);
    if (completionOpen.value && parsed && !isKnownCommand(parsed.command) && completionItems.value.length > 0) {
      // Partial command: fill in the highlighted name, then run on next Enter.
      completeWith(completionItems.value[completionIndex.value]);
      return;
    }
    send();
  }
}

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

onMounted(() => {
  scrollToBottom();
  inputEl.value?.focus();
});
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
        <span v-if="session?.tuiActive" class="chat-lock" title="This session is live in the pi TUI — read-only here">🔒 TUI</span>
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
          :key="item.kind === 'work' ? item.id : item.msg.id"
          class="chat-msg"
          :class="[
            'chat-msg--' + item.kind,
            { 'chat-msg--error': item.kind === 'system' && item.msg.isError },
          ]"
        >
          <!-- Unofficial work run: one collapsible box per run -->
          <div v-if="item.kind === 'work'" class="chat-work" :class="{ 'chat-work--open': workOpen[item.id] }">
            <div class="chat-work-head" @click="toggleWork(item.id)">
              <span class="chat-work-toggle">{{ workOpen[item.id] ? '▾' : '▸' }}</span>
              <span v-if="item.wip" class="chat-work-title">Working on: <span class="chat-work-latest">{{ latestMoveLabel(item.moves) }}</span></span>
              <span v-else class="chat-work-title">Work done</span>
            </div>
            <div v-if="workOpen[item.id]" class="chat-work-body">
              <template v-for="mv in item.moves" :key="mv.key">
                <div v-if="mv.kind === 'thinking'" class="chat-work-move">
                  <div class="chat-work-move-label">💭 thinking</div>
                  <pre class="chat-work-code">{{ mv.thinking }}</pre>
                </div>
                <div v-else-if="mv.kind === 'tool'" class="chat-work-move">
                  <div class="chat-work-move-label">
                    <span>🔧 {{ mv.name }}</span>
                    <span v-if="mv.isError" class="chat-work-status chat-work-status--error">✗</span>
                    <span v-else-if="mv.done" class="chat-work-status">✓</span>
                    <span v-else class="chat-work-status chat-work-status--pending">…</span>
                  </div>
                  <pre v-if="mv.args" class="chat-work-code">{{ mv.args }}</pre>
                  <div v-if="mv.done" class="chat-work-result" :class="{ 'chat-work-result--error': mv.isError }">
                    <pre class="chat-work-code chat-work-result-body">{{ mv.result }}</pre>
                  </div>
                </div>
                <div v-else class="chat-work-move">
                  <div class="chat-work-move-label">bash</div>
                  <pre class="chat-work-code chat-work-bash">{{ mv.text }}</pre>
                </div>
              </template>
            </div>
          </div>

          <!-- User: boxed, full width -->
          <template v-else-if="item.kind === 'user'">
            <div class="chat-msg-role">{{ roleLabel(item.msg) }}</div>
            <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
            <template v-else>{{ item.msg.text }}</template>
            <div class="chat-msg-time">{{ fmtTime(item.msg.ts) }}</div>
          </template>

          <!-- Assistant official reply: full width, no box -->
          <template v-else-if="item.kind === 'reply'">
            <div class="chat-msg-role">{{ roleLabel(item.msg) }}</div>
            <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
            <template v-else>{{ item.msg.text }}</template>
            <span v-if="streaming && item.msg.id === lastMessage?.id" class="chat-cursor">▌</span>
            <div v-if="item.msg.stopReason === 'aborted'" class="chat-aborted">⏹ generation aborted</div>
            <div v-if="item.msg.error" class="chat-aborted chat-aborted--error">⚠ {{ item.msg.error }}</div>
            <div class="chat-msg-time">
              {{ fmtTime(item.msg.ts) }}
              <template v-if="item.msg.model">· {{ item.msg.model }}</template>
            </div>
          </template>

          <!-- System (slash command output) -->
          <pre v-else-if="item.kind === 'system'" class="chat-system">{{ item.msg.text }}</pre>

          <!-- Summary -->
          <div v-else-if="item.kind === 'summary'" class="chat-summary">{{ item.msg.text }}</div>

          <!-- Custom (unrecognized roles) -->
          <template v-else>
            <div class="chat-msg-role">{{ roleLabel(item.msg) }}</div>
            <div v-if="renderMd" class="chat-msg-md" v-html="md(item.msg)" />
            <template v-else>{{ item.msg.text }}</template>
            <div class="chat-msg-time">{{ fmtTime(item.msg.ts) }}</div>
          </template>
        </div>
        <div v-if="streaming" class="chat-streaming-hint">pi is working…</div>
      </template>
    </div>

    <!-- Composer (hidden entirely when the session is locked by the TUI) -->
    <div class="chat-composer">
      <div v-if="session?.tuiActive" class="chat-banner chat-banner--tui" title="Click to recheck lock status" @click="store.refreshList()">🔒 Live in the pi TUI — this window is read-only. (click to recheck)</div>
      <div v-else-if="store.lastError" class="chat-banner chat-banner--error" @click="store.clearLastError()">
        ⚠ {{ store.lastError }} (click to dismiss)
      </div>
      <template v-if="!session?.tuiActive">
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
          placeholder="Message the pi agent…  (/ for commands, Enter to send, Shift+Enter for a new line)"
          @keydown="onKeydown"
          @input="autoGrow"
        />
        <button
          class="chat-send-btn"
          :disabled="!input.trim() || session?.status === 'running'"
          @click="send"
        >{{ session?.status === 'running' ? '…' : 'Send' }}</button>
      </template>
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
