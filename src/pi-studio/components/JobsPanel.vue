<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { JobInfo, JobRunInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const error = ref('');
const busy = ref(false);
const historyFor = ref<string | null>(null);
const historyRuns = ref<JobRunInfo[]>([]);
const historyBusy = ref(false);

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'daily 03:00', expr: '0 3 * * *' },
  { label: 'weekdays 09:00', expr: '0 9 * * mon-fri' },
  { label: 'sundays 00:00', expr: '0 0 * * 0' },
  { label: 'every 30 min', expr: '*/30 * * * *' },
];

const form = reactive({
  name: '',
  scheduleType: 'once' as 'once' | 'cron',
  runAtLocal: '',
  cron: '0 3 * * *',
  targetMode: 'new' as 'file' | 'new' | 'reuse',
  sessionFile: '',
  cwd: '/workspace/sf',
  message: '',
  model: '',
  thinkLevel: '',
  missedPolicy: 'coalesce' as 'coalesce' | 'skip',
});

const sessionOptions = computed(() =>
  [...store.sessions]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 100)
    .map((s) => ({ file: s.file, label: s.title || s.file.split('/').pop() || s.file })),
);

const jobs = computed(() => store.jobs);

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openCreate() {
  editingId.value = null;
  error.value = '';
  form.name = '';
  form.scheduleType = 'once';
  form.runAtLocal = toLocalInput(Date.now() + 3600_000);
  form.cron = '0 3 * * *';
  form.targetMode = 'new';
  form.sessionFile = sessionOptions.value[0]?.file ?? '';
  form.cwd = '/workspace/sf';
  form.message = '';
  form.model = '';
  form.thinkLevel = '';
  form.missedPolicy = 'coalesce';
  editorOpen.value = true;
}

function openEdit(job: JobInfo) {
  editingId.value = job.id;
  error.value = '';
  form.name = job.name;
  form.scheduleType = job.scheduleType;
  form.runAtLocal = job.runAt ? toLocalInput(job.runAt) : toLocalInput(Date.now() + 3600_000);
  form.cron = job.cron ?? '0 3 * * *';
  form.targetMode = job.payload.target.mode;
  form.sessionFile = job.payload.target.sessionFile ?? sessionOptions.value[0]?.file ?? '';
  form.cwd = job.payload.target.cwd ?? '/workspace/sf';
  form.message = job.payload.message ?? '';
  form.model = job.payload.model ?? '';
  form.thinkLevel = job.payload.thinkLevel ?? '';
  form.missedPolicy = job.missedPolicy;
  editorOpen.value = true;
}

function buildInput() {
  const input: Record<string, unknown> = {
    name: form.name,
    scheduleType: form.scheduleType,
    missedPolicy: form.missedPolicy,
    message: form.message,
    targetMode: form.targetMode,
    model: form.model || null,
    thinkLevel: form.thinkLevel || null,
    createdBy: 'web',
  };
  if (form.scheduleType === 'once') {
    const t = new Date(form.runAtLocal).getTime();
    if (!Number.isFinite(t) || form.runAtLocal === '') throw new Error('pick a valid run-at time');
    input.runAt = t;
  } else {
    input.cron = form.cron;
  }
  if (form.targetMode === 'file') {
    if (!form.sessionFile) throw new Error('pick a target session');
    input.sessionFile = form.sessionFile;
  } else {
    if (!form.cwd.trim()) throw new Error('target cwd required');
    input.cwd = form.cwd;
  }
  return input;
}

async function save() {
  error.value = '';
  busy.value = true;
  try {
    const input = buildInput();
    if (editingId.value) await store.updateJob(editingId.value, input);
    else await store.createJob(input);
    editorOpen.value = false;
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  } finally {
    busy.value = false;
  }
}

async function remove(job: JobInfo) {
  if (!window.confirm(`Delete job '${job.name}' and its run history?`)) return;
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
    <div class="jobs-head">
      <span class="jobs-title">Scheduled Jobs</span>
      <button class="sf-panel-btn jobs-new" title="New job" @click="openCreate">＋ New Job</button>
    </div>

    <div v-if="error" class="jobs-error">{{ error }}</div>

    <div v-if="editorOpen" class="jobs-editor">
      <div class="jobs-field">
        <label>Name</label>
        <input v-model="form.name" class="jobs-input" placeholder="nightly maintenance" />
      </div>
      <div class="jobs-field">
        <label>Schedule</label>
        <div class="jobs-seg">
          <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.scheduleType === 'once' }" @click="form.scheduleType = 'once'">One-time</button>
          <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.scheduleType === 'cron' }" @click="form.scheduleType = 'cron'">Periodic (cron)</button>
        </div>
      </div>
      <div v-if="form.scheduleType === 'once'" class="jobs-field">
        <label>Run at (local time)</label>
        <input v-model="form.runAtLocal" type="datetime-local" class="jobs-input" />
      </div>
      <template v-else>
        <div class="jobs-field">
          <label>Cron (server-local time)</label>
          <input v-model="form.cron" class="jobs-input jobs-input--mono" placeholder="0 3 * * *" />
        </div>
        <div class="jobs-presets">
          <button
            v-for="p in CRON_PRESETS"
            :key="p.expr"
            class="jobs-preset"
            :class="{ 'jobs-preset--on': form.cron === p.expr }"
            @click="form.cron = p.expr"
          >{{ p.label }}</button>
        </div>
        <div class="jobs-field">
          <label>Missed while backend down</label>
          <div class="jobs-seg">
            <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.missedPolicy === 'coalesce' }" @click="form.missedPolicy = 'coalesce'" title="Run once on catch-up">run once</button>
            <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.missedPolicy === 'skip' }" @click="form.missedPolicy = 'skip'" title="Skip missed occurrences, wait for the next">skip</button>
          </div>
        </div>
      </template>
      <div class="jobs-field">
        <label>Target</label>
        <div class="jobs-seg">
          <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.targetMode === 'file' }" @click="form.targetMode = 'file'">Existing session</button>
          <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.targetMode === 'new' }" @click="form.targetMode = 'new'">New session each run</button>
          <button :class="{ 'jobs-seg-btn': true, 'jobs-seg-btn--on': form.targetMode === 'reuse' }" @click="form.targetMode = 'reuse'">One session per cwd</button>
        </div>
      </div>
      <div v-if="form.targetMode === 'file'" class="jobs-field">
        <label>Session</label>
        <select v-model="form.sessionFile" class="jobs-input">
          <option v-for="s in sessionOptions" :key="s.file" :value="s.file">{{ s.label }}</option>
        </select>
      </div>
      <div v-else class="jobs-field">
        <label>Working directory</label>
        <input v-model="form.cwd" class="jobs-input jobs-input--mono" placeholder="/workspace/sf" />
      </div>
      <div class="jobs-field">
        <label>Message</label>
        <textarea v-model="form.message" class="jobs-input jobs-textarea" rows="4" placeholder="Run the full check suite and summarize failures." />
      </div>
      <div class="jobs-field-row">
        <div class="jobs-field jobs-field--grow">
          <label>Model (optional, new sessions)</label>
          <input v-model="form.model" class="jobs-input" placeholder="session default" />
        </div>
        <div class="jobs-field">
          <label>Thinking</label>
          <select v-model="form.thinkLevel" class="jobs-input">
            <option value="">default</option>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </div>
      </div>
      <div class="jobs-editor-actions">
        <button class="sf-panel-btn" @click="editorOpen = false">Cancel</button>
        <button class="sf-panel-btn jobs-save" :disabled="busy" @click="save">{{ busy ? 'Saving…' : editingId ? 'Save changes' : 'Create job' }}</button>
      </div>
    </div>

    <div v-if="jobs.length === 0 && store.jobsLoaded && !editorOpen" class="jobs-empty">
      No scheduled jobs yet — create one to send a message at a chosen time.
    </div>

    <div v-for="job in jobs" :key="job.id" class="jobs-item" :class="{ 'jobs-item--off': !job.enabled }">
      <div class="jobs-item-main">
        <div class="jobs-item-row">
          <span class="jobs-item-name" :title="job.name">{{ job.name }}</span>
          <span class="jobs-item-id" :title="job.id">{{ job.id }}</span>
          <span class="jobs-item-sched">{{ scheduleText(job) }}</span>
          <span v-if="job.enabled" class="jobs-item-next" :title="fmtTime(job.nextDue)">{{ fmtRelative(job.nextDue) }}</span>
          <span v-else class="jobs-item-off">off</span>
          <button
            class="md-switch sf-panel-btn jobs-switch"
            :class="{ 'md-switch--on': job.enabled }"
            role="switch"
            :aria-checked="job.enabled"
            :title="job.enabled ? 'Disable job' : 'Enable job'"
            @click="toggle(job)"
          ><span class="md-switch-knob" /></button>
        </div>
        <div class="jobs-item-row jobs-item-row--sub">
          <span class="jobs-item-target" :title="(job.payload.target.sessionFile ?? '') + (job.payload.target.cwd ?? '')">{{ targetText(job) }}</span>
          <span v-if="job.lastRun" class="jobs-item-last" :class="'jobs-status--' + job.lastRun.status">last: {{ job.lastRun.status }} {{ fmtRelative(job.lastRun.finishedAt ?? job.lastRun.queuedAt) }}</span>
          <span class="jobs-item-actions">
            <button class="sf-panel-btn" title="Run now (schedule untouched)" @click="runNow(job)">▶ run</button>
            <button class="sf-panel-btn" title="Edit job" @click="openEdit(job)">edit</button>
            <button class="sf-panel-btn" :title="historyFor === job.id ? 'Hide runs' : 'Show runs'" @click="toggleHistory(job)">history</button>
            <button class="sf-panel-btn jobs-danger" title="Delete job" @click="remove(job)">✕</button>
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
.jobs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.jobs-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.jobs-new {
  font-weight: 600;
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
.jobs-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 8px;
  background: rgba(128, 128, 128, 0.06);
}
.jobs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.jobs-field label {
  font-size: 11px;
  opacity: 0.65;
}
.jobs-field-row {
  display: flex;
  gap: 8px;
}
.jobs-field--grow {
  flex: 1;
}
.jobs-input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: rgba(0, 0, 0, 0.15);
  color: inherit;
  font-size: 12px;
}
.jobs-input--mono {
  font-family: var(--sf-mono, monospace);
}
.jobs-textarea {
  resize: vertical;
  min-height: 64px;
}
.jobs-seg {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.jobs-seg-btn {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
}
.jobs-seg-btn--on {
  background: rgba(96, 165, 250, 0.22);
  border-color: rgba(96, 165, 250, 0.6);
}
.jobs-presets {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.jobs-preset {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.75;
}
.jobs-preset--on {
  opacity: 1;
  border-color: rgba(96, 165, 250, 0.6);
}
.jobs-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.jobs-save {
  font-weight: 600;
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
.jobs-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.jobs-item-row--sub {
  gap: 6px;
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
.jobs-switch {
  margin-left: auto;
  flex-shrink: 0;
}
.jobs-item-target {
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
