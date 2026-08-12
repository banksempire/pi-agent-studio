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
  if (store.backend === 'online') {
    return store.backendPing !== null && store.backendPing > HIGH_PING_MS
      ? 'pi agent · high ping'
      : 'pi agent · live';
  }
  return store.backend === 'connecting' ? 'pi agent · connecting…' : 'pi agent · offline';
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
