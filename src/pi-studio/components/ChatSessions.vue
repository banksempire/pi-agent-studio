<script setup lang="ts">
import { computed } from 'vue';
import { type ChatSession, endExternalDrag, startSessionDrag, useChatStore } from '../store/chat';

const store = useChatStore();

const active = computed(() => store.activeSessions());

function badge(s: ChatSession): string {
  if (s.status === 'running') return store.isViewOpen(s.id) ? 'running' : 'running · bg';
  return store.isViewOpen(s.id) ? 'open' : 'idle';
}

function badgeClass(s: ChatSession): string {
  if (s.status === 'running') return 'running';
  return 'open';
}
</script>

<template>
  <div class="chat-list">
    <div v-if="active.length === 0" class="chat-list-empty">
      No active sessions. Sessions with an open window or a chat generating
      in the background appear here.
    </div>
    <div
      v-for="s in active"
      :key="s.id"
      class="chat-list-item"
      :class="{ 'chat-list-item--active': s.id === store.activeChatId }"
      :title="'Open chat window: ' + s.title"
      draggable="true"
      @click="store.openChat(s.id)"
      @dragstart="startSessionDrag($event, s)"
      @dragend="endExternalDrag"
    >
      <div class="chat-list-row1">
        <span class="chat-list-title">{{ s.title }}</span>
        <span class="chat-list-time">{{ s.stats.messageCount }} msgs</span>
      </div>
      <div class="chat-list-row2">
        <span class="chat-list-badge" :class="'chat-list-badge--' + badgeClass(s)">{{ badge(s) }}</span>
        <span class="chat-list-preview">{{ s.preview || s.title }}</span>
      </div>
    </div>
  </div>
</template>
