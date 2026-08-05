<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  useChatStore, costOf, durationSec, fmtCost, fmtDuration, fmtTokens, timeAgo,
  type ChatSession,
} from '../store/chat';

const store = useChatStore();

// Live clock — drives the duration/cost/token tickers of a running session.
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

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

interface StatRow { key: string; value: string; kind?: 'status' | 'view' }

const rows = computed<StatRow[]>(() => {
  const s = session.value;
  if (!s) return [];
  return [
    { key: 'Session', value: s.id.slice(0, 18) + '…' },
    { key: 'Status', value: s.status, kind: 'status' },
    { key: 'Model', value: s.stats.model },
    { key: 'Tokens in', value: fmtTokens(s.stats.tokensIn) },
    { key: 'Tokens out', value: fmtTokens(s.stats.tokensOut) },
    { key: 'Total tokens', value: fmtTokens(s.stats.tokensIn + s.stats.tokensOut) },
    { key: 'Cost', value: fmtCost(costOf(s)) },
    { key: 'Duration', value: fmtDuration(durationSec(s)) },
    { key: 'Started', value: fmtClock(s.stats.startedAt) },
    { key: 'Last activity', value: timeAgo(s.stats.lastActivity) },
    { key: 'View', value: store.isViewOpen(s.id) ? 'open' : 'closed · runs in background', kind: 'view' },
  ];
});

function statusLabel(status: string): string {
  return status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'idle';
}
</script>

<template>
  <div class="session-stats">
    <template v-if="session">
      <div class="session-stats-head">
        <span class="chat-status-dot" :class="'chat-status-dot--' + session.status" />
        <span class="session-stats-title">{{ session.title }}</span>
      </div>
      <div class="session-stats-rows">
        <div v-for="r in rows" :key="r.key" class="session-stats-row">
          <span class="session-stats-key">{{ r.key }}</span>
          <span
            v-if="r.kind === 'status'"
            class="session-stats-pill"
            :class="'session-stats-pill--' + statusLabel(r.value)"
          >{{ r.value }}</span>
          <span
            v-else-if="r.kind === 'view'"
            class="session-stats-pill"
            :class="'session-stats-pill--' + (session.status === 'running' && r.value.startsWith('closed') ? 'bg' : 'view')"
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
