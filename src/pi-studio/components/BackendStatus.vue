<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useChatStore } from '../store/chat';

/** Above this /api/health round-trip the dot turns yellow (high ping). */
const HIGH_PING_MS = 500;
/** The latency popup's rolling window (matches the store's sample window). */
const WINDOW_MS = 5 * 60_000;

const store = useChatStore();

/** 'ok' (green) | 'highping' (yellow) | 'err' (red). */
const dotClass = computed(() => {
  if (store.backend !== 'online') return 'status-backend-dot--err';
  if (store.backendLost) return 'status-backend-dot--highping';
  return store.backendPing !== null && store.backendPing > HIGH_PING_MS
    ? 'status-backend-dot--highping'
    : 'status-backend-dot--ok';
});

const label = computed(() => {
  if (store.backend !== 'online') {
    return store.backend === 'connecting' ? 'connecting…' : 'offline';
  }
  // The latest heartbeat got no answer in time — report the lost packet
  // instead of a stale number (the late answer is discarded as lost, it
  // never shows up as an enormous ping).
  if (store.backendLost) return 'lost';
  // The live ping, refreshed every 5s (the store's fixed ping interval);
  // the dot color carries the status (green ≤500ms, yellow above).
  return store.backendPing !== null ? `${store.backendPing}ms` : 'live';
});

const title = computed(() => {
  if (store.backend !== 'online') return 'Disconnected from the pi agent';
  const ping = store.backendPing !== null ? `${store.backendPing} ms` : '—';
  return store.backendLost
    ? `pi agent reachable (last heartbeat lost — no response within 3s; last good ping ${ping})`
    : `pi agent reachable (${ping})`;
});

// ── Click-to-open latency popup ───────────────────────────────────────────

const open = ref(false);

function onDocClick(e: MouseEvent) {
  if (!(e.target instanceof Element) || !e.target.closest('.status-backend')) {
    open.value = false;
  }
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false;
}
watch(open, (v) => {
  if (v) {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onEsc);
  } else {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onEsc);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onEsc);
});

const stats = computed(() => {
  const now = performance.now();
  const windowSamples = store.pingSamples.filter((s) => now - s.t <= WINDOW_MS);
  const good = windowSamples
    .filter((s) => s.ms !== null)
    .map((s) => s.ms as number)
    .sort((a, b) => a - b);
  const total = windowSamples.length;
  const lost = total - good.length;
  const fmt = (n: number) => `${Math.round(n)}ms`;
  if (total === 0) return { avg: '—', p95: '—', max: '—', loss: '—', count: 0 };
  const pct = (lost / total) * 100;
  return {
    avg: good.length > 0 ? fmt(good.reduce((a, b) => a + b, 0) / good.length) : '—',
    p95: good.length > 0 ? fmt(good[Math.max(0, Math.ceil(good.length * 0.95) - 1)]) : '—',
    max: good.length > 0 ? fmt(good[good.length - 1]) : '—',
    loss: Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`,
    count: total,
  };
});
</script>

<template>
  <span class="status-backend" :title="title" @click.stop="open = !open">
    <span class="status-backend-dot" :class="dotClass" />
    <span class="status-backend-label">{{ label }}</span>
    <div v-if="open" class="status-backend-pop" @click.stop>
      <div class="status-backend-pop-title">Latency · last 5 minutes</div>
      <div class="status-backend-pop-row"><span>average ping</span><span>{{ stats.avg }}</span></div>
      <div class="status-backend-pop-row"><span>95% ping</span><span>{{ stats.p95 }}</span></div>
      <div class="status-backend-pop-row"><span>largest ping</span><span>{{ stats.max }}</span></div>
      <div class="status-backend-pop-row"><span>loss rate</span><span>{{ stats.loss }}</span></div>
      <div class="status-backend-pop-foot">
        {{ stats.count }} probe{{ stats.count === 1 ? '' : 's' }} · one every 5s
      </div>
    </div>
  </span>
</template>
