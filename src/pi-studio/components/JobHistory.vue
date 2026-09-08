<script setup lang="ts">
import { ref, watch } from 'vue';
import { fmtRelative, fmtTime } from '../jobText';
import type { JobRunInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const runs = ref<JobRunInfo[]>([]);
const busy = ref(false);
const error = ref('');

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
</script>

<template>
  <div class="job-history">
    <div v-if="!store.selectedJob" class="job-history-empty">Select a job to see its run history.</div>
    <div v-else-if="busy" class="job-history-empty">loading…</div>
    <div v-else-if="error" class="job-history-empty job-history-err">{{ error }}</div>
    <div v-else-if="runs.length === 0" class="job-history-empty">no runs yet</div>
    <template v-else>
      <div v-for="run in runs" :key="run.id" class="jobs-run" :title="fmtTime(run.queuedAt)">
        <span class="jobs-run-dot" :class="'jobs-run-dot--' + run.status" />
        <span class="jobs-run-status" :class="'jobs-status--' + run.status">{{ run.status }}</span>
        <span class="jobs-run-time">{{ fmtRelative(run.queuedAt) }}</span>
        <span class="jobs-run-session" :title="run.sessionFile">{{
          run.sessionFile ? run.sessionFile.split('/').pop() : '—'
        }}</span>
        <span v-if="run.error" class="jobs-run-error" :title="run.error">{{ run.error.slice(0, 80) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.job-history {
  display: flex;
  flex-direction: column;
  gap: 4px;
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

.jobs-run {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  min-width: 0;
}

.jobs-run-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.5);
  flex-shrink: 0;
}

.jobs-run-dot--ok {
  background: #7bd88f;
}

.jobs-run-dot--error {
  background: #ff6d6d;
}

.jobs-run-status {
  min-width: 56px;
}

.jobs-run-time {
  opacity: 0.65;
  white-space: nowrap;
}

.jobs-run-session {
  font-family: var(--sf-mono, monospace);
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jobs-run-error {
  color: #ff6d6d;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
