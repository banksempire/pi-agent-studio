<script setup lang="ts">
import Table from '@sf/components/Table.vue';
import type { TableColumn } from '@sf/types/table';
import { computed, ref, watch } from 'vue';
import { fmtRelative, fmtTime } from '../jobText';
import type { JobRunInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const runs = ref<JobRunInfo[]>([]);
const busy = ref(false);
const error = ref('');

const columns: TableColumn[] = [
  { key: 'status', label: 'Status', min: 48, mobile: 'lead' },
  { key: 'time', label: 'Queued', min: 56, mobile: 'sub' },
  { key: 'session', label: 'Session', min: 60, mobile: 'title' },
  { key: 'error', label: 'Error', min: 60 },
];

const displayRows = computed(() =>
  runs.value.map((r) => ({
    id: r.id,
    status: r.status,
    time: fmtRelative(r.queuedAt),
    timeAbs: fmtTime(r.queuedAt),
    session: r.sessionFile ? r.sessionFile.split('/').pop() : '—',
    sessionFile: r.sessionFile,
    error: r.error,
  })),
);

async function load() {
  const job = store.selectedJob;
  if (!job) {
    runs.value = [];
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    runs.value = await store.fetchJobRuns(job.id);
  } catch (err) {
    if (!(err instanceof TypeError)) error.value = String((err as Error)?.message ?? err);
    runs.value = [];
  } finally {
    busy.value = false;
  }
}

watch(
  () => store.selectedJob?.id ?? null,
  (id) => {
    if (id) void load();
    else {
      runs.value = [];
      error.value = '';
      busy.value = false;
    }
  },
  { immediate: true },
);

function rowClass(row: Record<string, unknown>): Record<string, boolean> {
  return { [`job-history-row--${String(row.status)}`]: true };
}
</script>

<template>
  <div class="job-history">
    <div v-if="!store.selectedJob" class="job-history-empty">Select a job to see its run history.</div>
    <div v-else-if="busy" class="job-history-empty">loading…</div>
    <div v-else-if="error" class="job-history-empty job-history-err">{{ error }}</div>
    <Table
      v-else
      :columns="columns"
      :rows="displayRows"
      row-key="id"
      :row-class="rowClass"
      :resizable="false"
      empty-text="no runs yet"
    >
      <template #cell-status="{ row }">
        <span class="job-history-status" :class="'job-history-status--' + row.status">{{ row.status }}</span>
      </template>
      <template #cell-time="{ row }">
        <span class="job-history-time" :title="String(row.timeAbs)">{{ row.time }}</span>
      </template>
      <template #cell-session="{ row }">
        <span class="job-history-session" :title="String(row.sessionFile)">{{ row.session }}</span>
      </template>
      <template #cell-error="{ row }">
        <span v-if="row.error" class="job-history-error" :title="String(row.error)">{{ row.error }}</span>
        <span v-else>—</span>
      </template>
    </Table>
  </div>
</template>

<style scoped>
.job-history {
  padding: 4px 0;
}

.job-history-empty {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.job-history-err {
  color: var(--sf-danger);
}

.job-history-status {
  font-size: 13px;
}

.job-history-status--ok {
  color: #7bd88f;
}

.job-history-status--error {
  color: #ff6d6d;
}

.job-history-status--skipped,
.job-history-status--interrupted {
  opacity: 0.6;
}

.job-history-time {
  opacity: 0.65;
  white-space: nowrap;
}

.job-history-session {
  font-family: var(--sf-mono, monospace);
  font-size: 13px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.job-history-error {
  color: #ff6d6d;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
</style>
