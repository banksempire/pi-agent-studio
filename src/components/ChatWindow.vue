<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
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

function isStreaming(): boolean {
  return session.value?.status === 'running' && lastMessage.value?.role === 'assistant';
}

function roleLabel(m: DisplayMessage): string {
  if (m.role === 'user') return 'You';
  if (m.role === 'assistant') return 'pi';
  if (m.role === 'summary') return 'summary';
  if (m.role === 'bash') return 'bash';
  if (m.role === 'system') return 'system';
  return 'custom';
}

// ── Collapsible blocks ─────────────────────────────────────────────────────

/** key → open state (thinking/args/result toggles) */
const openBlocks = ref<Record<string, boolean>>({});

function toggle(key: string) {
  openBlocks.value = { ...openBlocks.value, [key]: !openBlocks.value[key] };
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
          v-for="m in session.messages"
          :key="m.id"
          class="chat-msg"
          :class="[
            'chat-msg--' + m.role,
            { 'chat-msg--error': (m.role === 'assistant' && m.error) || (m.role === 'system' && m.isError) },
          ]"
        >
          <div class="chat-msg-role">{{ roleLabel(m) }}</div>

          <!-- System (slash command output) -->
          <pre v-if="m.role === 'system'" class="chat-system">{{ m.text }}</pre>

          <!-- Thinking (collapsible) -->
          <div
            v-else-if="m.role === 'assistant' && m.thinking"
            class="chat-thinking"
            @click="toggle('t-' + m.id)"
          >
            <span class="chat-thinking-toggle">{{ openBlocks['t-' + m.id] ? '▾' : '▸' }}</span>
            <span class="chat-thinking-label">thinking</span>
            <pre v-if="openBlocks['t-' + m.id]" class="chat-thinking-body">{{ m.thinking }}</pre>
          </div>

          <!-- Text -->
          <div v-if="m.text && m.role !== 'system'" class="chat-msg-text" :class="{ 'chat-msg-text--streaming': isStreaming() && m.id === lastMessage?.id }">
            {{ m.text }}<span v-if="isStreaming() && m.id === lastMessage?.id" class="chat-cursor">▌</span>
          </div>

          <!-- Tool calls -->
          <div v-if="m.role === 'assistant' && m.toolCalls?.length" class="chat-tools">
            <div v-for="tc in m.toolCalls" :key="tc.id" class="chat-tool">
              <div class="chat-tool-head" @click="toggle('a-' + tc.id)">
                <span class="chat-tool-icon">🔧</span>
                <span class="chat-tool-name">{{ tc.name }}</span>
                <span class="chat-tool-toggle">{{ openBlocks['a-' + tc.id] ? '▾' : '▸' }}</span>
                <span v-if="tc.result !== undefined" class="chat-tool-done" :class="{ 'chat-tool-done--error': tc.isError }">
                  {{ tc.isError ? '✗' : '✓' }}
                </span>
                <span v-else class="chat-tool-done chat-tool-done--pending">…</span>
              </div>
              <pre v-if="openBlocks['a-' + tc.id]" class="chat-tool-args">{{ tc.args || '{}' }}</pre>
              <div v-if="tc.result !== undefined" class="chat-tool-result" :class="{ 'chat-tool-result--error': tc.isError }">
                <div class="chat-tool-result-head" @click="toggle('r-' + tc.id)">
                  <span class="chat-tool-toggle">{{ openBlocks['r-' + tc.id] ? '▾' : '▸' }}</span>
                  <span class="chat-tool-result-label">{{ tc.isError ? 'error' : 'result' }}</span>
                </div>
                <pre v-if="openBlocks['r-' + tc.id]" class="chat-tool-result-body">{{ tc.result }}</pre>
              </div>
            </div>
          </div>

          <!-- Bash / summary / custom -->
          <pre v-else-if="m.role === 'bash'" class="chat-bash">{{ m.text }}</pre>
          <div v-else-if="m.role === 'summary'" class="chat-summary">{{ m.text }}</div>

          <div v-if="m.role === 'assistant' && m.stopReason === 'aborted'" class="chat-aborted">
            ⏹ generation aborted
          </div>
          <div v-if="m.role === 'assistant' && m.error" class="chat-aborted chat-aborted--error">
            ⚠ {{ m.error }}
          </div>

          <div v-if="m.role !== 'system'" class="chat-msg-time">
            {{ fmtTime(m.ts) }}
            <template v-if="m.role === 'assistant' && m.model">· {{ m.model }}</template>
          </div>
        </div>
        <div v-if="isStreaming()" class="chat-streaming-hint">pi is working…</div>
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
