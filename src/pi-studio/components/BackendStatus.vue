<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore } from '../store/chat';

/** Above this /api/health round-trip the dot turns yellow (high ping). */
const HIGH_PING_MS = 500;

const store = useChatStore();

/** 'ok' (green) | 'highping' (yellow) | 'err' (red). */
const dotClass = computed(() => {
  if (store.backend !== 'online') return 'status-backend-dot--err';
  return store.backendPing !== null && store.backendPing > HIGH_PING_MS
    ? 'status-backend-dot--highping'
    : 'status-backend-dot--ok';
});

const label = computed(() => {
  if (store.backend !== 'online') {
    return store.backend === 'connecting' ? 'pi agent · connecting…' : 'pi agent · offline';
  }
  // The live ping, refreshed every 5s (the store's fixed ping interval);
  // the dot color carries the status (green ≤500ms, yellow above).
  return store.backendPing !== null ? `pi agent · ${store.backendPing}ms` : 'pi agent · live';
});

const title = computed(() => {
  if (store.backend !== 'online') return 'Disconnected from the pi agent';
  const ping = store.backendPing !== null ? `${store.backendPing} ms` : '—';
  return `pi agent reachable (${ping})`;
});
</script>

<template>
  <span class="status-backend" :title="title">
    <span class="status-backend-dot" :class="dotClass" />
    {{ label }}
  </span>
</template>
