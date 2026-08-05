<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useChatStore, fmtTime, type ChatMessage, type ChatRole } from '../store/chat';

const props = defineProps<{ sessionId: string }>();
const store = useChatStore();

const session = computed(() => store.findSession(props.sessionId));
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
}

// Re-run on new messages and on streaming text growth.
watch(
  () => session.value?.messages.map((m) => m.text).join('\n') ?? '',
  () => { if (sticky) scrollToBottom(); },
);

const lastMessage = computed<ChatMessage | undefined>(() => {
  const msgs = session.value?.messages ?? [];
  return msgs[msgs.length - 1];
});

function isStreaming(msg: ChatMessage): boolean {
  return session.value?.status === 'running' && lastMessage.value?.id === msg.id && msg.role === 'assistant';
}

function roleLabel(role: ChatRole): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'pi';
  return 'system';
}

function send() {
  const text = input.value.trim();
  if (!text || !session.value) return;
  store.sendMessage(props.sessionId, text);
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
        <span class="chat-title-text">{{ session?.title ?? 'Session' }}</span>
      </div>
      <div class="chat-header-right">
        <span class="chat-model">{{ session?.stats.model }}</span>
        <button
          v-if="session?.status === 'running'"
          class="chat-stop-btn"
          title="Stop generating (the session stays open)"
          @click="store.stopSession(props.sessionId)"
        >■ Stop</button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="listEl" class="chat-messages" @scroll="onScroll">
      <div v-if="!session" class="chat-empty">Session not found.</div>
      <template v-else>
        <div
          v-for="m in session.messages"
          :key="m.id"
          class="chat-msg"
          :class="'chat-msg--' + m.role"
        >
          <div class="chat-msg-role">{{ roleLabel(m.role) }}</div>
          <div class="chat-msg-text">
            {{ m.text }}<span v-if="isStreaming(m)" class="chat-cursor">▌</span>
          </div>
          <div class="chat-msg-time">{{ fmtTime(m.ts) }}</div>
        </div>
        <div v-if="session.status === 'running'" class="chat-streaming-hint">pi is generating…</div>
      </template>
    </div>

    <!-- Composer -->
    <div class="chat-composer">
      <textarea
        ref="inputEl"
        v-model="input"
        class="chat-input"
        rows="1"
        placeholder="Message the pi agent…  (Enter to send, Shift+Enter for a new line)"
        @keydown="onKeydown"
        @input="autoGrow"
      />
      <button class="chat-send-btn" :disabled="!input.trim()" @click="send">Send</button>
    </div>
  </div>
</template>
