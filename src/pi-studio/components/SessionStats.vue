<script setup lang="ts">
import { computed, ref } from 'vue';
import { type ChatSession, fmtCompactTokens, fmtDateTime, fmtTokens, useChatStore } from '../store/chat';

const store = useChatStore();

const session = computed<ChatSession | null>(() =>
  store.activeChatId ? (store.findSession(store.activeChatId) ?? null) : null,
);

function truncateMiddle(text: string, head: number, tail: number): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

const shortFile = computed(() => (session.value ? truncateMiddle(session.value.file, 34, 34) : ''));
const shortId = computed(() => {
  const id = session.value?.sessionId;
  if (!id) return '—';
  return id.length > 16 ? `${id.slice(0, 13)}…` : id;
});

function tuiCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

interface StatRow {
  label: string;
  value: string;
  section?: boolean;
  title?: string;
}

const copiedIndex = ref<number | null>(null);
let copyTimer: number | undefined;

function legacyCopy(text: string, done: () => void) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch {}
}

function copyRow(row: StatRow, index: number) {
  const text = `${row.label.trim()}: ${row.title ?? row.value}`;
  const done = () => {
    copiedIndex.value = index;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copiedIndex.value = null;
    }, 1200);
  };
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(done)
        .catch(() => legacyCopy(text, done));
      return;
    }
  } catch {}
  legacyCopy(text, done);
}

const rows = computed<StatRow[]>(() => {
  const s = session.value;
  if (!s) return [];
  const st = s.stats;
  const out: StatRow[] = [];
  const section = (label: string) => out.push({ label, value: '', section: true });
  const push = (label: string, value: string, extra?: Partial<StatRow>) =>
    out.push({ label, value, ...extra });

  section('General');
  push('  File', shortFile.value, { title: s.file });
  push('  ID', shortId.value, { title: s.sessionId ?? s.file });
  push('  Working dir', s.cwd || '—', { title: s.cwd });
  push('  Started', fmtDateTime(st.startedAt));
  push('  Last activity', fmtDateTime(st.lastActivity));

  section('Messages');
  push('  Total', fmtTokens(st.messageCount));
  push('  User', fmtTokens(st.userMessages));
  push('  Assistant', fmtTokens(st.assistantMessages));
  push('  Tools', fmtTokens(st.toolResults));

  section('Tokens');
  push('  Input', fmtTokens(st.promptTokens));
  if (st.promptTokens > 0 && (st.cacheRead > 0 || st.cacheWrite > 0)) {
    const hit = ((st.cacheRead / st.promptTokens) * 100).toFixed(1);
    push('  Cached', fmtTokens(st.cacheRead));
    push('    rate%', `${hit}%`);
    const written = st.cacheWrite > 0 ? ` (${fmtTokens(st.cacheWrite)} written to cache)` : '';
    push('  Uncached', `${fmtTokens(st.tokensIn + st.cacheWrite)}${written}`);
  }
  push('  Output', fmtTokens(st.tokensOut));
  push('  Total', fmtTokens(st.promptTokens + st.tokensOut));

  if (st.costUsd > 0 || st.cacheWaste.missedTokens > 0) {
    section('Cost');
    push('  Total', tuiCost(st.costUsd));
    if (st.costBreakdown.length > 1) {
      for (const b of st.costBreakdown) {
        push(`  ${b.key}`, `${tuiCost(b.cost)} (${fmtCompactTokens(b.tokens)})`);
      }
    }
    if (st.cacheWaste.missedTokens > 0) {
      push(
        '  Cache Re-billed',
        st.cacheWaste.missedCost >= 0.0001
          ? `${tuiCost(st.cacheWaste.missedCost)} (${fmtCompactTokens(st.cacheWaste.missedTokens)})`
          : `(${fmtCompactTokens(st.cacheWaste.missedTokens)})`,
      );
    }
  }
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
        <template v-for="(row, i) in rows" :key="i">
          <div v-if="row.section" class="session-stats-section">{{ row.label }}</div>
          <div
            v-else
            class="session-stats-row"
            :title="'Click to copy: ' + row.label.trim() + ': ' + (row.title ?? row.value)"
            @click="copyRow(row, i)"
          >
            <span class="session-stats-key">{{ row.label }}</span>
            <span
              class="session-stats-value"
              :class="{ 'session-stats-value--copied': copiedIndex === i }"
              :title="row.title ?? ''"
            >{{ copiedIndex === i ? 'Copied' : row.value }}</span>
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
