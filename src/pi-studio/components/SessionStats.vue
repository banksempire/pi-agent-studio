<script setup lang="ts">
import { computed, ref } from 'vue';
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

interface StatRow {
  label: string;
  value: string;
  section?: boolean;
  /** mono font (File / ID / Working dir values) */
  mono?: boolean;
  /** hover tooltip (full untruncated value) */
  title?: string;
}

/** Index of the row whose value briefly shows "✓ Copied" after a click. */
const copiedIndex = ref<number | null>(null);
let copyTimer: number | undefined;

/** execCommand fallback — Edge/Chrome only expose navigator.clipboard in
 *  secure contexts (https or localhost); on http://<hostname> the API is
 *  absent, so the copy must go through a hidden textarea. */
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
  } catch { /* clipboard unavailable */ }
}

/** Click a stat row → copy "key: value" (full untruncated values) to the
 *  clipboard, with a transient ✓ feedback on the row. */
function copyRow(row: StatRow, index: number) {
  const text = `${row.label.trim()}: ${row.title ?? row.value}`;
  const done = () => {
    copiedIndex.value = index;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copiedIndex.value = null; }, 1200);
  };
  try {
    if (navigator.clipboard?.writeText) {
      // Clipboard API present (secure context) — but a rejected promise
      // (e.g. permission denied) still falls back to the textarea copy.
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
      return;
    }
  } catch { /* fall through to legacy */ }
  legacyCopy(text, done);
}

const rows = computed<StatRow[]>(() => {
  const s = session.value;
  if (!s) return [];
  const st = s.stats;
  const out: StatRow[] = [];
  const section = (label: string) => out.push({ label, value: '', section: true });
  const push = (label: string, value: string, extra?: Partial<StatRow>) => out.push({ label, value, ...extra });

  // ── General (first): File / ID / Working dir / Started / Last activity ──
  section('General');
  push('  File', shortFile.value, { mono: true, title: s.file });
  push('  ID', shortId.value, { mono: true, title: s.sessionId ?? s.file });
  push('  Working dir', s.cwd || '—', { mono: true, title: s.cwd });
  push('  Started', fmtDateTime(st.startedAt));
  push('  Last activity', fmtDateTime(st.lastActivity));

  // ── Messages (TUI /session) — sub-level rows carry leading spaces in
  // the key ("  calls") instead of CSS indentation. ──
  section('Messages');
  push('  Total', fmtTokens(st.messageCount));
  push('  User', fmtTokens(st.userMessages));
  push('  Assistant', fmtTokens(st.assistantMessages));
  push('  Tools', fmtTokens(st.toolResults));

  // ── Tokens ──
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

  // ── Cost (only when there is something to report) ──
  if (st.costUsd > 0 || st.cacheWaste.missedTokens > 0) {
    section('Cost');
    push('  Total', tuiCost(st.costUsd));
    // Per-model attribution (hidden when everything lands in one bucket).
    if (st.costBreakdown.length > 1) {
      for (const b of st.costBreakdown) {
        push(`  ${b.key}`, `${tuiCost(b.cost)} (${fmtCompactTokens(b.tokens)})`);
      }
    }
    if (st.cacheWaste.missedTokens > 0) {
      push('  Cache Re-billed', st.cacheWaste.missedCost >= 0.0001
        ? `${tuiCost(st.cacheWaste.missedCost)} (${fmtCompactTokens(st.cacheWaste.missedTokens)})`
        : `(${fmtCompactTokens(st.cacheWaste.missedTokens)})`);
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
              :class="{ 'session-stats-mono': row.mono, 'session-stats-value--copied': copiedIndex === i }"
              :title="row.title ?? ''"
            >{{ copiedIndex === i ? '✓ Copied' : row.value }}</span>
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
