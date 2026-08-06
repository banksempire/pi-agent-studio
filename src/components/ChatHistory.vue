<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore, timeAgo, type ChatSession } from '../store/chat';

const store = useChatStore();

const sessions = computed(() =>
  [...store.sessions].sort((a, b) => b.lastActivity - a.lastActivity),
);

function preview(s: ChatSession): string {
  const t = (s.preview || s.title).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? t.slice(0, 56) + '…' : t;
}
</script>

<template>
  <div class="chat-list">
    <div v-if="store.backend === 'offline'" class="chat-list-empty">
      ⚠ Backend offline — start it with <code>npm run server</code> in pi-agent-studio.
      <div v-if="store.backendError" class="chat-list-error">{{ store.backendError }}</div>
    </div>
    <div v-else-if="sessions.length === 0" class="chat-list-empty">
      No chats yet — press Ctrl+N or click New Chat above to start one.
    </div>
    <div
      v-for="s in sessions"
      :key="s.id"
      class="chat-list-item"
      :class="{ 'chat-list-item--active': s.id === store.activeChatId }"
      :title="'Open chat window: ' + s.title"
      @click="store.openChat(s.id)"
    >
      <div class="chat-list-row1">
        <span class="chat-list-title">{{ s.title }}</span>
        <span class="chat-list-time">{{ timeAgo(s.lastActivity) }}</span>
      </div>
      <div class="chat-list-row2">
        <span class="chat-list-status" :class="'chat-list-status--' + s.status">
          {{ s.status === 'running' ? '⏳' : '' }}
        </span>
        <span class="chat-list-preview">{{ preview(s) }}</span>
      </div>
    </div>
  </div>
</template>
