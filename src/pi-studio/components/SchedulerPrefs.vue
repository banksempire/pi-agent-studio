<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import type { KeyValueItem } from '@sf/types/panel';
import { computed } from 'vue';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const rows = computed<KeyValueItem[]>(() => {
  const s = store.scheduler;
  if (!s) return [];
  return [
    {
      key: 'Concurrency',
      value: `${s.limits.globalMax} global · ${s.limits.providerMax} per provider · ${s.limits.modelMax} per model`,
    },
    { key: 'Running', value: String(s.running) },
    { key: 'Waiting', value: String(s.waiting) },
  ];
});
</script>

<template>
  <div class="scheduler-prefs">
    <KeyValueList :items="rows" />
    <div class="scheduler-prefs-note">
      Caps are configured via the PI_STUDIO_SCHED_GLOBAL_MAX, PI_STUDIO_SCHED_PROVIDER_MAX and
      PI_STUDIO_SCHED_MODEL_MAX environment variables.
    </div>
  </div>
</template>

<style scoped>
.scheduler-prefs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}

.scheduler-prefs-note {
  padding: 0 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}
</style>
