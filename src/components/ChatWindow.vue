<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
import {
  useChatStore, fmtTime, type ChatSession, type DisplayMessage,
} from '../store/chat';

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

// Re-run on new messages and on streaming text growth. The DOM must be
// updated before measuring, so scroll runs after the render flush.
watch(
  () => session.value?.messages.map((m) => m.text + (m.thinking ?? '')).join('\n') ?? '',
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
  return 'custom';
}

// ── Collapsible blocks ─────────────────────────────────────────────────────

/** key → open state (thinking/args/result toggles) */
const openBlocks = ref<Record<string, boolean>>({});

function toggle(key: string) {
  openBlocks.value = { ...openBlocks.value, [key]: !openBlocks.value[key] };
}

// ── Composer ───────────────────────────────────────────────────────────────

function send() {
  const text = input.value.trim();
  if (!text || !session.value) return;
  store.clearLastError();
  void store.sendMessage(props.sessionId, text);
  input.value = '';
  sticky = true;
  nextTick(scrollToBottom);
  inputEl.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
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
        No messages yet — say hello.
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
            { 'chat-msg--error': m.role === 'assistant' && m.error },
          ]"
        >
          <div class="chat-msg-role">{{ roleLabel(m) }}</div>

          <!-- Thinking (collapsible) -->
          <div
            v-if="m.role === 'assistant' && m.thinking"
            class="chat-thinking"
            @click="toggle('t-' + m.id)"
          >
            <span class="chat-thinking-toggle">{{ openBlocks['t-' + m.id] ? '▾' : '▸' }}</span>
            <span class="chat-thinking-label">thinking</span>
            <pre v-if="openBlocks['t-' + m.id]" class="chat-thinking-body">{{ m.thinking }}</pre>
          </div>

          <!-- Text -->
          <div v-if="m.text" class="chat-msg-text" :class="{ 'chat-msg-text--streaming': isStreaming() && m.id === lastMessage?.id }">
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

          <div class="chat-msg-time">
            {{ fmtTime(m.ts) }}
            <template v-if="m.role === 'assistant' && m.model">· {{ m.model }}</template>
          </div>
        </div>
        <div v-if="isStreaming()" class="chat-streaming-hint">pi is working…</div>
      </template>
    </div>

    <!-- Composer -->
    <div class="chat-composer">
      <div v-if="session?.tuiActive" class="chat-banner">🔒 Live in the pi TUI — this window is read-only.</div>
      <div v-else-if="store.lastError" class="chat-banner chat-banner--error" @click="store.clearLastError()">
        ⚠ {{ store.lastError }} (click to dismiss)
      </div>
      <textarea
        ref="inputEl"
        v-model="input"
        class="chat-input"
        rows="1"
        :disabled="session?.tuiActive"
        placeholder="Message the pi agent…  (Enter to send, Shift+Enter for a new line)"
        @keydown="onKeydown"
        @input="autoGrow"
      />
      <button
        class="chat-send-btn"
        :disabled="!input.trim() || session?.status === 'running' || session?.tuiActive"
        @click="send"
      >{{ session?.status === 'running' ? '…' : 'Send' }}</button>
    </div>
  </div>
</template>
