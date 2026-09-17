<script setup lang="ts">
import Menu from '@sf/components/Menu.vue';
import MultiSelectGroup from '@sf/components/MultiSelectGroup.vue';
import PillSelector from '@sf/components/PillSelector.vue';
import PopupDialog from '@sf/components/PopupDialog.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import type { PopupAction, PopupDocument, PopupField, PopupValues } from '@sf/types/popup';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { PeriodicPatternState } from '../cronInfo';
import { checkCron, cronToPattern, describeCron, nextCronRuns, patternToCron } from '../cronInfo';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import { modelMenuItems as buildModelMenu, loadModelCatalog } from '../modelInfo';
import type { JobInfo } from '../store/chat';
import { useChatStore } from '../store/chat';

const props = defineProps<{ job: JobInfo | null }>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const store = useChatStore();

const src = props.job;
const editing = src !== null;

const error = ref('');
const busy = ref(false);
const sessionFilter = ref('');

type SchedKind = 'once' | 'periodic' | 'advanced';
type BuilderPattern = PeriodicPatternState['pattern'];
const SCHED_KIND_PILL = [
  { value: 'once', label: 'Once', title: 'run a single time' },
  { value: 'periodic', label: 'Periodic', title: 'on a repeating cadence' },
  { value: 'advanced', label: 'Advanced', title: 'raw cron expression, or scheduler-picked off-peak runs' },
];
const PERIODIC_PILL = [
  { value: 'minutes', label: 'Minutes', title: 'every N minutes, all day' },
  { value: 'hourly', label: 'Hourly', title: 'once every hour, at a set minute' },
  { value: 'daily', label: 'Daily', title: 'once a day, at a set time' },
  { value: 'weekly', label: 'Weekly', title: 'on chosen weekdays, at a set time' },
  { value: 'monthly', label: 'Monthly', title: 'on a day of the month, at a set time' },
];
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
  {
    mode: 'reuse',
    title: 'One per cwd',
    desc: 'This job keeps one persistent session per working directory',
  },
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

const schedKind = ref<SchedKind>('once');
const pattern = ref<BuilderPattern>('daily');
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

function setKind(k: SchedKind) {
  if (k === schedKind.value) return;
  if (k === 'advanced' && schedKind.value === 'periodic') {
    const expr = patternToCron({ ...periodic, pattern: pattern.value });
    if (expr) form.cron = expr;
  }
  schedKind.value = k;
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
      schedKind.value = 'once';
    } else if (j.scheduleType === 'nonpeak') {
      schedKind.value = 'advanced';
      advancedKind.value = 'offpeak';
    } else {
      const p = cronToPattern(j.cron ?? '');
      if (p) {
        const { pattern: _pattern, ...fields } = p;
        Object.assign(periodic, fields);
        pattern.value = p.pattern;
        schedKind.value = 'periodic';
      } else {
        schedKind.value = 'advanced';
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
    pattern.value = 'daily';
    schedKind.value = 'once';
  }
}

onMounted(() => {
  void loadModels();
  initForm(src);
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
  if (schedKind.value === 'advanced') return advancedKind.value === 'cron' ? form.cron.trim() : '';
  if (schedKind.value === 'once') return '';
  return patternToCron({ ...periodic, pattern: pattern.value });
});

const offpeak = computed(() => schedKind.value === 'advanced' && advancedKind.value === 'offpeak');

const modelNote = computed(() => {
  if (form.targetMode === 'new') return 'applied to each run’s fresh session';
  if (form.targetMode === 'reuse') return 'applied when this job’s per-cwd session is first created';
  return 'not applied — an existing session keeps its own model';
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
  if (schedKind.value === 'once' && !runAtValid.value) list.push('run-at time');
  if (schedKind.value === 'advanced' && advancedKind.value === 'cron' && !cronOk.value)
    list.push('a valid cron expression');
  if (schedKind.value === 'periodic' && pattern.value === 'weekly' && periodic.days.length === 0)
    list.push('at least one weekday');
  if (offpeak.value && !form.model.trim()) list.push('a model (off-peak waits on that model’s peak windows)');
  if (form.targetMode === 'file' && !form.sessionFile) list.push('target session');
  if (form.targetMode !== 'file' && !form.cwd.trim()) list.push('working directory');
  if (!form.message.trim()) list.push('message');
  return list;
});
const canSave = computed(() => problems.value.length === 0 && !busy.value);
const saveHint = computed(() => (problems.value.length === 0 ? '' : `missing: ${problems.value.join(', ')}`));

const dialogTitle = computed(() => (editing ? `Edit job — ${src.name}` : 'New job'));

function buildInput() {
  const input: Record<string, unknown> = {
    name: form.name,
    scheduleType: schedKind.value === 'once' ? 'once' : offpeak.value ? 'nonpeak' : 'cron',
    missedPolicy: form.missedPolicy,
    message: form.message,
    targetMode: form.targetMode,
    model: form.model || null,
    thinkLevel: form.thinkLevel || null,
    createdBy: 'web',
  };
  if (schedKind.value === 'once') {
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
    if (editing) await store.updateJob(src.id, input);
    else await store.createJob(input);
    emit('saved');
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (!src) return;
  if (!window.confirm(`Delete job '${src.name}' and its run history?`)) return;
  error.value = '';
  try {
    await store.deleteJob(src.id);
    emit('saved');
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
}

function onRequestClose() {
  if (!busy.value) emit('close');
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
const dialogValues = computed({
  get: (): PopupValues => ({
    name: form.name,
    schedKind: schedKind.value,
    pattern: pattern.value,
    advancedKind: advancedKind.value,
    everyMinutes: periodic.everyMinutes,
    atMinute: periodic.atMinute,
    monthDay: periodic.monthDay,
    hour: periodic.hour,
    minute: periodic.minute,
    missedPolicy: form.missedPolicy,
    message: form.message,
  }),
  set: (next) => {
    if (next.name !== undefined) form.name = String(next.name);
    if (next.schedKind !== undefined && next.schedKind !== schedKind.value)
      setKind(next.schedKind as SchedKind);
    if (next.pattern !== undefined && next.pattern !== pattern.value)
      pattern.value = next.pattern as BuilderPattern;
    if (next.advancedKind !== undefined && next.advancedKind !== advancedKind.value) {
      advancedKind.value = next.advancedKind as 'cron' | 'offpeak';
    }
    if (next.everyMinutes !== undefined) periodic.everyMinutes = Number(next.everyMinutes);
    if (next.atMinute !== undefined) periodic.atMinute = Number(next.atMinute);
    if (next.monthDay !== undefined) periodic.monthDay = Number(next.monthDay);
    if (next.hour !== undefined) periodic.hour = Number(next.hour);
    if (next.minute !== undefined) periodic.minute = Number(next.minute);
    if (next.missedPolicy !== undefined) form.missedPolicy = next.missedPolicy as 'coalesce' | 'skip';
    if (next.message !== undefined) form.message = String(next.message);
  },
});

const dialogActions = computed((): PopupAction[] => [
  ...(editing
    ? [
        {
          id: 'delete',
          label: 'Delete',
          tone: 'danger' as const,
          align: 'left' as const,
          disabled: busy.value,
          class: 'je-delete',
        },
      ]
    : []),
  { id: 'cancel', label: 'Cancel', close: true, disabled: busy.value, class: 'je-cancel' },
  {
    id: 'save',
    label: busy.value ? 'Saving…' : editing ? 'Save changes' : 'Create job',
    tone: 'accent',
    disabled: !canSave.value,
    title: saveHint.value,
    class: 'je-save',
  },
]);

const dialogDoc = computed<PopupDocument>(() => {
  const schedule: PopupField[] = [
    { key: 'schedKind', type: 'pills', class: 'je-sched-seg', options: SCHED_KIND_PILL },
  ];
  if (schedKind.value === 'once') {
    schedule.push({ key: 'runAtLocal', type: 'slot', label: 'Run at' });
  } else if (schedKind.value === 'advanced') {
    schedule.push({
      key: 'advancedKind',
      type: 'pills',
      label: 'Type',
      class: 'je-adv-seg',
      options: ADVANCED_KIND_PILL,
    });
    if (advancedKind.value === 'cron') {
      schedule.push({
        key: 'cron',
        type: 'slot',
        label: 'Cron expression',
        labelNote: 'min hour dom month dow · server-local time',
      });
    } else {
      schedule.push({ key: 'offpeak', type: 'slot' });
    }
  } else {
    schedule.push({
      key: 'pattern',
      type: 'pills',
      label: 'Repeat',
      class: 'je-periodic-seg',
      options: PERIODIC_PILL,
    });
    if (pattern.value === 'minutes') {
      schedule.push({ key: 'every', type: 'slot', label: 'Run every' });
    } else if (pattern.value === 'hourly') {
      schedule.push({
        key: 'atMinute',
        type: 'pills',
        label: 'At minute past the hour',
        class: 'je-atmin-seg',
        options: hourlyPill.value,
      });
    } else if (pattern.value === 'weekly') {
      schedule.push({ key: 'days', type: 'slot', label: 'On days' });
    }
    if (pattern.value !== 'minutes' && pattern.value !== 'hourly') {
      schedule.push({ key: 'time', type: 'slot', label: pattern.value === 'monthly' ? 'On day' : 'At time' });
    }
    schedule.push({
      key: 'missedPolicy',
      type: 'pills',
      label: 'If a run was missed while the backend was down',
      options: MISSED_POLICY_PILL,
    });
  }
  return {
    title: dialogTitle.value,
    sections: [
      {
        title: 'Job name',
        fields: [
          {
            key: 'name',
            type: 'input',
            placeholder: 'nightly maintenance',
            spellcheck: false,
          },
        ],
      },
      { title: 'Schedule', fields: schedule, extraSlot: 'schedule-extra' },
      {
        title: 'Model',
        note: modelNote.value,
        fields: [{ key: 'model', type: 'slot', label: 'Model override' }],
      },
      { title: 'Session', fields: [{ key: 'session', type: 'slot' }] },
      {
        title: 'Message',
        fields: [
          {
            key: 'message',
            type: 'textarea',
            rows: 5,
            placeholder:
              'What the agent should do each time this job fires — e.g. “run the full check suite and summarize failures.”',
          },
        ],
      },
    ],
    actions: dialogActions.value,
  };
});
</script>

<template>
  <PopupDialog
    v-model:values="dialogValues"
    :doc="dialogDoc"
    :open="true"
    wide
    :busy="busy"
    :error="error"
    :foot-note="saveHint"
    :disable-close="busy"
    @action="(id) => (id === 'save' ? save() : id === 'delete' ? remove() : undefined)"
    @close="onRequestClose"
  >
    <template #preamble>
      <div v-if="src" class="je-meta">
        <span class="je-mono je-meta-id" :title="src.id">{{ src.id }}</span>
        <span>created {{ fmtAbs(src.createdAt) }}</span>
        <span>by {{ src.createdBy || '—' }}</span>
        <span v-if="src.enabled">next run {{ fmtRel(src.nextDue) }}</span>
        <span v-else class="je-paused">paused</span>
        <span v-if="src.lastRun">
          last {{ src.lastRun.status }} {{ fmtRel(src.lastRun.finishedAt ?? src.lastRun.queuedAt) }}
        </span>
      </div>
    </template>

    <template #schedule-extra>
      <div
        v-if="schedKind !== 'once' && currentCron !== ''"
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
    </template>

    <template #field-runAtLocal>
      <input
        id="je-runat"
        v-model="form.runAtLocal"
        type="datetime-local"
        class="sf-form-input je-datetime"
        @click="openPicker"
      />
      <span v-if="runAtValid" class="je-hint">{{ fmtAbs(runAtTs) }} · {{ fmtRel(runAtTs) }}</span>
      <span v-if="runAtPast" class="je-hint je-hint--warn">this time is in the past — it will run immediately</span>
    </template>

    <template #field-every>
      <div class="je-ctrl-inline">
        <PillSelector
          class="je-every-seg"
          :options="everyPill"
          :model-value="periodic.everyMinutes"
          @update:model-value="periodic.everyMinutes = Number($event)"
        />
        <span class="je-unit">min</span>
      </div>
    </template>

    <template #field-days>
      <MultiSelectGroup :options="DOW_OPTIONS" :model-value="periodic.days" @update:model-value="setDays" />
      <span v-if="periodic.days.length === 0" class="je-hint je-hint--warn">pick at least one day</span>
    </template>

    <template #field-time>
      <div class="je-ctrl-row">
        <select
          v-if="pattern === 'monthly'"
          v-model.number="periodic.monthDay"
          class="sf-form-input sf-form-select je-time"
          title="Day of month"
        >
          <option v-for="d in 31" :key="d" :value="d">{{ d }}</option>
        </select>
        <span v-if="pattern === 'monthly'" class="je-label">at</span>
        <select v-model.number="periodic.hour" class="sf-form-input sf-form-select je-time" title="Hour">
          <option v-for="h in 24" :key="h" :value="h - 1">{{ pad2(h - 1) }}</option>
        </select>
        <span class="je-ctrl-colon">:</span>
        <select v-model.number="periodic.minute" class="sf-form-input sf-form-select je-time" title="Minute">
          <option v-for="m in 60" :key="m" :value="m - 1">{{ pad2(m - 1) }}</option>
        </select>
      </div>
      <span v-if="pattern === 'monthly' && periodic.monthDay > 28" class="je-hint">
        months without day {{ periodic.monthDay }} skip that run
      </span>
    </template>

    <template #field-cron>
      <input
        id="je-cron"
        v-model="form.cron"
        class="sf-form-input sf-form-input--mono"
        placeholder="0 9 * * *"
        spellcheck="false"
      />
      <span class="je-hint">advanced jobs keep this expression as-is — builder modes rewrite it</span>
    </template>

    <template #field-offpeak>
      <div class="je-offpeak-box">
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

    <template #field-model>
      <div class="je-model-row">
        <Menu
          :items="modelMenuItems"
          :open="modelMenuOpen"
          title="Change Model"
          @update:open="(v) => (modelMenuOpen = v)"
          @select="onModelSelect"
        >
          <template #trigger="{ toggle }">
            <button class="je-model-btn" type="button" :disabled="!modelCatalog" :title="modelError || modelNote" @click="toggle">
              <span class="je-model-btn-text">{{
                modelCatalog ? modelButtonText : modelError ? 'model list unavailable' : 'loading models…'
              }}</span>
            </button>
          </template>
        </Menu>
        <button v-if="form.model" class="je-btn je-model-clear" title="Back to session default" @click="clearModel">
          ✕
        </button>
      </div>
      <span v-if="modelError" class="je-hint je-hint--warn">{{ modelError }}</span>
    </template>

    <template #field-session>
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
      <div v-if="form.targetMode === 'file'" class="je-field">
        <input
          v-if="store.sessions.length > 8"
          v-model="sessionFilter"
          class="sf-form-input je-session-filter"
          placeholder="filter sessions…"
        />
        <select id="je-session" v-model="form.sessionFile" class="sf-form-input sf-form-select">
          <option v-if="filteredSessions.length === 0" :value="form.sessionFile">no match for “{{ sessionFilter }}”</option>
          <option v-for="s in filteredSessions" :key="s.file" :value="s.file">{{ s.label }}</option>
        </select>
      </div>
      <div v-else class="je-field">
        <input
          id="je-cwd"
          v-model="form.cwd"
          class="sf-form-input sf-form-input--mono"
          placeholder="/workspace/sf"
          spellcheck="false"
        />
      </div>
    </template>

  </PopupDialog>
</template>

<style scoped>

.je-meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--sf-text-muted);
}
.je-meta-id {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.je-paused {
  color: var(--sf-status-warn);
}

.je-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.je-label-note {
  font-size: 11px;
  opacity: 0.75;
}
.je-time {
  width: auto;
  min-width: 84px;
  padding: 6px 8px;
  flex-shrink: 0;
}
.je-btn {
  padding: 5px 12px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: var(--sf-bg);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 13px;
  cursor: pointer;
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

.je-label {
  font-size: 12px;
  color: var(--sf-text-muted);
}

.je-hint {
  font-size: 12px;
  opacity: 0.65;
}

.je-hint--warn {
  color: var(--sf-status-warn);
  opacity: 1;
}
.je-ctrl-row {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.je-ctrl-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.je-unit {
  font-size: 13px;
  opacity: 0.6;
}
.je-every-seg {
  flex: 1 1 auto;
  min-width: 0;
}
.je-ctrl-colon {
  font-size: 13px;
  opacity: 0.6;
}

.je-cron-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 11px;
  border-radius: var(--sf-radius-sm);
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
  font-size: 12px;
  opacity: 0.85;
}
.je-cron-ref-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
  opacity: 0.6;
}
.je-cron-ref code {
  font-size: 12px;
}
.je-cron-desc {
  font-size: 13px;
  color: var(--sf-text-bright);
}
.je-cron-next {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
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
  font-size: 13px;
  color: var(--sf-danger);
}

.je-offpeak-box {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 11px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: rgba(127, 127, 127, 0.07);
  overflow-wrap: anywhere;
}
.je-offpeak-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
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
  grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr));
  gap: 8px;
}
.je-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 8px 10px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: transparent;
  color: var(--sf-text);
  text-align: left;
  cursor: pointer;
  font-family: var(--sf-font);
}
.je-card--on {
  background: var(--sf-accent-soft, rgba(96, 165, 250, 0.12));
  border-color: var(--sf-accent);
}
.je-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--sf-text-bright);
}
.je-card-desc {
  font-size: 12px;
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
  height: 36px;
  max-width: 100%;
  min-width: 0;
  padding: 7px 32px 7px 10px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23858585' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>") no-repeat right 10px center;
  color: var(--sf-text);
  font-size: 14px;
  font-family: var(--sf-font);
  cursor: pointer;
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
</style>
