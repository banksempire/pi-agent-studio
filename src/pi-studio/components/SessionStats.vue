<script setup lang="ts">
import { computed } from 'vue';
import {
  useChatStore, fmtDateTime, fmtTokens, fmtCompactTokens,
  type ChatSession,
} from '../store/chat';

const store = useChatStore();

const session = computed<ChatSession | null>(
  () => (store.activeChatId ? store.findSession(store.activeChatId) ?? null : null),
);

/** Middle-truncate the full session-file path (the TUI prints it whole;
 *  the panel keeps a readable head + the session filename). */
function truncateMiddle(text: string, head: number, tail: number): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

const shortFile = computed(() => session.value ? truncateMiddle(session.value.file, 34, 34) : '');
const shortId = computed(() => {
  const id = session.value?.sessionId;
  if (!id) return '—';
  return id.length > 16 ? `${id.slice(0, 13)}…` : id;
});

/** TUI /session cost formatting: always three decimals ($2.521). */
function tuiCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

interface StatRow { label: string; value: string; sub?: boolean; }

const rows = computed<StatRow[]>(() => {
  const s = session.value;
  if (!s) return [];
  const st = s.stats;
  const out: StatRow[] = [];
  const push = (label: string, value: string, sub = false) => out.push({ label, value, sub });

  // ── Messages (TUI /session) ──
  push('Messages', '');
  push('Total', fmtTokens(st.messageCount), true);
  push('User', fmtTokens(st.userMessages), true);
  push('Assistant', fmtTokens(st.assistantMessages), true);
  push('Tools', `${fmtTokens(st.toolCalls)} calls, ${fmtTokens(st.toolResults)} results`, true);

  // ── Tokens ──
  push('Tokens', '');
  push('Input', fmtTokens(st.promptTokens), true);
  if (st.promptTokens > 0 && (st.cacheRead > 0 || st.cacheWrite > 0)) {
    const hit = ((st.cacheRead / st.promptTokens) * 100).toFixed(1);
    push('Cached', `${fmtTokens(st.cacheRead)} (${hit}%)`, true);
    const written = st.cacheWrite > 0 ? ` (${fmtTokens(st.cacheWrite)} written to cache)` : '';
    push('Uncached', `${fmtTokens(st.tokensIn + st.cacheWrite)}${written}`, true);
  }
  push('Output', fmtTokens(st.tokensOut), true);
  push('Total', fmtTokens(st.promptTokens + st.tokensOut), true);

  // ── Cost (only when there is something to report) ──
  if (st.costUsd > 0 || st.cacheWaste.missedTokens > 0) {
    push('Cost', '');
    push('Total', tuiCost(st.costUsd), true);
    // Per-model attribution (hidden when everything lands in one bucket).
    if (st.costBreakdown.length > 1) {
      for (const b of st.costBreakdown) {
        push(b.key, `${tuiCost(b.cost)} (${fmtCompactTokens(b.tokens)} tokens)`, true);
      }
    }
    if (st.cacheWaste.missedTokens > 0) {
      const misses = st.cacheWaste.missCount === 1 ? '1 miss' : `${st.cacheWaste.missCount} misses`;
      const detail = `${fmtTokens(st.cacheWaste.missedTokens)} tokens, ${misses}`;
      push('Cache Re-billed',
        st.cacheWaste.missedCost >= 0.0001 ? `${tuiCost(st.cacheWaste.missedCost)} (${detail})` : detail,
        true);
    }
  }

  // ── Old-stat rows that stay ──
  push('Started', fmtDateTime(st.startedAt));
  push('Last activity', fmtDateTime(st.lastActivity));
  return out;
});
</script>

<template>
  <div class="session-stats">
    <template v-if="session">
      <div class="session-stats-head">
        <span class="chat-status-dot" :class="'chat-status-dot--' + session.status" />
        <span class="session-stats-title" :title="session.file">{{ session.title }}</span>
      </div>
      <div class="session-stats-rows">
        <div class="session-stats-field">
          <span>File</span>
          <span class="session-stats-mono" :title="session.file">{{ shortFile }}</span>
        </div>
        <div class="session-stats-field">
          <span>ID</span>
          <span class="session-stats-mono" :title="session.sessionId ?? session.file">{{ shortId }}</span>
        </div>
        <div class="session-stats-field">
          <span>Working dir</span>
          <span class="session-stats-mono" :title="session.cwd">{{ session.cwd || '—' }}</span>
        </div>
        <template v-for="(row, i) in rows" :key="i">
          <div v-if="!row.value" class="session-stats-section">{{ row.label }}</div>
          <div v-else class="session-stats-row" :class="{ 'session-stats-row--sub': row.sub }">
            <span class="session-stats-key">{{ row.label }}</span>
            <span class="session-stats-value">{{ row.value }}</span>
          </div>
        </template>
      </div>
    </template>
    <div v-else class="session-stats-empty">
      No chat window activated.<br />
      Open a chat from the Chat panel to see its session stats here.
    </div>
  </div>
</template>
