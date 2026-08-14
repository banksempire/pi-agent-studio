<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore } from '../store/chat';

/** Above this /api/health round-trip the dot turns yellow (high ping). */
const HIGH_PING_MS = 500;

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
</script>

<template>
  <span class="status-backend" :title="title">
    <span class="status-backend-dot" :class="dotClass" />
    {{ label }}
  </span>
</template>
