<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  useChatStore, fmtCost, fmtDuration, fmtTime, fmtTokens,
  type ChatSession,
} from '../store/chat';

const store = useChatStore();

// Live clock — drives the duration ticker of a running session.
const now = ref(Date.now());
let timer: number | null = null;
onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer);
});

const session = computed<ChatSession | null>(
  () => (store.activeChatId ? store.findSession(store.activeChatId) ?? null : null),
);

interface StatRow { key: string; value: string; kind?: 'status' | 'view' }

function shortFile(file: string): string {
  return file.split('/').pop() ?? file;
}

const rows = computed<StatRow[]>(() => {
  const s = session.value;
  if (!s) return [];
  const end = s.status === 'running' ? now.value : Math.max(s.stats.lastActivity, s.stats.startedAt);
  const dur = Math.max(0, (end - s.stats.startedAt) / 1000);
  return [
    { key: 'Status', value: s.status, kind: 'status' },
    { key: 'Model', value: s.stats.model ?? '—' },
    { key: 'Working dir', value: s.cwd || '—' },
    { key: 'Tokens in', value: fmtTokens(s.stats.tokensIn) },
    { key: 'Tokens out', value: fmtTokens(s.stats.tokensOut) },
    { key: 'Total tokens', value: fmtTokens(s.stats.tokensIn + s.stats.tokensOut) },
    { key: 'Cost', value: fmtCost(s.stats.costUsd) },
    { key: 'Duration', value: fmtDuration(dur) },
    { key: 'Started', value: fmtTime(s.stats.startedAt) },
    { key: 'Last activity', value: fmtTime(s.stats.lastActivity) },
    { key: 'Messages', value: String(s.stats.messageCount) },
    { key: 'View', value: s.tuiActive ? 'TUI (read-only)' : store.isViewOpen(s.id) ? 'open' : 'closed', kind: 'view' },
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
        <div v-for="r in rows" :key="r.key" class="session-stats-row">
          <span class="session-stats-key">{{ r.key }}</span>
          <span
            v-if="r.kind === 'status'"
            class="session-stats-pill"
            :class="'session-stats-pill--' + r.value"
          >{{ r.value }}</span>
          <span
            v-else-if="r.kind === 'view'"
            class="session-stats-pill"
            :class="session.tuiActive ? 'session-stats-pill--tui' : (r.value === 'open' ? 'session-stats-pill--view' : 'session-stats-pill--bg')"
          >{{ r.value }}</span>
          <span v-else class="session-stats-val">{{ r.value }}</span>
        </div>
      </div>
    </template>
    <div v-else class="session-stats-empty">
      No chat window activated.<br />
      Open a chat from the Chat panel to see its session stats here.
    </div>
  </div>
</template>
