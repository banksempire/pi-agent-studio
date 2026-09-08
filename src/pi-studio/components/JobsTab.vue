<script setup lang="ts">
import Dialog from '@sf/components/Dialog.vue';
import SvgIcon from '@sf/components/SvgIcon.vue';
import Table from '@sf/components/Table.vue';
import type { TableColumn } from '@sf/types/table';
import { computed, onMounted, reactive, ref } from 'vue';
import { fmtRelative, fmtTime, scheduleText, targetText } from '../jobText';
import type { JobInfo, JobRunInfo } from '../store/chat';
import { useChatStore } from '../store/chat';
import JobDetail from './JobDetail.vue';
import JobDialog from './JobDialog.vue';

const store = useChatStore();

const selectedId = ref<string | null>(null);
const selected = computed(() => store.jobs.find((j) => j.id === selectedId.value) ?? null);

const actionError = ref('');
const history = reactive<{ open: boolean; job: JobInfo | null; runs: JobRunInfo[]; busy: boolean }>({
  open: false,
  job: null,
  runs: [],
  busy: false,
});
const dialog = reactive<{ open: boolean; job: JobInfo | null }>({ open: false, job: null });

const columns: TableColumn[] = [
  { key: 'enabled', label: 'On', fixedWidth: 46, mobile: 'lead' },
  { key: 'name', label: 'Job', sortable: true, filter: true, mobile: 'title' },
  { key: 'schedule', label: 'Schedule', sortable: true, mobile: 'sub' },
  { key: 'target', label: 'Target', filter: true },
  { key: 'next', label: 'Next run', sortable: true },
  { key: 'last', label: 'Last run', filter: true },
];

const schedLine = computed(() => {
  const s = store.scheduler;
  if (!s) return '';
  const bits: string[] = [];
  if (s.running > 0) bits.push(`${s.running} running`);
  if (s.waiting > 0) bits.push(`${s.waiting} waiting for a slot`);
  if (bits.length === 0) return '';
  return `${bits.join(' · ')} · limits ${s.limits.globalMax} global / ${s.limits.providerMax} per provider / ${s.limits.modelMax} per model`;
});

const displayRows = computed(() =>
  [...store.jobs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => ({
      id: job.id,
      enabled: job.enabled,
      name: job.name,
      schedule: scheduleText(job),
      target: targetText(job),
      next: job.enabled ? fmtRelative(job.nextDue) : 'off',
      nextAbs: fmtTime(job.nextDue),
      last: job.lastRun
        ? `${job.lastRun.status} ${fmtRelative(job.lastRun.finishedAt ?? job.lastRun.queuedAt)}`
        : '',
      lastStatus: job.lastRun?.status ?? '',
      job,
    })),
);

function selectRow(row: Record<string, unknown>) {
  selectedId.value = selectedId.value === row.id ? null : (row.id as string);
}

function rowClass(row: Record<string, unknown>): Record<string, boolean> {
  return {
    'jobs-row--off': row.enabled !== true,
    'jobs-row--bad': row.lastStatus === 'error',
    'jobs-row--sel': row.id === selectedId.value,
  };
}

function openAdd() {
  editJob(null);
}

function openEdit(row: Record<string, unknown>) {
  editJob(row.job as JobInfo);
}

function editJob(job: JobInfo | null) {
  dialog.job = job;
  dialog.open = true;
}

function closeDialog() {
  dialog.open = false;
  dialog.job = null;
}

async function onSaved() {
  closeDialog();
  await store.refreshJobs();
}

async function toggle(row: Record<string, unknown>) {
  const job = row.job as JobInfo;
  actionError.value = '';
  try {
    await store.updateJob(job.id, { enabled: !job.enabled });
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  }
}

async function runNow(row: Record<string, unknown>) {
  const job = row.job as JobInfo;
  actionError.value = '';
  try {
    await store.runJobNow(job.id);
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  }
}

async function remove(row: Record<string, unknown>) {
  const job = row.job as JobInfo;
  if (!window.confirm(`Delete job '${job.name}' and its run history?`)) return;
  actionError.value = '';
  try {
    await store.deleteJob(job.id);
    if (selectedId.value === job.id) selectedId.value = null;
    if (dialog.job?.id === job.id) closeDialog();
    if (history.job?.id === job.id) closeHistory();
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  }
}

async function openHistory(row: Record<string, unknown>) {
  const job = row.job as JobInfo;
  history.open = true;
  history.job = job;
  history.busy = true;
  history.runs = [];
  try {
    history.runs = await store.fetchJobRuns(job.id);
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  } finally {
    history.busy = false;
  }
}

function closeHistory() {
  history.open = false;
  history.job = null;
  history.runs = [];
}

onMounted(() => {
  void store.refreshJobs();
});
</script>

<template>
  <div class="jobs-tab">
    <div v-if="schedLine" class="jobs-note" :title="schedLine">{{ schedLine }}</div>
    <div v-if="actionError" class="jobs-note jobs-note--err">{{ actionError }}</div>
    <div class="jobs-body">
      <div class="jobs-table">
        <Table
          :columns="columns"
          :rows="displayRows"
          row-key="id"
          searchable
          search-placeholder="Search jobs…"
          :row-title="(row) => String(row.name)"
          :row-class="rowClass"
          @row-click="selectRow"
        >
          <template #search-lead>
            <button class="jobs-add" title="New Job" @click="openAdd">
              <SvgIcon name="＋" />add
            </button>
          </template>
          <template #search-end="{ filtered, total }">
            <span class="jobs-count">{{ filtered }}/{{ total }}</span>
          </template>
          <template #cell-enabled="{ row }">
            <button
              class="md-switch jobs-switch"
              :class="{ 'md-switch--on': row.enabled }"
              role="switch"
              :aria-checked="row.enabled === true"
              :title="row.enabled ? 'Disable job' : 'Enable job'"
              @click.stop="toggle(row)"
            ><span class="md-switch-knob" /></button>
          </template>
          <template #cell-name="{ row }">
            <span class="jobs-name">{{ row.name }}</span>
          </template>
          <template #cell-schedule="{ row }">
            <span class="jobs-muted jobs-sched" :title="String(row.schedule)">{{ row.schedule }}</span>
          </template>
          <template #cell-target="{ row }">
            <span class="jobs-muted" :title="String(row.target)">{{ row.target }}</span>
          </template>
          <template #cell-next="{ row }">
            <span class="jobs-next" :title="row.enabled ? String(row.nextAbs) : undefined">{{ row.next }}</span>
          </template>
          <template #cell-last="{ row }">
            <span
              v-if="row.last"
              class="jobs-last"
              :class="'jobs-status--' + row.lastStatus"
              :title="String(row.last)"
            >{{ row.last }}</span>
            <span v-else class="jobs-muted">—</span>
          </template>
          <template #actions="{ row }">
            <button class="sf-tbl-btn" type="button" title="Run now (schedule untouched)" @click.stop="runNow(row)">
              <SvgIcon name="▶" />
            </button>
            <button class="sf-tbl-btn" type="button" title="Run history" @click.stop="openHistory(row)">
              <SvgIcon name="⏳" />
            </button>
            <button class="sf-tbl-btn" type="button" title="Edit job" @click.stop="openEdit(row)">
              <SvgIcon name="✎" />
            </button>
            <button
              class="sf-tbl-btn sf-tbl-btn--danger"
              type="button"
              title="Delete job"
              @click.stop="remove(row)"
            >
              <SvgIcon name="✕" />
            </button>
          </template>
          <template #empty="{ filtered }">
            {{ filtered ? 'No jobs match the filter.' : 'No scheduled jobs yet.' }}
          </template>
        </Table>
      </div>
      <JobDetail
        v-if="selected"
        :job="selected"
        @close="selectedId = null"
        @edit="editJob(selected)"
      />
    </div>

    <JobDialog v-if="dialog.open" :job="dialog.job" @close="closeDialog" @saved="onSaved" />

    <Dialog :open="history.open" :title="history.job ? `Run history — ${history.job.name}` : 'Run history'" @close="closeHistory">
      <div v-if="history.busy" class="jobs-runs-empty">loading…</div>
      <div v-else-if="history.runs.length === 0" class="jobs-runs-empty">no runs yet</div>
      <template v-else>
        <div v-for="run in history.runs" :key="run.id" class="jobs-run">
          <span class="jobs-run-dot" :class="'jobs-run-dot--' + run.status" />
          <span class="jobs-run-status" :class="'jobs-status--' + run.status">{{ run.status }}</span>
          <span class="jobs-run-time">{{ fmtTime(run.queuedAt) }}</span>
          <span class="jobs-run-session" :title="run.sessionFile">{{
            run.sessionFile ? run.sessionFile.split('/').pop() : '—'
          }}</span>
          <span v-if="run.error" class="jobs-run-error" :title="run.error">{{ run.error.slice(0, 80) }}</span>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.jobs-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--sf-bg);
}

.jobs-count {
  color: var(--sf-text-muted);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.jobs-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--sf-accent);
  border: 1px solid var(--sf-accent);
  border-radius: 4px;
  color: var(--sf-text-on-accent);
  font-family: var(--sf-font);
  font-size: 13px;
  padding: 3px 10px;
  cursor: pointer;
}

.jobs-add:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (hover: hover) {
  .jobs-add:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-on-accent);
  }
}

.sf-root--mobile .jobs-add {
  font-size: 16px;
  padding: 8px 14px;
}

.jobs-note {
  padding: 6px 12px;
  font-size: 16px;
  color: var(--sf-text-muted);
  border-bottom: 1px solid var(--sf-border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jobs-note--err {
  color: var(--sf-danger);
}

.jobs-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}

.jobs-table {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.jobs-detail {
  width: 340px;
  flex-shrink: 0;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 12px 14px;
  border-left: 1px solid var(--sf-border);
}

.sf-root--mobile .jobs-body {
  flex-direction: column;
}

.sf-root--mobile .jobs-tab .jobs-detail {
  width: auto;
  max-height: 46%;
  border-left: none;
  border-top: 1px solid var(--sf-border);
}

.jobs-tab :deep(.sf-tbl-row.jobs-row--off) {
  opacity: 0.55;
}

.jobs-tab :deep(.sf-tbl-row.jobs-row--bad .jobs-last) {
  text-decoration: underline dotted;
}

.jobs-tab :deep(.sf-tbl-row.jobs-row--sel) {
  background: var(--sf-accent-soft, rgba(96, 165, 250, 0.12));
}

.jobs-tab :deep(.sf-tbl-row.jobs-row--sel .jobs-name) {
  color: var(--sf-accent);
}

.jobs-tab :deep(.sf-tbl-head) {
  font-size: 16px;
}

.jobs-name {
  font-weight: 600;
}

.jobs-muted {
  color: var(--sf-text-muted);
}

.jobs-sched {
  font-family: var(--sf-mono, monospace);
  font-size: 12px;
}

.jobs-next {
  color: var(--sf-status-ok, #7bd88f);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.jobs-last {
  white-space: nowrap;
}

.jobs-switch {
  padding: 0;
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

.jobs-runs-empty {
  font-size: 13px;
  color: var(--sf-text-muted);
  padding: 4px 0;
}

.jobs-run {
  display: flex;
  align-items: center;
  gap: 8px;
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
  min-width: 64px;
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

.sf-root--mobile .jobs-tab :deep(.sf-tbl-row) {
  padding: 8px 12px;
}

.sf-root--mobile .jobs-tab :deep(.sf-tbl-c--title),
.sf-root--mobile .jobs-tab :deep(.sf-tbl-c--sub) {
  line-height: 20px;
}
</style>
