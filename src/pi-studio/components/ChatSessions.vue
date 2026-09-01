<script setup lang="ts">
import { kMobilePanelDismiss } from '@sf/composables/useWorkspace';
import { computed, inject } from 'vue';
import { type ChatSession, endExternalDrag, startSessionDrag, useChatStore } from '../store/chat';
import ChatSessionsRow from './ChatSessionsRow.vue';

const store = useChatStore();
const dismissMobilePanel = inject<(() => void) | null>(kMobilePanelDismiss, null);

function open(s: ChatSession) {
  store.openChat(s.id);
  dismissMobilePanel?.();
}

const list = computed(() =>
  store.syncedSessions().filter((s) => store.stateFilter[store.syncStateOf(s)?.state ?? 'open']),
);
</script>

<template>
  <div class="chat-list">
    <div v-if="list.length === 0" class="chat-list-empty">
      No sessions in this view. Sessions that are working, unread, in error, or open elsewhere
      appear here — adjust the status filter (▾ on the title bar).
    </div>
    <ChatSessionsRow
      v-for="s in list"
      :key="s.id"
      :s="s"
      :active="s.id === store.activeChatId"
      @open="open(s)"
      @dragstart="startSessionDrag($event, s)"
      @dragend="endExternalDrag"
    />
  </div>
</template>
