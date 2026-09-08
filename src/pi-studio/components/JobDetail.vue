<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import type { KeyValueItem } from '@sf/types/panel';
import { computed } from 'vue';
import { describeCron } from '../cronInfo';
import { fmtRelative, fmtTime, scheduleText, targetText } from '../jobText';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const job = computed(() => store.selectedJob);

const rows = computed<KeyValueItem[]>(() => {
  const j = job.value;
  if (!j) return [];
  const list: KeyValueItem[] = [
    { key: 'Name', value: j.name },
    {
      key: 'Status',
      value: j.enabled ? 'active' : 'paused',
      pill: true,
      tone: j.enabled ? 'ok' : 'muted',
    },
    { key: 'Schedule', value: scheduleText(j) },
  ];
  const desc = j.cron ? describeCron(j.cron) : '';
  if (desc) list.push({ key: 'Repeats', value: desc });
  list.push({
    key: 'Next run',
    value: j.enabled ? `${fmtTime(j.nextDue)} · ${fmtRelative(j.nextDue)}` : '—',
  });
  list.push({
    key: 'Last run',
    value: j.lastRun ? `${j.lastRun.status} ${fmtRelative(j.lastRun.finishedAt ?? j.lastRun.queuedAt)}` : '—',
  });
  list.push({ key: 'Target', value: targetText(j) });
  const model = j.payload.model;
  list.push({
    key: 'Model',
    value: model ? (j.payload.thinkLevel ? `${model}·${j.payload.thinkLevel}` : model) : 'session default',
  });
  if (j.scheduleType !== 'once') {
    list.push({
      key: 'Missed runs',
      value: j.missedPolicy === 'skip' ? 'skip, wait for the next occurrence' : 'run once on catch-up',
    });
  }
  list.push({ key: 'Created', value: `${fmtTime(j.createdAt)} · by ${j.createdBy || '—'}` });
  list.push({ key: 'ID', value: j.id });
  return list;
});
</script>

<template>
  <div v-if="!job" class="job-detail-empty">Select a job in the table to see its details.</div>
  <div v-else class="job-detail">
    <KeyValueList :items="rows" />
    <div class="job-detail-msg">
      <span class="job-detail-msg-label">Message</span>
      <p class="job-detail-msg-text">{{ job.payload.message }}</p>
    </div>
  </div>
</template>

<style scoped>
.job-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
}

.job-detail-empty {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.job-detail-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.job-detail-msg-label {
  color: var(--sf-text-muted);
  font-size: 16px;
}

.job-detail-msg-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 16px;
}
</style>
