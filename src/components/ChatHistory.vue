<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore, timeAgo, type ChatSession } from '../store/chat';

const store = useChatStore();

const sessions = computed(() =>
  [...store.sessions].sort((a, b) => b.createdAt - a.createdAt),
);

function preview(s: ChatSession): string {
  const last = s.messages[s.messages.length - 1];
  if (!last) return 'No messages yet';
  const text = last.text.replace(/\s+/g, ' ').trim();
  return text.length > 56 ? text.slice(0, 56) + '…' : text;
}
</script>

<template>
  <div class="chat-list">
    <div v-if="sessions.length === 0" class="chat-list-empty">
      No chats yet — press ➕ or Ctrl+N to start one.
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
        <span class="chat-list-time">{{ timeAgo(s.stats.lastActivity) }}</span>
      </div>
      <div class="chat-list-row2">
        <span class="chat-list-status" :class="'chat-list-status--' + s.status">
          {{ s.status === 'running' ? '⏳' : s.status === 'stopped' ? '⏸' : '' }}
        </span>
        <span class="chat-list-preview">{{ preview(s) }}</span>
      </div>
    </div>
  </div>
</template>
