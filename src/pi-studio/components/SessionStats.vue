<script setup lang="ts">
import { computed } from 'vue';
import {
  useChatStore, fmtCost, fmtDateTime, fmtTokens,
  type ChatSession,
} from '../store/chat';
import KeyValueList from '@sf/components/KeyValueList.vue';
import type { KeyValueItem } from '@sf/types/panel';

const store = useChatStore();

const session = computed<ChatSession | null>(
  () => (store.activeChatId ? store.findSession(store.activeChatId) ?? null : null),
);

function shortFile(file: string): string {
  return file.split('/').pop() ?? file;
}

const rows = computed<KeyValueItem[]>(() => {
  const s = session.value;
  if (!s) return [];
  return [
    { key: 'Status', value: s.status, pill: true },
    { key: 'Working dir', value: s.cwd || '—' },
    { key: 'Tokens in', value: fmtTokens(s.stats.tokensIn) },
    { key: 'Tokens out', value: fmtTokens(s.stats.tokensOut) },
    { key: 'Total tokens', value: fmtTokens(s.stats.tokensIn + s.stats.tokensOut) },
    { key: 'Cost', value: fmtCost(s.stats.costUsd) },
    { key: 'Started', value: fmtDateTime(s.stats.startedAt) },
    { key: 'Last activity', value: fmtDateTime(s.stats.lastActivity) },
    { key: 'Messages', value: String(s.stats.messageCount) },
  ];
});
</script>

<template>
  <div class="session-stats">
    <template v-if="session">
      <div class="session-stats-head">
        <span class="chat-status-dot" :class="'chat-status-dot--' + session.status" />
        <span class="session-stats-title" :title="session.file">{{ session.title }}</span>
      </div>
      <div class="session-stats-file" :title="session.file">{{ shortFile(session.file) }}</div>
      <div class="session-stats-rows">
        <KeyValueList :items="rows" />
      </div>
    </template>
    <div v-else class="session-stats-empty">
      No chat window activated.<br />
      Open a chat from the Chat panel to see its session stats here.
    </div>
  </div>
</template>
