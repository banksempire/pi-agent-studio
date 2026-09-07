<script setup lang="ts">
import Menu from '@sf/components/Menu.vue';
import MultiSelectGroup from '@sf/components/MultiSelectGroup.vue';
import PillSelector from '@sf/components/PillSelector.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { PeriodicPatternState } from '../cronInfo';
import { checkCron, cronToPattern, describeCron, nextCronRuns, patternToCron } from '../cronInfo';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import { modelMenuItems as buildModelMenu, loadModelCatalog } from '../modelInfo';
import type { JobInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const props = defineProps<{ jobId: string | null }>();
const store = useChatStore();

const error = ref('');
const busy = ref(false);
const initialized = ref(false);
const sessionFilter = ref('');

type SchedMode = 'once' | 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced';
type BuilderPattern = PeriodicPatternState['pattern'];
const MODE_OPTIONS: Array<{ id: SchedMode; title: string; hint: string }> = [
  { id: 'once', title: 'Once', hint: 'run a single time' },
  { id: 'minutes', title: 'Minutes', hint: 'every N minutes, all day' },
  { id: 'hourly', title: 'Hourly', hint: 'once every hour, at a set minute' },
  { id: 'daily', title: 'Daily', hint: 'once a day, at a set time' },
  { id: 'weekly', title: 'Weekly', hint: 'on chosen weekdays, at a set time' },
  { id: 'monthly', title: 'Monthly', hint: 'on a day of the month, at a set time' },
  { id: 'advanced', title: 'Advanced', hint: 'raw cron expression, or scheduler-picked off-peak runs' },
];
const MODE_PILL = MODE_OPTIONS.map((m) => ({ value: m.id, label: m.title, title: m.hint }));
const ADVANCED_KIND_PILL = [
  { value: 'cron', label: 'cron', title: 'Fire at the times this expression matches' },
  {
    value: 'offpeak',
    label: 'off peak',
    title: 'No fixed time — the scheduler runs it once a day while the model is outside its peak windows',
  },
];
const MISSED_POLICY_PILL = [
  { value: 'coalesce', label: 'run once', title: 'Run once on catch-up' },
  { value: 'skip', label: 'skip', title: 'Skip missed occurrences, wait for the next' },
];
const DOW_OPTIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, d) => ({
  value: d,
  label: name,
  title: name,
}));
const EVERY_MINUTE_OPTIONS = [1, 2, 3, 4, 5, 10, 15, 20, 30, 40, 50];
const HOURLY_MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const TARGET_OPTIONS: Array<{ mode: 'file' | 'new' | 'reuse'; title: string; desc: string }> = [
  { mode: 'file', title: 'Existing session', desc: 'Deliver into a session you pick' },
  { mode: 'new', title: 'Fresh per run', desc: 'A brand-new session for every run' },
  { mode: 'reuse', title: 'One per cwd', desc: 'One persistent session per working directory' },
];

const form = reactive({
  name: '',
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

const mode = ref<SchedMode>('once');
const advancedKind = ref<'cron' | 'offpeak'>('cron');
const modelCatalog = ref<ModelCatalogView | null>(null);
const modelError = ref('');
const modelMenuOpen = ref(false);
const periodic = reactive({
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

function setMode(m: SchedMode) {
  if (m === mode.value) return;
  if (m === 'advanced' && mode.value !== 'once') {
    const expr = patternToCron({ ...periodic, pattern: mode.value as BuilderPattern });
    if (expr) form.cron = expr;
  }
  mode.value = m;
}

function initForm(j: JobInfo | null) {
  if (j) {
    form.name = j.name;
    form.runAtLocal = j.runAt ? toLocalInput(j.runAt) : toLocalInput(Date.now() + 3600_000);
    form.cron = j.cron ?? '0 9 * * *';
    form.targetMode = j.payload.target.mode;
    form.sessionFile = j.payload.target.sessionFile ?? sessionOptions.value[0]?.file ?? '';
    form.cwd = j.payload.target.cwd ?? '/workspace/sf';
    form.message = j.payload.message ?? '';
    form.model = j.payload.model ?? '';
    form.thinkLevel = j.payload.thinkLevel ?? '';
    form.missedPolicy = j.missedPolicy;
    advancedKind.value = 'cron';
    if (j.scheduleType === 'once') {
      mode.value = 'once';
    } else if (j.scheduleType === 'nonpeak') {
      mode.value = 'advanced';
      advancedKind.value = 'offpeak';
    } else {
      const p = cronToPattern(j.cron ?? '');
      if (p) {
        const { pattern: _pattern, ...fields } = p;
        Object.assign(periodic, fields);
        mode.value = p.pattern;
      } else {
        mode.value = 'advanced';
      }
    }
  } else {
    form.name = '';
    form.runAtLocal = toLocalInput(Date.now() + 3600_000);
    form.cron = '0 9 * * *';
    form.targetMode = 'new';
    form.sessionFile = sessionOptions.value[0]?.file ?? '';
    form.cwd = '/workspace/sf';
    form.message = '';
    form.model = '';
    form.thinkLevel = '';
    form.missedPolicy = 'coalesce';
    advancedKind.value = 'cron';
    mode.value = 'once';
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

watch(
  () => props.jobId,
  () => {
    initialized.value = false;
    const j = job.value;
    if (j !== null || store.jobsLoaded) initForm(j);
  },
);

onMounted(() => {
  void store.refreshJobs();
  void loadModels();
  if (!initialized.value) initForm(job.value);
});

async function loadModels() {
  try {
    modelCatalog.value = await loadModelCatalog();
    modelError.value = '';
  } catch (e) {
    if (!(e instanceof TypeError)) modelError.value = String((e as Error)?.message ?? e);
  }
}

const modelMenuItems = computed<MenuNodeDef[]>(() => buildModelMenu(modelCatalog.value?.models ?? []));

function onModelSelect(item: MenuNodeDef) {
  const d = item.data as { model: ModelInfo; level: string } | undefined;
  if (!d) return;
  form.model = `${d.model.provider}/${d.model.id}`;
  form.thinkLevel = d.level;
}

const modelButtonText = computed(() => {
  if (!form.model) return 'Session default';
  const hit = modelCatalog.value?.models.find(
    (m) => `${m.provider}/${m.id}` === form.model || `${m.provider}/${m.name}` === form.model,
  );
  const label = hit ? `${hit.provider}/${hit.name || hit.id}` : form.model;
  return form.thinkLevel ? `${label}·${form.thinkLevel}` : label;
});

function clearModel() {
  form.model = '';
  form.thinkLevel = '';
}

watch(sessionOptions, (opts) => {
  if (form.targetMode === 'file' && !form.sessionFile && opts.length > 0) form.sessionFile = opts[0].file;
});

function setTarget(mode: 'file' | 'new' | 'reuse') {
  form.targetMode = mode;
  if (mode === 'file' && !form.sessionFile && sessionOptions.value.length > 0) {
    form.sessionFile = sessionOptions.value[0].file;
  }
}

function setDays(days: Array<string | number>) {
  periodic.days = days.map(Number).sort((a, b) => a - b);
}

const everyMinutesOptions = computed(() => {
  const list = new Set(EVERY_MINUTE_OPTIONS);
  list.add(periodic.everyMinutes);
  return [...list].sort((a, b) => a - b);
});

const hourlyMinuteOptions = computed(() => {
  const list = new Set(HOURLY_MINUTE_OPTIONS);
  list.add(periodic.atMinute);
  return [...list].sort((a, b) => a - b);
});

const everyPill = computed(() => everyMinutesOptions.value.map((m) => ({ value: m, label: String(m) })));
const hourlyPill = computed(() => hourlyMinuteOptions.value.map((m) => ({ value: m, label: pad2(m) })));

const currentCron = computed(() => {
  if (mode.value === 'advanced') return advancedKind.value === 'cron' ? form.cron.trim() : '';
  if (mode.value === 'once') return '';
  return patternToCron({ ...periodic, pattern: mode.value as BuilderPattern });
});

const offpeak = computed(() => mode.value === 'advanced' && advancedKind.value === 'offpeak');

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
  if (mode.value === 'once' && !runAtValid.value) list.push('run-at time');
  if (mode.value === 'advanced' && advancedKind.value === 'cron' && !cronOk.value)
    list.push('a valid cron expression');
  if (mode.value === 'weekly' && periodic.days.length === 0) list.push('at least one weekday');
  if (offpeak.value && !form.model.trim())
    list.push('a model (off-peak waits on that model\u2019s peak windows)');
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
    scheduleType: mode.value === 'once' ? 'once' : offpeak.value ? 'nonpeak' : 'cron',
    missedPolicy: form.missedPolicy,
    message: form.message,
    targetMode: form.targetMode,
    model: form.model || null,
    thinkLevel: form.thinkLevel || null,
    createdBy: 'web',
  };
  if (mode.value === 'once') {
    if (!runAtValid.value) throw new Error('pick a valid run-at time');
    input.runAt = runAtTs.value;
  } else if (currentCron.value) {
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

function openPicker(e: MouseEvent) {
  const el = e.currentTarget as HTMLInputElement;
  const r = el.getBoundingClientRect();
  if (e.clientX < r.right - 36) return;
  try {
    el.showPicker();
  } catch {}
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
            <PillSelector
              class="je-sched-seg"
              :options="MODE_PILL"
              :model-value="mode"
              @update:model-value="(v) => setMode(v as SchedMode)"
            />

            <div v-if="mode === 'once'" class="job-editor-field">
              <label>Run at</label>
              <input
                v-model="form.runAtLocal"
                type="datetime-local"
                class="job-editor-input je-datetime"
                @click="openPicker"
              />
              <span v-if="runAtValid" class="je-hint">{{ fmtAbs(runAtTs) }} · {{ fmtRel(runAtTs) }}</span>
              <span v-if="runAtPast" class="je-hint je-hint--warn">this time is in the past</span>
            </div>

            <template v-else-if="mode === 'advanced'">
              <div class="je-adv-kind">
                <PillSelector class="je-adv-seg" :options="ADVANCED_KIND_PILL" v-model="advancedKind" />
              </div>
              <div v-if="advancedKind === 'cron'" class="job-editor-field">
                <label>Cron expression <span class="je-label-note">min hour dom month dow · server-local time</span></label>
                <input
                  v-model="form.cron"
                  class="job-editor-input job-editor-input--mono job-editor-input--narrow"
                  placeholder="0 9 * * *"
                  spellcheck="false"
                />
                <span class="je-hint">advanced jobs keep this expression as-is — builder modes rewrite it</span>
              </div>
              <div v-else class="je-offpeak-box">
                <span class="je-offpeak-line">
                  <span class="je-offpeak-title">scheduler-picked · once a day</span>
                  <span class="je-mono">{{ form.model || 'no model picked' }}</span>
                </span>
                <span class="je-hint">{{
                  form.model
                    ? `runs at the first moment ${modelButtonText} is outside its peak windows — no fixed time, the scheduler decides`
                    : 'pick the model in the Model section below — peak windows are configured per model'
                }}</span>
              </div>
            </template>

            <template v-else>
              <div v-if="mode === 'minutes'" class="je-ctrl">
                <span class="je-ctrl-label">Run every</span>
                <div class="je-ctrl-inline">
                  <PillSelector
                    class="je-every-seg"
                    :options="everyPill"
                    :model-value="periodic.everyMinutes"
                    @update:model-value="periodic.everyMinutes = Number($event)"
                  />
                  <span class="je-unit">min</span>
                </div>
              </div>

              <div v-else-if="mode === 'hourly'" class="je-ctrl">
                <span class="je-ctrl-label">At minute past the hour</span>
                <PillSelector
                  class="je-atmin-seg"
                  :options="hourlyPill"
                  :model-value="periodic.atMinute"
                  @update:model-value="periodic.atMinute = Number($event)"
                />
              </div>

              <template v-else>
                <div v-if="mode === 'weekly'" class="je-ctrl">
                  <span class="je-ctrl-label">On days</span>
                  <MultiSelectGroup :options="DOW_OPTIONS" :model-value="periodic.days" @update:model-value="setDays" />
                  <span v-if="periodic.days.length === 0" class="je-hint je-hint--warn">pick at least one day</span>
                </div>

                <div class="je-ctrl je-ctrl-row">
                  <template v-if="mode === 'monthly'">
                    <span class="je-ctrl-label">On day</span>
                    <select v-model.number="periodic.monthDay" class="job-editor-input je-select je-time">
                      <option v-for="d in 31" :key="d" :value="d">{{ d }}</option>
                    </select>
                  </template>
                  <span class="je-ctrl-label">at</span>
                  <select v-model.number="periodic.hour" class="job-editor-input je-select je-time" title="Hour">
                    <option v-for="h in 24" :key="h" :value="h - 1">{{ pad2(h - 1) }}</option>
                  </select>
                  <span class="je-ctrl-colon">:</span>
                  <select v-model.number="periodic.minute" class="job-editor-input je-select je-time" title="Minute">
                    <option v-for="m in 60" :key="m" :value="m - 1">{{ pad2(m - 1) }}</option>
                  </select>
                </div>
                <span v-if="mode === 'monthly' && periodic.monthDay > 28" class="je-hint">
                  months without day {{ periodic.monthDay }} skip that run
                </span>
              </template>
            </template>

            <div
              v-if="mode !== 'once' && currentCron !== ''"
              class="je-cron-preview"
              :class="{ 'je-cron-preview--bad': !cronOk }"
            >
              <template v-if="cronOk">
                <div class="je-cron-ref">
                  <span class="je-cron-ref-label">cron</span>
                  <code class="je-mono">{{ currentCron }}</code>
                </div>
                <div v-if="cronDescribe" class="je-cron-desc">{{ cronDescribe }}</div>
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

            <div v-if="mode !== 'once'" class="job-editor-field">
              <label>If a run was missed while the backend was down</label>
              <PillSelector :options="MISSED_POLICY_PILL" v-model="form.missedPolicy" />
            </div>
          </section>

          <section class="je-section">
            <h3 class="je-section-title">Model <span class="je-section-note">applies to newly created sessions</span></h3>
            <div class="job-editor-field">
              <label>Model override</label>
              <div class="je-model-row">
                <Menu
                  :items="modelMenuItems"
                  :open="modelMenuOpen"
                  title="Change Model"
                  @update:open="(v) => (modelMenuOpen = v)"
                  @select="onModelSelect"
                >
                  <template #trigger="{ toggle }">
                    <button
                      class="je-model-btn"
                      type="button"
                      :disabled="!modelCatalog"
                      :title="modelError || 'Pick the model and thinking level for sessions this job creates'"
                      @click="toggle"
                    >
                      <span class="je-model-btn-text">{{
                        modelCatalog ? modelButtonText : modelError ? 'model list unavailable' : 'loading models…'
                      }}</span>
                    </button>
                  </template>
                </Menu>
                <button
                  v-if="form.model"
                  class="je-btn je-model-clear"
                  title="Back to session default"
                  @click="clearModel"
                >✕</button>
              </div>
              <span v-if="modelError" class="je-hint je-hint--warn">{{ modelError }}</span>
            </div>
          </section>

          <section class="je-section">
            <h3 class="je-section-title">Session</h3>
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
              <select v-model="form.sessionFile" class="job-editor-input je-select">
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

        </div>
      </div>

      <footer class="je-footer">
        <div class="je-footer-msg">
          <span v-if="error" class="je-error">{{ error }}</span>
          <span v-else-if="saveHint" class="je-footer-hint">{{ saveHint }}</span>
        </div>
        <div class="je-footer-actions">
          <button v-if="job" class="je-btn job-editor-danger" title="Delete job and its run history" @click="remove">Delete</button>
          <button class="je-btn" @click="cancel">Cancel</button>
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
  font-size: 16px;
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
.je-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  cursor: pointer;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23858585' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 10px 6px;
}
.je-select option,
.je-select optgroup {
  background-color: #252526;
  color: #cccccc;
}
.je-time.je-select {
  padding-right: 32px;
}
.je-btn {
  padding: 5px 14px;
  border-radius: 6px;
  border: 1px solid var(--sf-border);
  background: var(--sf-bar);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 16px;
  cursor: pointer;
}
.je-btn:hover {
  box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  color: var(--sf-text-bright);
}
.je-hint {
  font-size: 13px;
  opacity: 0.65;
}
.je-datetime {
  -webkit-appearance: none;
  appearance: none;
  color-scheme: dark;
  max-width: 300px;
  padding-right: 36px;
  cursor: pointer;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none'><rect x='3' y='5' width='18' height='16' rx='2' stroke='%23cccccc' stroke-width='2'/><path d='M8 3v4M16 3v4M3 10h18' stroke='%23cccccc' stroke-width='2' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
.je-datetime::-webkit-calendar-picker-indicator {
  display: none;
  -webkit-appearance: none;
}
.je-datetime:hover {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none'><rect x='3' y='5' width='18' height='16' rx='2' stroke='%23e0e0e0' stroke-width='2'/><path d='M8 3v4M16 3v4M3 10h18' stroke='%23e0e0e0' stroke-width='2' stroke-linecap='round'/></svg>");
}
.je-hint--warn {
  color: var(--sf-status-warn);
  opacity: 1;
}

.je-ctrl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 16px;
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
.je-ctrl-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.je-unit {
  font-size: 16px;
  opacity: 0.6;
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

.je-adv-kind {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.je-offpeak-box {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 12px;
  border-radius: var(--sf-radius-inner);
  border: 1px solid var(--sf-border);
  background: rgba(127, 127, 127, 0.07);
  overflow-wrap: anywhere;
}
.je-offpeak-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  opacity: 0.9;
}
.je-offpeak-title {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
  opacity: 0.65;
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

.je-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.je-model-btn {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  padding: 7px 32px 7px 10px;
  border-radius: var(--sf-radius-inner);
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23858585' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>") no-repeat right 10px center;
  color: inherit;
  font-size: 16px;
  font-family: var(--sf-font);
  cursor: pointer;
}
.je-model-btn:hover:not(:disabled) {
  border-color: var(--sf-accent-dim);
}
.je-model-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.je-model-btn-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.je-model-clear {
  flex-shrink: 0;
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
