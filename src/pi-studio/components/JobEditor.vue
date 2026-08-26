<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { PeriodicPatternState } from '../cronInfo';
import { checkCron, cronToPattern, describeCron, nextCronRuns, patternToCron } from '../cronInfo';
import type { JobInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const props = defineProps<{ jobId: string | null }>();
const store = useChatStore();

const error = ref('');
const busy = ref(false);
const initialized = ref(false);
const sessionFilter = ref('');
const rawMode = ref(false);

type PeriodicPattern = PeriodicPatternState['pattern'];
const PATTERN_OPTIONS: Array<{ id: PeriodicPattern; title: string; hint: string }> = [
  { id: 'minutes', title: 'Minutes', hint: 'every N minutes, all day' },
  { id: 'hourly', title: 'Hourly', hint: 'once every hour, at a set minute' },
  { id: 'daily', title: 'Daily', hint: 'once a day, at a set time' },
  { id: 'weekly', title: 'Weekly', hint: 'on chosen weekdays, at a set time' },
  { id: 'monthly', title: 'Monthly', hint: 'on a day of the month, at a set time' },
];
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_EVERY_MINUTES = [5, 10, 15, 20, 30, 45];
const DEFAULT_HOURLY_MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const TARGET_OPTIONS: Array<{ mode: 'file' | 'new' | 'reuse'; title: string; desc: string }> = [
  { mode: 'file', title: 'Existing session', desc: 'Deliver into a session you pick' },
  { mode: 'new', title: 'Fresh per run', desc: 'A brand-new session for every run' },
  { mode: 'reuse', title: 'One per cwd', desc: 'One persistent session per working directory' },
];

const form = reactive({
  name: '',
  scheduleType: 'once' as 'once' | 'cron',
  runAtLocal: '',
  cron: '0 9 * * *',
  targetMode: 'new' as 'file' | 'new' | 'reuse',
  sessionFile: '',
  cwd: '/workspace/sf',
  message: '',
  model: '',
  thinkLevel: '',
  missedPolicy: 'coalesce' as 'coalesce' | 'skip',
});

const periodic = reactive<PeriodicPatternState>({
  pattern: 'daily',
  everyMinutes: 30,
  atMinute: 0,
  hour: 9,
  minute: 0,
  days: [1, 2, 3, 4, 5],
  monthDay: 1,
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

const filteredSessions = computed(() => {
  const current = form.sessionFile;
  const base =
    current && !sessionOptions.value.some((o) => o.file === current)
      ? [{ file: current, label: `${current.split('/').pop()} (current value)` }, ...sessionOptions.value]
      : sessionOptions.value;
  const q = sessionFilter.value.trim().toLowerCase();
  if (!q) return base;
  return base.filter((o) => o.label.toLowerCase().includes(q) || o.file.toLowerCase().includes(q));
});

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function syncFromCron() {
  const p = cronToPattern(form.cron);
  if (p) {
    Object.assign(periodic, p);
    rawMode.value = false;
  } else if (form.cron.trim() !== '') {
    rawMode.value = true;
  }
}

function initForm(j: JobInfo | null) {
  if (j) {
    form.name = j.name;
    form.scheduleType = j.scheduleType;
    form.runAtLocal = j.runAt ? toLocalInput(j.runAt) : toLocalInput(Date.now() + 3600_000);
    form.cron = j.cron ?? '0 9 * * *';
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
    form.cron = '0 9 * * *';
    form.targetMode = 'new';
    form.sessionFile = sessionOptions.value[0]?.file ?? '';
    form.cwd = '/workspace/sf';
    form.message = '';
    form.model = '';
    form.thinkLevel = '';
    form.missedPolicy = 'coalesce';
  }
  syncFromCron();
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

watch(sessionOptions, (opts) => {
  if (form.targetMode === 'file' && !form.sessionFile && opts.length > 0) form.sessionFile = opts[0].file;
});

function setTarget(mode: 'file' | 'new' | 'reuse') {
  form.targetMode = mode;
  if (mode === 'file' && !form.sessionFile && sessionOptions.value.length > 0) {
    form.sessionFile = sessionOptions.value[0].file;
  }
}

const currentCron = computed(() => (rawMode.value ? form.cron.trim() : patternToCron(periodic)));

watch(currentCron, (v) => {
  if (!rawMode.value) return;
  const p = cronToPattern(v);
  if (p) Object.assign(periodic, p);
});

function enterRaw() {
  if (currentCron.value !== '') form.cron = currentCron.value;
  rawMode.value = true;
}

function leaveRaw() {
  rawMode.value = false;
}

function toggleDay(d: number) {
  const i = periodic.days.indexOf(d);
  if (i === -1) periodic.days = [...periodic.days, d].sort((a, b) => a - b);
  else periodic.days = periodic.days.filter((x) => x !== d);
}

const everyMinutesOptions = computed(() => {
  const list = new Set(DEFAULT_EVERY_MINUTES);
  list.add(periodic.everyMinutes);
  return [...list].sort((a, b) => a - b);
});

const hourlyMinuteOptions = computed(() => {
  const list = new Set(DEFAULT_HOURLY_MINUTES);
  list.add(periodic.atMinute);
  return [...list].sort((a, b) => a - b);
});

const cronOk = computed(() => checkCron(currentCron.value).ok);
const cronErrorText = computed(() => {
  const r = checkCron(currentCron.value);
  return r.ok ? '' : r.error;
});
const cronDescribe = computed(() => (cronOk.value ? describeCron(currentCron.value) : ''));
const cronNext = computed(() => (cronOk.value ? nextCronRuns(currentCron.value, 3) : []));

const runAtTs = computed(() => (form.runAtLocal === '' ? null : new Date(form.runAtLocal).getTime()));
const runAtValid = computed(() => runAtTs.value !== null && Number.isFinite(runAtTs.value));
const runAtPast = computed(() => {
  const t = runAtTs.value;
  return t !== null && Number.isFinite(t) && t < Date.now();
});

const problems = computed<string[]>(() => {
  const list: string[] = [];
  if (!form.name.trim()) list.push('name');
  if (form.scheduleType === 'once' && !runAtValid.value) list.push('run-at time');
  if (form.scheduleType === 'cron' && rawMode.value && !cronOk.value) list.push('cron expression');
  if (
    form.scheduleType === 'cron' &&
    !rawMode.value &&
    periodic.pattern === 'weekly' &&
    periodic.days.length === 0
  )
    list.push('at least one weekday');
  if (form.targetMode === 'file' && !form.sessionFile) list.push('target session');
  if (form.targetMode !== 'file' && !form.cwd.trim()) list.push('working directory');
  if (!form.message.trim()) list.push('message');
  return list;
});
const canSave = computed(() => problems.value.length === 0 && !busy.value);
const saveHint = computed(() => (problems.value.length === 0 ? '' : `missing: ${problems.value.join(', ')}`));

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
    if (!runAtValid.value) throw new Error('pick a valid run-at time');
    input.runAt = runAtTs.value;
  } else {
    if (!currentCron.value) throw new Error('pick at least one weekday');
    input.cron = currentCron.value;
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
  if (!canSave.value) return;
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

async function toggleEnabled() {
  const j = job.value;
  if (!j) return;
  error.value = '';
  try {
    await store.updateJob(j.id, { enabled: !j.enabled });
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
}

function cancel() {
  store.closeJobEditor(props.jobId ?? null);
}

function fmtAbs(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtRel(ms: number | null): string {
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
</script>

<template>
  <div class="job-editor">
    <div v-if="props.jobId && !job && store.jobsLoaded" class="je-missing">
      Job {{ props.jobId }} not found — it may have been deleted.
    </div>
    <template v-else>
      <header class="je-head">
        <div class="je-head-text">
          <span class="job-editor-title-main">{{ props.jobId ? (job?.name ?? 'Job') : 'New Job' }}</span>
          <div v-if="job" class="je-head-meta">
            <span class="je-mono je-head-id" :title="job.id">{{ job.id }}</span>
            <span>created {{ fmtAbs(job.createdAt) }}</span>
            <span>by {{ job.createdBy || '—' }}</span>
            <span v-if="job.enabled">next run {{ fmtRel(job.nextDue) }}</span>
            <span v-else class="je-paused">paused</span>
            <span v-if="job.lastRun">
              last {{ job.lastRun.status }} {{ fmtRel(job.lastRun.finishedAt ?? job.lastRun.queuedAt) }}
            </span>
          </div>
        </div>
        <div v-if="job" class="je-enabled">
          <button
            class="md-switch sf-panel-btn je-switch"
            :class="{ 'md-switch--on': job.enabled }"
            role="switch"
            :aria-checked="job.enabled"
            :title="job.enabled ? 'Disable job' : 'Enable job'"
            @click="toggleEnabled"
          ><span class="md-switch-knob" /></button>
          <span>{{ job.enabled ? 'enabled' : 'paused' }}</span>
        </div>
      </header>

      <div class="je-scroll">
        <div class="job-editor-body">
          <section class="je-section je-section--flush">
            <div class="job-editor-field">
              <label>Job name</label>
              <input v-model="form.name" class="job-editor-input" placeholder="nightly maintenance" />
            </div>
          </section>

          <section class="je-section">
            <h3 class="je-section-title">Schedule</h3>
            <div class="job-editor-field">
              <div class="job-editor-seg je-seg">
                <button
                  :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.scheduleType === 'once' }"
                  @click="form.scheduleType = 'once'"
                >One-time</button>
                <button
                  :class="{ 'job-editor-seg-btn': true, 'job-editor-seg-btn--on': form.scheduleType === 'cron' }"
                  @click="form.scheduleType = 'cron'"
                >Periodic</button>
              </div>
            </div>

            <div v-if="form.scheduleType === 'once'" class="job-editor-field">
              <label>Run at</label>
              <input
                v-model="form.runAtLocal"
                type="datetime-local"
                class="job-editor-input job-editor-input--narrow"
              />
              <span v-if="runAtValid" class="je-hint">{{ fmtAbs(runAtTs) }} · {{ fmtRel(runAtTs) }}</span>
              <span v-if="runAtPast" class="je-hint je-hint--warn">this time is in the past</span>
            </div>

            <template v-else>
              <div class="je-sched-toolbar">
                <div v-if="!rawMode" class="je-patterns">
                  <button
                    v-for="p in PATTERN_OPTIONS"
                    :key="p.id"
                    type="button"
                    class="je-pattern-btn"
                    :class="{ 'je-pattern-btn--on': periodic.pattern === p.id }"
                    :title="p.hint"
                    @click="periodic.pattern = p.id"
                  >{{ p.title }}</button>
                </div>
                <span v-else class="je-raw-tag">custom expression</span>
                <button
                  class="sf-panel-btn je-mode-btn"
                  :title="rawMode ? 'Back to the visual builder' : 'Edit the raw 5-field cron expression'"
                  @click="rawMode ? leaveRaw() : enterRaw()"
                >{{ rawMode ? 'use builder' : 'raw expression' }}</button>
              </div>

              <div v-if="rawMode" class="job-editor-field">
                <label>Raw cron expression <span class="je-label-note">min hour dom month dow · server-local time</span></label>
                <input
                  v-model="form.cron"
                  class="job-editor-input job-editor-input--mono job-editor-input--narrow"
                  placeholder="0 3 * * *"
                  spellcheck="false"
                />
                <span class="je-hint">switching back to the builder rewrites the expression from the builder's fields</span>
              </div>

              <template v-else>
                <div v-if="periodic.pattern === 'minutes'" class="je-ctrl">
                  <span class="je-ctrl-label">Run every</span>
                  <div class="je-chips">
                    <button
                      v-for="m in everyMinutesOptions"
                      :key="m"
                      type="button"
                      class="je-chip"
                      :class="{ 'je-chip--on': periodic.everyMinutes === m }"
                      @click="periodic.everyMinutes = m"
                    >{{ m }} min</button>
                  </div>
                </div>

                <div v-else-if="periodic.pattern === 'hourly'" class="je-ctrl">
                  <span class="je-ctrl-label">At minute past the hour</span>
                  <div class="je-chips">
                    <button
                      v-for="m in hourlyMinuteOptions"
                      :key="m"
                      type="button"
                      class="je-chip"
                      :class="{ 'je-chip--on': periodic.atMinute === m }"
                      @click="periodic.atMinute = m"
                    >{{ pad2(m) }}</button>
                  </div>
                </div>

                <template v-else>
                  <div v-if="periodic.pattern === 'weekly'" class="je-ctrl">
                    <span class="je-ctrl-label">On days</span>
                    <div class="je-chips">
                      <button
                        v-for="(name, d) in DOW_LABELS"
                        :key="d"
                        type="button"
                        class="je-chip"
                        :class="{ 'je-chip--on': periodic.days.includes(d) }"
                        @click="toggleDay(d)"
                      >{{ name }}</button>
                    </div>
                    <div class="je-quick">
                      <button class="je-quick-btn" type="button" @click="periodic.days = [1, 2, 3, 4, 5]">weekdays</button>
                      <button class="je-quick-btn" type="button" @click="periodic.days = [0, 6]">weekend</button>
                      <button class="je-quick-btn" type="button" @click="periodic.days = [0, 1, 2, 3, 4, 5, 6]">every day</button>
                    </div>
                    <span v-if="periodic.days.length === 0" class="je-hint je-hint--warn">pick at least one day</span>
                  </div>

                  <div class="je-ctrl je-ctrl-row">
                    <template v-if="periodic.pattern === 'monthly'">
                      <span class="je-ctrl-label">On day</span>
                      <select v-model.number="periodic.monthDay" class="job-editor-input je-time">
                        <option v-for="d in 31" :key="d" :value="d">{{ d }}</option>
                      </select>
                    </template>
                    <span class="je-ctrl-label">at</span>
                    <select v-model.number="periodic.hour" class="job-editor-input je-time" title="Hour">
                      <option v-for="h in 24" :key="h" :value="h - 1">{{ pad2(h - 1) }}</option>
                    </select>
                    <span class="je-ctrl-colon">:</span>
                    <select v-model.number="periodic.minute" class="job-editor-input je-time" title="Minute">
                      <option v-for="m in 60" :key="m" :value="m - 1">{{ pad2(m - 1) }}</option>
                    </select>
                  </div>
                  <span v-if="periodic.pattern === 'monthly' && periodic.monthDay > 28" class="je-hint">
                    months without day {{ periodic.monthDay }} skip that run
                  </span>
                </template>
              </template>

              <div
                v-if="currentCron !== ''"
                class="je-cron-preview"
                :class="{ 'je-cron-preview--bad': !cronOk }"
              >
                <template v-if="cronOk">
                  <div class="je-cron-ref">
                    <span class="je-cron-ref-label">cron</span>
                    <code class="je-mono">{{ currentCron }}</code>
                  </div>
                  <div class="je-cron-desc">{{ cronDescribe }}</div>
                  <div class="je-cron-next">
                    <span class="je-cron-next-label">next</span>
                    <template v-if="cronNext.length">
                      <span v-for="t in cronNext" :key="t" class="je-cron-next-item">
                        <span class="je-mono">{{ fmtAbs(t) }}</span>
                        <em>{{ fmtRel(t) }}</em>
                      </span>
                    </template>
                    <span v-else>no occurrence within a year</span>
                  </div>
                </template>
                <span v-else class="je-cron-error">{{ cronErrorText }}</span>
              </div>

              <div class="job-editor-field">
                <label>If a run was missed while the backend was down</label>
                <div class="job-editor-seg je-seg je-seg--small">
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
          </section>

          <section class="je-section">
            <h3 class="je-section-title">Target</h3>
            <div class="je-cards">
              <button
                v-for="opt in TARGET_OPTIONS"
                :key="opt.mode"
                type="button"
                class="je-card"
                :class="{ 'je-card--on': form.targetMode === opt.mode }"
                @click="setTarget(opt.mode)"
              >
                <span class="je-card-title">{{ opt.title }}</span>
                <span class="je-card-desc">{{ opt.desc }}</span>
              </button>
            </div>
            <div v-if="form.targetMode === 'file'" class="job-editor-field">
              <label>Session</label>
              <input
                v-if="store.sessions.length > 8"
                v-model="sessionFilter"
                class="job-editor-input je-session-filter"
                placeholder="filter sessions…"
              />
              <select v-model="form.sessionFile" class="job-editor-input">
                <option v-if="filteredSessions.length === 0" :value="form.sessionFile">no match for “{{ sessionFilter }}”</option>
                <option v-for="s in filteredSessions" :key="s.file" :value="s.file">{{ s.label }}</option>
              </select>
            </div>
            <div v-else class="job-editor-field">
              <label>Working directory</label>
              <input v-model="form.cwd" class="job-editor-input job-editor-input--mono" placeholder="/workspace/sf" />
            </div>
          </section>

          <section class="je-section">
            <h3 class="je-section-title">Message</h3>
            <div class="job-editor-field">
              <textarea
                v-model="form.message"
                class="job-editor-input job-editor-textarea"
                rows="6"
                placeholder="What the agent should do each time this job fires — e.g. “run the full check suite and summarize failures.”"
              />
            </div>
          </section>

          <section class="je-section">
            <h3 class="je-section-title">Agent <span class="je-section-note">applies to newly created sessions</span></h3>
            <div class="je-row">
              <div class="job-editor-field je-grow">
                <label>Model override</label>
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
          </section>
        </div>
      </div>

      <footer class="je-footer">
        <div class="je-footer-msg">
          <span v-if="error" class="je-error">{{ error }}</span>
          <span v-else-if="saveHint" class="je-footer-hint">{{ saveHint }}</span>
        </div>
        <div class="je-footer-actions">
          <button v-if="job" class="sf-panel-btn job-editor-danger" title="Delete job and its run history" @click="remove">Delete</button>
          <button class="sf-panel-btn" @click="cancel">Cancel</button>
          <button class="chat-send-btn job-editor-save" :disabled="!canSave" :title="saveHint" @click="save">
            {{ busy ? 'Saving…' : props.jobId ? 'Save changes' : 'Create job' }}
          </button>
        </div>
      </footer>
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
.je-missing {
  padding: 24px;
  font-size: 16px;
  opacity: 0.7;
}

.je-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--sf-border);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.je-head-text {
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
.je-head-meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  opacity: 0.65;
}
.je-head-id {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.je-paused {
  color: var(--sf-status-warn);
  opacity: 1;
}
.je-enabled {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  opacity: 0.85;
  flex-shrink: 0;
}

.je-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: clip;
}
.job-editor-body {
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  padding: 18px 20px 28px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.je-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 0 18px;
}
.je-section--flush {
  padding-top: 4px;
}
.je-section + .je-section {
  border-top: 1px solid var(--sf-border);
}
.je-section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sf-text-muted);
}
.je-section-note {
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
  opacity: 0.8;
}

.job-editor-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.job-editor-field label {
  font-size: 16px;
  opacity: 0.75;
}
.je-label-note {
  font-size: 13px;
  opacity: 0.65;
}
.je-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.je-grow {
  flex: 1;
}

.job-editor-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border-radius: var(--sf-radius-inner);
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15);
  color: inherit;
  font-size: 16px;
  font-family: var(--sf-font);
}
.job-editor-input:focus-visible {
  outline: none;
  border-color: var(--sf-accent-dim);
}
.job-editor-input--narrow {
  max-width: 300px;
}
.job-editor-input--mono {
  font-family: var(--sf-mono, monospace);
}
.job-editor-textarea {
  resize: vertical;
  min-height: 110px;
  line-height: 1.45;
}
.je-hint {
  font-size: 13px;
  opacity: 0.65;
}
.je-hint--warn {
  color: var(--sf-status-warn);
  opacity: 1;
}

.je-seg {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15);
  width: fit-content;
  flex-wrap: wrap;
}
.job-editor-seg-btn {
  padding: 4px 14px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.75;
}
.job-editor-seg-btn:hover {
  opacity: 1;
}
.job-editor-seg-btn--on {
  background: var(--sf-accent-soft);
  color: var(--sf-text-bright);
  opacity: 1;
}
.je-seg--small .job-editor-seg-btn {
  padding: 2px 12px;
}

.je-sched-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.je-patterns {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.je-pattern-btn {
  padding: 5px 14px;
  border-radius: 6px;
  border: 1px solid var(--sf-border);
  background: transparent;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.75;
}
.je-pattern-btn:hover {
  opacity: 1;
  background: var(--sf-hover-overlay);
}
.je-pattern-btn--on {
  opacity: 1;
  background: var(--sf-accent-soft);
  border-color: var(--sf-accent-dim);
  color: var(--sf-text-bright);
}
.je-mode-btn {
  font-size: 13px;
}
.je-raw-tag {
  font-size: 13px;
  color: var(--sf-status-warn);
}

.je-ctrl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.je-ctrl-row {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.je-ctrl-label {
  font-size: 16px;
  opacity: 0.75;
}
.je-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.je-chip {
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--sf-border);
  background: transparent;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.75;
}
.je-chip:hover {
  opacity: 1;
}
.je-chip--on {
  opacity: 1;
  background: var(--sf-accent-soft);
  border-color: var(--sf-accent-dim);
  color: var(--sf-text-bright);
}
.je-quick {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.je-quick-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--sf-link);
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
}
.je-time {
  width: auto;
  min-width: 84px;
  padding: 6px 8px;
  flex-shrink: 0;
}
.je-ctrl-colon {
  font-size: 16px;
  opacity: 0.6;
}

.je-cron-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 12px;
  border-radius: var(--sf-radius-inner);
  border: 1px solid var(--sf-border);
  background: rgba(127, 127, 127, 0.07);
  overflow-wrap: anywhere;
}
.je-cron-preview--bad {
  border-color: var(--sf-danger);
}
.je-cron-ref {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  opacity: 0.85;
}
.je-cron-ref-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
  opacity: 0.6;
}
.je-cron-ref code {
  font-size: 13px;
}
.je-cron-desc {
  font-size: 16px;
  color: var(--sf-text-bright);
}
.je-cron-next {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  opacity: 0.85;
}
.je-cron-next-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
  opacity: 0.6;
}
.je-cron-next-item em {
  font-style: normal;
  opacity: 0.6;
  margin-left: 5px;
}
.je-cron-error {
  font-size: 16px;
  color: var(--sf-danger);
}

.je-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}
.je-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 12px;
  border-radius: var(--sf-radius);
  border: 1px solid var(--sf-border);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.je-card:hover {
  background: var(--sf-hover-overlay);
}
.je-card--on {
  background: var(--sf-accent-soft);
  border-color: var(--sf-accent-dim);
}
.je-card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--sf-text-bright);
}
.je-card-desc {
  font-size: 13px;
  opacity: 0.65;
}
.je-session-filter {
  max-width: 320px;
}

.je-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--sf-border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.je-footer-msg {
  min-width: 0;
  flex: 1;
  font-size: 13px;
}
.je-error {
  color: var(--sf-danger);
  word-break: break-word;
}
.je-footer-hint {
  opacity: 0.55;
}
.je-footer-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
.job-editor-save {
  min-width: calc(2.5em + 24px);
  padding: 5px 14px;
  border-radius: 6px;
}
.job-editor-danger:hover {
  color: var(--sf-danger);
}
.je-mono {
  font-family: var(--sf-mono, monospace);
}
</style>
