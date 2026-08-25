<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { JobInfo, JobRunInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const error = ref('');
const historyFor = ref<string | null>(null);
const historyRuns = ref<JobRunInfo[]>([]);
const historyBusy = ref(false);

const sortedJobs = computed<JobInfo[]>(() => {
  const jobs = [...store.jobs];
  if (store.jobsSort === 'name') {
    jobs.sort((a, b) => a.name.localeCompare(b.name));
  } else if (store.jobsSort === 'next') {
    jobs.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.nextDue - b.nextDue;
    });
  } else {
    jobs.sort((a, b) => b.createdAt - a.createdAt);
  }
  return jobs;
});

async function remove(job: JobInfo) {
  if (!window.confirm(`Delete job '${job.name}' and its run history?`)) return;
  error.value = '';
  try {
    await store.deleteJob(job.id);
    if (historyFor.value === job.id) historyFor.value = null;
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
}

async function runNow(job: JobInfo) {
  error.value = '';
  try {
    await store.runJobNow(job.id);
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
}

async function toggle(job: JobInfo) {
  error.value = '';
  try {
    await store.updateJob(job.id, { enabled: !job.enabled });
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
}

async function toggleHistory(job: JobInfo) {
  if (historyFor.value === job.id) {
    historyFor.value = null;
    return;
  }
  historyFor.value = job.id;
  historyBusy.value = true;
  try {
    historyRuns.value = await store.fetchJobRuns(job.id);
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  } finally {
    historyBusy.value = false;
  }
}

function scheduleText(job: JobInfo): string {
  return job.scheduleType === 'cron' ? `cron ${job.cron}` : `once ${fmtTime(job.runAt)}`;
}

function targetText(job: JobInfo): string {
  const t = job.payload.target;
  if (t.mode === 'file') return `session ${(t.sessionFile ?? '').split('/').pop()}`;
  return `${t.mode === 'new' ? 'new' : 'reuse'} · ${t.cwd ?? ''}`;
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function fmtRelative(ms: number | null): string {
  if (!ms) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const human =
    mins < 1
      ? 'now'
      : mins < 60
        ? `${mins}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${human}` : `${human} ago`;
}

onMounted(() => {
  void store.refreshJobs();
});
</script>

<template>
  <div class="jobs-panel">
    <div v-if="error" class="jobs-error">{{ error }}</div>

    <div v-if="sortedJobs.length === 0 && store.jobsLoaded" class="jobs-empty">
      No scheduled jobs yet — add one with ＋ in the title bar.
    </div>

    <div v-for="job in sortedJobs" :key="job.id" class="jobs-item" :class="{ 'jobs-item--off': !job.enabled }">
      <div class="jobs-item-main">
        <div class="jobs-item-row" role="button" tabindex="0" @click="store.openJobEditor(job.id)" @keydown.enter="store.openJobEditor(job.id)">
          <span class="jobs-item-name" :title="job.name">{{ job.name }}</span>
          <span class="jobs-item-id" :title="job.id">{{ job.id }}</span>
          <span class="jobs-item-sched">{{ scheduleText(job) }}</span>
          <span v-if="job.enabled" class="jobs-item-next" :title="fmtTime(job.nextDue)">{{ fmtRelative(job.nextDue) }}</span>
          <span v-else class="jobs-item-off">off</span>
          <span
            class="jobs-switch-wrap"
            @click.stop
          >
            <button
              class="md-switch sf-panel-btn jobs-switch"
              :class="{ 'md-switch--on': job.enabled }"
              role="switch"
              :aria-checked="job.enabled"
              :title="job.enabled ? 'Disable job' : 'Enable job'"
              @click="toggle(job)"
            ><span class="md-switch-knob" /></button>
          </span>
        </div>
        <div class="jobs-item-row jobs-item-row--sub">
          <span
            class="jobs-item-target"
            :title="(job.payload.target.sessionFile ?? '') + (job.payload.target.cwd ?? '')"
          >{{ targetText(job) }}</span>
          <span v-if="job.lastRun" class="jobs-item-last" :class="'jobs-status--' + job.lastRun.status">
            last: {{ job.lastRun.status }} {{ fmtRelative(job.lastRun.finishedAt ?? job.lastRun.queuedAt) }}
          </span>
          <span class="jobs-item-actions">
            <button class="sf-panel-btn" title="Run now (schedule untouched)" @click.stop="runNow(job)">▶ run</button>
            <button
              class="sf-panel-btn"
              :title="historyFor === job.id ? 'Hide runs' : 'Show runs'"
              @click.stop="toggleHistory(job)"
            >history</button>
            <button class="sf-panel-btn jobs-danger" title="Delete job" @click.stop="remove(job)">✕</button>
          </span>
        </div>
      </div>
      <div v-if="historyFor === job.id" class="jobs-history">
        <div v-if="historyBusy" class="jobs-history-empty">loading…</div>
        <div v-else-if="historyRuns.length === 0" class="jobs-history-empty">no runs yet</div>
        <template v-else>
          <div v-for="run in historyRuns" :key="run.id" class="jobs-history-row">
            <span class="jobs-status-dot" :class="'jobs-status-dot--' + run.status" />
            <span class="jobs-history-status" :class="'jobs-status--' + run.status">{{ run.status }}</span>
            <span class="jobs-history-time">{{ fmtTime(run.queuedAt) }}</span>
            <span class="jobs-history-session" :title="run.sessionFile">{{ run.sessionFile ? run.sessionFile.split('/').pop() : '—' }}</span>
            <span v-if="run.error" class="jobs-history-error" :title="run.error">{{ run.error.slice(0, 80) }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.jobs-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  min-height: 0;
  overflow-y: auto;
}
.jobs-error {
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  background: rgba(255, 82, 82, 0.12);
  color: #ff6d6d;
  word-break: break-word;
}
.jobs-empty {
  padding: 16px 8px;
  font-size: 12px;
  opacity: 0.6;
  text-align: center;
}
.jobs-item {
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 8px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.jobs-item--off {
  opacity: 0.55;
}
.jobs-item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.jobs-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.jobs-item-row:focus-visible {
  outline: 2px solid rgba(96, 165, 250, 0.6);
  outline-offset: 1px;
  border-radius: 6px;
}
.jobs-item-row--sub {
  gap: 6px;
  cursor: default;
}
.jobs-item-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.jobs-item-id {
  font-size: 10px;
  opacity: 0.45;
  font-family: var(--sf-mono, monospace);
}
.jobs-item-sched {
  font-size: 11px;
  font-family: var(--sf-mono, monospace);
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jobs-item-next {
  font-size: 11px;
  color: rgba(96, 165, 250, 0.9);
  white-space: nowrap;
}
.jobs-item-off {
  font-size: 11px;
  opacity: 0.7;
}
.jobs-switch-wrap {
  margin-left: auto;
  flex-shrink: 0;
}
.jobs-switch {
  pointer-events: auto;
}
.jobs-item-row--sub .jobs-item-target {
  font-size: 11px;
  opacity: 0.65;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.jobs-item-last {
  font-size: 11px;
  white-space: nowrap;
}
.jobs-status--ok {
  color: #7bd88f;
}
.jobs-status--error {
  color: #ff6d6d;
}
.jobs-status--skipped,
.jobs-status--interrupted {
  opacity: 0.6;
}
.jobs-item-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.jobs-danger:hover {
  color: #ff6d6d;
}
.jobs-history {
  border-top: 1px dashed rgba(128, 128, 128, 0.25);
  padding-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.jobs-history-empty {
  font-size: 11px;
  opacity: 0.55;
  padding: 2px 0;
}
.jobs-history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  min-width: 0;
}
.jobs-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.5);
  flex-shrink: 0;
}
.jobs-status-dot--ok {
  background: #7bd88f;
}
.jobs-status-dot--error {
  background: #ff6d6d;
}
.jobs-history-status {
  min-width: 64px;
}
.jobs-history-time {
  opacity: 0.65;
  white-space: nowrap;
}
.jobs-history-session {
  font-family: var(--sf-mono, monospace);
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jobs-history-error {
  color: #ff6d6d;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
