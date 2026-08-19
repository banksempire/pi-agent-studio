<script setup lang="ts">
import { computed } from 'vue';
import {
  type ChatSession,
  endExternalDrag,
  type SessionSyncState,
  startSessionDrag,
  useChatStore,
} from '../store/chat';

const store = useChatStore();

const FILTERS: SessionSyncState[] = ['working', 'unread', 'error', 'open'];

const list = computed(() =>
  store.syncedSessions().filter((s) => store.stateFilter[store.syncStateOf(s)?.state ?? 'open']),
);

function stateOf(s: ChatSession): SessionSyncState {
  return store.syncStateOf(s)?.state ?? 'open';
}

function badge(s: ChatSession): string {
  const st = stateOf(s);
  if (st === 'working') return store.isViewOpen(s.id) ? 'working' : 'working · bg';
  return st;
}

function badgeClass(s: ChatSession): string {
  return stateOf(s);
}

function rowTitle(s: ChatSession): string {
  const info = store.syncStateOf(s);
  const err = info?.state === 'error' && info.error ? `\n${info.error}` : '';
  return `Open chat window: ${s.title}${err}`;
}

function errorOf(s: ChatSession): string {
  const info = store.syncStateOf(s);
  return info?.state === 'error' ? info.error || 'error' : '';
}
</script>

<template>
  <div class="chat-list">
    <div class="chat-state-filter">
      <button
        v-for="f in FILTERS"
        :key="f"
        class="chat-state-chip"
        :class="['chat-state-chip--' + f, { 'chat-state-chip--off': !store.stateFilter[f] }]"
        :title="(store.stateFilter[f] ? 'Show ' : 'Hide ') + f + ' sessions'"
        @click="store.toggleStateFilter(f)"
      >
        {{ f }}
      </button>
    </div>
    <div v-if="list.length === 0" class="chat-list-empty">
      No sessions in this view. Sessions that are working, unread, in error, or open
      elsewhere appear here — toggle the filters above.
    </div>
    <div
      v-for="s in list"
      :key="s.id"
      class="chat-list-item"
      :class="{ 'chat-list-item--active': s.id === store.activeChatId }"
      :title="rowTitle(s)"
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
        <span class="chat-list-preview">{{ errorOf(s) || s.preview || s.title }}</span>
      </div>
    </div>
  </div>
</template>
