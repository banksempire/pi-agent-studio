<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  useChatStore, fmtCost, fmtDuration, fmtTime, fmtTokens,
  type ChatSession,
} from '../store/chat';
import KeyValueList from '@sf/components/KeyValueList.vue';
import type { KeyValueItem } from '@sf/types/panel';

const store = useChatStore();

const session = computed<ChatSession | null>(
  () => (store.activeChatId ? store.findSession(store.activeChatId) ?? null : null),
);

// Live clock — drives the duration ticker. Runs only while the activated
// session is generating (no point ticking for idle sessions).
const now = ref(Date.now());
let timer: number | null = null;
function tick() { now.value = Date.now(); }
watch(
  () => session.value?.status,
  (status) => {
    if (status === 'running' && timer === null) timer = window.setInterval(tick, 1000);
    else if (status !== 'running' && timer !== null) { window.clearInterval(timer); timer = null; }
  },
  { immediate: true },
);
onUnmounted(() => { if (timer !== null) window.clearInterval(timer); });

function shortFile(file: string): string {
  return file.split('/').pop() ?? file;
}

const rows = computed<KeyValueItem[]>(() => {
  const s = session.value;
  if (!s) return [];
  const end = s.status === 'running' ? now.value : Math.max(s.stats.lastActivity, s.stats.startedAt);
  const dur = Math.max(0, (end - s.stats.startedAt) / 1000);
  const viewOpen = store.isViewOpen(s.id);
  return [
    { key: 'Status', value: s.status, pill: true },
    { key: 'Working dir', value: s.cwd || '—' },
    { key: 'Tokens in', value: fmtTokens(s.stats.tokensIn) },
    { key: 'Tokens out', value: fmtTokens(s.stats.tokensOut) },
    { key: 'Total tokens', value: fmtTokens(s.stats.tokensIn + s.stats.tokensOut) },
    { key: 'Cost', value: fmtCost(s.stats.costUsd) },
    { key: 'Duration', value: fmtDuration(dur) },
    { key: 'Started', value: fmtTime(s.stats.startedAt) },
    { key: 'Last activity', value: fmtTime(s.stats.lastActivity) },
    { key: 'Messages', value: String(s.stats.messageCount) },
    { key: 'View', value: viewOpen ? 'open' : 'closed', pill: true, tone: viewOpen ? 'view' : 'bg' },
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
