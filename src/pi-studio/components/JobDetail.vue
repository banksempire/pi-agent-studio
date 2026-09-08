<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import type { KeyValueItem } from '@sf/types/panel';
import { computed } from 'vue';
import { cronToPattern, describeCron } from '../cronInfo';
import { fmtRelative, fmtTime } from '../jobText';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const job = computed(() => store.selectedJob);

const PATTERN_LABELS: Record<string, string> = {
  minutes: 'Minutes',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const rows = computed<KeyValueItem[]>(() => {
  const j = job.value;
  if (!j) return [];
  const list: KeyValueItem[] = [{ key: 'Job name', value: j.name }];
  const pattern = j.scheduleType === 'cron' && j.cron ? cronToPattern(j.cron) : null;
  if (j.scheduleType === 'once') {
    list.push({ key: 'Schedule', value: 'Once' });
    list.push({ key: 'Run at', value: `${fmtTime(j.runAt)} · ${fmtRelative(j.runAt)}` });
  } else if (j.scheduleType === 'nonpeak') {
    list.push({ key: 'Schedule', value: 'Advanced — off peak' });
    list.push({
      key: 'Off peak',
      value: `once a day at ${j.payload.model ?? '—'}’s first open moment`,
    });
  } else {
    list.push({
      key: 'Schedule',
      value: pattern ? `Periodic — ${PATTERN_LABELS[pattern.pattern] ?? pattern.pattern}` : 'Advanced — cron',
    });
  }
  if (j.cron) {
    const desc = describeCron(j.cron);
    list.push({ key: 'Cron', value: desc ? `${j.cron} (${desc})` : j.cron });
  }
  list.push({
    key: 'If missed',
    value: j.missedPolicy === 'skip' ? 'skip, wait for the next occurrence' : 'run once on catch-up',
  });
  list.push({
    key: 'Next run',
    value: j.enabled ? `${fmtTime(j.nextDue)} · ${fmtRelative(j.nextDue)}` : '—',
  });
  list.push({
    key: 'Last run',
    value: j.lastRun ? `${j.lastRun.status} ${fmtRelative(j.lastRun.finishedAt ?? j.lastRun.queuedAt)}` : '—',
  });
  const model = j.payload.model;
  list.push({
    key: 'Model override',
    value: model ? (j.payload.thinkLevel ? `${model}·${j.payload.thinkLevel}` : model) : 'Session default',
  });
  const t = j.payload.target;
  list.push({
    key: 'Session',
    value:
      t.mode === 'file'
        ? `Existing session — ${(t.sessionFile ?? '').split('/').pop()}`
        : t.mode === 'new'
          ? `Fresh per run — ${t.cwd ?? ''}`
          : `One per cwd — ${t.cwd ?? ''}`,
  });
  list.push({ key: 'Message', value: j.payload.message });
  return list;
});
</script>

<template>
  <div v-if="!job" class="job-detail-empty">Select a job in the table to see its details.</div>
  <div v-else class="job-detail">
    <KeyValueList :items="rows" />
  </div>
</template>

<style scoped>
.job-detail {
  box-sizing: border-box;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
}

.job-detail-empty {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}
</style>
