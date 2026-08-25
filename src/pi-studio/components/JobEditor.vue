<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { JobInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const props = defineProps<{ jobId: string | null }>();
const store = useChatStore();

const error = ref('');
const busy = ref(false);
const initialized = ref(false);

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

const job = computed<JobInfo | null>(() =>
  props.jobId ? (store.jobs.find((j) => j.id === props.jobId) ?? null) : null,
);

const sessionOptions = computed(() =>
  [...store.sessions]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 100)
    .map((s) => ({ file: s.file, label: s.title || s.file.split('/').pop() || s.file })),
);

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initForm(j: JobInfo | null) {
  if (j) {
    form.name = j.name;
    form.scheduleType = j.scheduleType;
    form.runAtLocal = j.runAt ? toLocalInput(j.runAt) : toLocalInput(Date.now() + 3600_000);
    form.cron = j.cron ?? '0 3 * * *';
    form.targetMode = j.payload.target.mode;
    form.sessionFile = j.payload.target.sessionFile ?? sessionOptions.value[0]?.file ?? '';
    form.cwd = j.payload.target.cwd ?? '/workspace/sf';
    form.message = j.payload.message ?? '';
    form.model = j.payload.model ?? '';
    form.thinkLevel = j.payload.thinkLevel ?? '';
    form.missedPolicy = j.missedPolicy;
  } else {
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
  }
  initialized.value = true;
}

watch(
  job,
  (j) => {
    if (!initialized.value && (j !== null || store.jobsLoaded)) initForm(j);
  },
  { immediate: true },
);

onMounted(() => {
  void store.refreshJobs();
  if (!initialized.value) initForm(job.value);
});

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
    if (props.jobId) {
      const updated = await store.updateJob(props.jobId, input);
      store.renameJobEditorTab(props.jobId, updated.name);
    } else {
      await store.createJob(input);
      store.closeJobEditor(null);
    }
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (!props.jobId || !job.value) return;
  if (!window.confirm(`Delete job '${job.value.name}' and its run history?`)) return;
  error.value = '';
  try {
    await store.deleteJob(props.jobId);
    store.closeJobEditor(props.jobId);
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}
</script>

<template>
  <div class="job-editor">
    <div v-if="props.jobId && !job && store.jobsLoaded" class="job-editor-missing">
      Job {{ props.jobId }} not found — it may have been deleted.
    </div>
    <template v-else>
      <div class="job-editor-head">
        <div class="job-editor-title">
          <span class="job-editor-title-main">{{ props.jobId ? (job?.name ?? 'Job') : 'New Job' }}</span>
          <span v-if="job" class="job-editor-title-meta">
            {{ job.enabled ? 'enabled' : 'disabled' }} · created by {{ job.createdBy || '—' }} ·
            {{ fmtTime(job.createdAt) }}
          </span>
        </div>
        <div class="job-editor-head-actions">
          <button
            class="chat-send-btn job-editor-save"
            :disabled="busy"
            @click="save"
          >{{ props.jobId ? 'Save' : busy ? 'Creating…' : 'Create Job' }}</button>
          <button
            v-if="job"
            class="sf-panel-btn job-editor-danger"
            title="Delete job and its run history"
            @click="remove"
          >Delete</button>
        </div>
      </div>

      <div v-if="error" class="job-editor-error">{{ error }}</div>

      <div class="job-editor-body">
        <div class="job-editor-field">
          <label>Name</label>
          <input v-model="form.name" class="job-editor-input" placeholder="nightly maintenance" />
        </div>

        <div class="job-editor-field">
          <label>Schedule</label>
          <div class="job-editor-seg">
            <button
              :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.scheduleType === 'once' }"
              @click="form.scheduleType = 'once'"
            >One-time</button>
            <button
              :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.scheduleType === 'cron' }"
              @click="form.scheduleType = 'cron'"
            >Periodic (cron)</button>
          </div>
        </div>

        <div v-if="form.scheduleType === 'once'" class="job-editor-field">
          <label>Run at (local time)</label>
          <input v-model="form.runAtLocal" type="datetime-local" class="job-editor-input job-editor-input--narrow" />
        </div>

        <template v-else>
          <div class="job-editor-field">
            <label>Cron (server-local time)</label>
            <input v-model="form.cron" class="job-editor-input job-editor-input--mono job-editor-input--narrow" placeholder="0 3 * * *" />
            <div class="job-editor-presets">
              <button
                v-for="p in CRON_PRESETS"
                :key="p.expr"
                class="job-editor-preset"
                :class="{ 'job-editor-preset--on': form.cron === p.expr }"
                @click="form.cron = p.expr"
              >{{ p.label }}</button>
            </div>
          </div>
          <div class="job-editor-field">
            <label>Missed while backend down</label>
            <div class="job-editor-seg">
              <button
                :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.missedPolicy === 'coalesce' }"
                title="Run once on catch-up"
                @click="form.missedPolicy = 'coalesce'"
              >run once</button>
              <button
                :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.missedPolicy === 'skip' }"
                title="Skip missed occurrences, wait for the next"
                @click="form.missedPolicy = 'skip'"
              >skip</button>
            </div>
          </div>
        </template>

        <div class="job-editor-field">
          <label>Target</label>
          <div class="job-editor-seg">
            <button
              :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.targetMode === 'file' }"
              @click="form.targetMode = 'file'"
            >Existing session</button>
            <button
              :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.targetMode === 'new' }"
              @click="form.targetMode = 'new'"
            >New session each run</button>
            <button
              :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.targetMode === 'reuse' }"
              @click="form.targetMode = 'reuse'"
            >One session per cwd</button>
          </div>
        </div>

        <div v-if="form.targetMode === 'file'" class="job-editor-field">
          <label>Session</label>
          <select v-model="form.sessionFile" class="job-editor-input">
            <option v-for="s in sessionOptions" :key="s.file" :value="s.file">{{ s.label }}</option>
          </select>
        </div>
        <div v-else class="job-editor-field">
          <label>Working directory</label>
          <input v-model="form.cwd" class="job-editor-input job-editor-input--mono" placeholder="/workspace/sf" />
        </div>

        <div class="job-editor-field">
          <label>Message</label>
          <textarea
            v-model="form.message"
            class="job-editor-input job-editor-textarea"
            rows="5"
            placeholder="Run the full check suite and summarize failures."
          />
        </div>

        <div class="job-editor-field-row">
          <div class="job-editor-field job-editor-field--grow">
            <label>Model (optional, new sessions)</label>
            <input v-model="form.model" class="job-editor-input" placeholder="session default" />
          </div>
          <div class="job-editor-field">
            <label>Thinking</label>
            <select v-model="form.thinkLevel" class="job-editor-input">
              <option value="">default</option>
              <option value="off">off</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
        </div>

        <div v-if="job" class="job-editor-meta">
          <span>next run {{ job.enabled ? fmtTime(job.nextDue) : '— (disabled)' }}</span>
          <span v-if="job.lastRun">
            last run {{ job.lastRun.status }} {{ fmtTime(job.lastRun.finishedAt ?? job.lastRun.queuedAt) }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.job-editor {
  height: 100%;
  overflow-y: auto;
  overflow-x: clip;

  display: flex;
  flex-direction: column;
}
.job-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  flex-wrap: wrap;
}
.job-editor-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.job-editor-title-main {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.job-editor-title-meta {
  font-size: 16px;
  opacity: 0.6;
}
.job-editor-head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.job-editor-save {
  min-width: calc(2.5em + 24px);
  padding: 5px 14px;
  border-radius: 6px;
}
.job-editor-danger:hover {
  color: #ff6d6d;
}
.job-editor-error {
  margin: 10px 16px 0;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 16px;
  background: rgba(255, 82, 82, 0.12);
  color: #ff6d6d;
  word-break: break-word;
}
.job-editor-missing {
  padding: 24px;
  font-size: 16px;
  opacity: 0.7;
}
.job-editor-body {
  max-width: 760px;
  width: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
}
.job-editor-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.job-editor-field label {
  font-size: 16px;
  opacity: 0.65;
}
.job-editor-field-row {
  display: flex;
  gap: 10px;
}
.job-editor-field--grow {
  flex: 1;
}
.job-editor-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: rgba(0, 0, 0, 0.15);
  color: inherit;
  font-size: 16px;
}
.job-editor-input--narrow {
  max-width: 280px;
}
.job-editor-input--mono {
  font-family: var(--sf-mono, monospace);
}
.job-editor-textarea {
  resize: vertical;
  min-height: 90px;
}
.job-editor-seg {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.job-editor-seg-btn {
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: transparent;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
}
.job-editor-seg-btn--on {
  background: rgba(96, 165, 250, 0.22);
  border-color: rgba(96, 165, 250, 0.6);
}
.job-editor-presets {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.job-editor-preset {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.75;
}
.job-editor-preset--on {
  opacity: 1;
  border-color: rgba(96, 165, 250, 0.6);
}
.job-editor-meta {
  display: flex;
  gap: 16px;
  font-size: 16px;
  opacity: 0.6;
  padding-top: 4px;
  border-top: 1px dashed rgba(128, 128, 128, 0.25);
}
</style>
