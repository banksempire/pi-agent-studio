<script setup lang="ts">
import type { ChatSession } from '../store/chat';
import { useChatStore } from '../store/chat';

const props = defineProps<{ s: ChatSession; active: boolean }>();
const emit = defineEmits<{
  (e: 'open'): void;
  (e: 'dragstart', ev: DragEvent): void;
  (e: 'dragend'): void;
}>();

const store = useChatStore();

function stateOf(): string {
  return store.syncStateOf(props.s)?.state ?? 'open';
}

function badge(): string {
  const st = stateOf();
  if (st === 'working') return store.isViewOpen(props.s.id) ? 'working' : 'working · bg';
  return st;
}

function rowTitle(): string {
  const info = store.syncStateOf(props.s);
  const err = info?.state === 'error' && info.error ? `\n${info.error}` : '';
  return `Open chat window: ${props.s.title}${err}`;
}

function errorOf(): string {
  const info = store.syncStateOf(props.s);
  return info?.state === 'error' ? info.error || 'error' : '';
}
</script>

<template>
  <div
    class="chat-list-item"
    :class="{ 'chat-list-item--active': props.active }"
    :title="rowTitle()"
    draggable="true"
    @click="emit('open')"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend')"
  >
    <div class="chat-list-row1">
      <span class="chat-list-title">{{ props.s.title }}</span>
      <span class="chat-list-time">{{ props.s.stats.messageCount }} msgs</span>
    </div>
    <div class="chat-list-row2">
      <span class="chat-list-badge" :class="'chat-list-badge--' + stateOf()">{{ badge() }}</span>
      <span class="chat-list-preview">{{ errorOf() || props.s.preview || props.s.title }}</span>
    </div>
  </div>
</template>
