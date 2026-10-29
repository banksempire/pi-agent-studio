<script setup lang="ts">
import PopupDialog from '@sf/components/PopupDialog.vue';
import type { PopupAction, PopupDocument, PopupField, PopupValues } from '@sf/types/popup';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { PeriodicPatternState } from '../cronInfo';
import { checkCron, cronToPattern, describeCron, nextCronRuns, patternToCron } from '../cronInfo';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import { loadModelCatalog } from '../modelInfo';
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
  schedKind.value = k;
}

watch(schedKind, (k, prev) => {
  if (k === 'advanced' && prev === 'periodic') {
    const expr = patternToCron({ ...periodic, pattern: pattern.value });
    if (expr) form.cron = expr;
  }
});

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

const modelButtonText = computed(() => {
  if (!form.model) return 'Session default';
  const hit = modelCatalog.value?.models.find(
    (m) => `${m.provider}/${m.id}` === form.model || `${m.provider}/${m.name}` === form.model,
  );
  const label = hit ? `${hit.provider}/${hit.name || hit.id}` : form.model;
  return form.thinkLevel ? `${label}·${form.thinkLevel}` : label;
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
    cron: form.cron,
    everyMinutes: periodic.everyMinutes,
    atMinute: periodic.atMinute,
    monthDay: periodic.monthDay,
    time: `${pad2(periodic.hour)}:${pad2(periodic.minute)}`,
    days: periodic.days,
    targetMode: form.targetMode,
    sessionFile: form.sessionFile,
    cwd: form.cwd,
    missedPolicy: form.missedPolicy,
    message: form.message,
    model: form.model,
  }),
  set: (next) => {
    if (next.name !== undefined) form.name = String(next.name);
    if (next.runAtLocal !== undefined) form.runAtLocal = String(next.runAtLocal);
    if (next.schedKind !== undefined && next.schedKind !== schedKind.value)
      setKind(next.schedKind as SchedKind);
    if (next.pattern !== undefined && next.pattern !== pattern.value)
      pattern.value = next.pattern as BuilderPattern;
    if (next.advancedKind !== undefined && next.advancedKind !== advancedKind.value) {
      advancedKind.value = next.advancedKind as 'cron' | 'offpeak';
    }
    if (next.cron !== undefined && next.cron !== form.cron) form.cron = String(next.cron);
    if (next.everyMinutes !== undefined) periodic.everyMinutes = Number(next.everyMinutes);
    if (next.atMinute !== undefined) periodic.atMinute = Number(next.atMinute);
    if (next.monthDay !== undefined) periodic.monthDay = Number(next.monthDay);
    if (typeof next.time === 'string') {
      const parts = /^([0-9]{1,2}):([0-9]{2})$/.exec(next.time);
      if (parts) {
        periodic.hour = Number(parts[1]);
        periodic.minute = Number(parts[2]);
      }
    }
    if (Array.isArray(next.days)) {
      const days = next.days.map(Number).sort((a, b) => a - b);
      if (days.join(',') !== periodic.days.join(',')) periodic.days = days;
    }
    if (next.targetMode !== undefined && next.targetMode !== form.targetMode) {
      form.targetMode = next.targetMode as 'file' | 'new' | 'reuse';
    }
    if (next.sessionFile !== undefined) form.sessionFile = String(next.sessionFile);
    if (next.cwd !== undefined) form.cwd = String(next.cwd);
    if (next.missedPolicy !== undefined) form.missedPolicy = next.missedPolicy as 'coalesce' | 'skip';
    if (next.model !== undefined && String(next.model) !== form.model) form.model = String(next.model);
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

const cronPreviewText = computed(() => {
  if (schedKind.value === 'once' || currentCron.value === '') return '';
  if (!cronOk.value) return `invalid cron: ${cronErrorText.value}`;
  const next = cronNext.value
    .slice(0, 3)
    .map((t) => `${fmtAbs(t)} (${fmtRel(t)})`)
    .join(', ');
  return `cron ${currentCron.value} — ${cronDescribe.value} · next: ${next || 'no occurrence within a year'}`;
});

const modelSelectOptions = computed(() =>
  (modelCatalog.value?.models ?? []).map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.provider}/${m.name || m.id}`,
  })),
);

const sessionSearchOptions = computed(() =>
  filteredSessions.value.map((o) => ({ value: o.file, label: o.label })),
);

const targetCards = computed(() =>
  TARGET_OPTIONS.map((o) => ({ value: o.mode, label: o.title, desc: o.desc })),
);

const dayOptions = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));

const dialogDoc = computed<PopupDocument>(() => {
  const schedule: PopupField[] = [
    { key: 'schedKind', type: 'pills', class: 'je-sched-seg', options: SCHED_KIND_PILL },
  ];
  if (schedKind.value === 'once') {
    schedule.push({
      key: 'runAtLocal',
      type: 'datetime-local',
      label: 'Run at',
      id: 'je-runat',
      hint: runAtPast.value
        ? 'this time is in the past — it will run immediately'
        : runAtValid.value
          ? `${fmtAbs(runAtTs.value)} · ${fmtRel(runAtTs.value)}`
          : undefined,
      hintTone: runAtPast.value ? 'warn' : undefined,
    });
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
        type: 'input',
        label: 'Cron expression',
        labelNote: 'min hour dom month dow · server-local time',
        mono: true,
        placeholder: '0 9 * * *',
        spellcheck: false,
        hint: cronOk.value
          ? 'advanced jobs keep this expression as-is — builder modes rewrite it'
          : cronErrorText.value,
        hintTone: cronOk.value ? undefined : 'error',
      });
    } else {
      schedule.push({
        key: 'offpeak',
        type: 'info',
        class: 'je-offpeak-info',
        text: `scheduler-picked · once a day — ${form.model || 'no model picked'}. ${
          form.model
            ? `runs at the first moment ${modelButtonText.value} is outside its peak windows — no fixed time, the scheduler decides`
            : 'pick the model in the Model section below — peak windows are configured per model'
        }`,
      });
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
      schedule.push({
        key: 'everyMinutes',
        type: 'pills',
        label: 'Run every (min)',
        class: 'je-every-seg',
        options: everyPill.value,
      });
    } else if (pattern.value === 'hourly') {
      schedule.push({
        key: 'atMinute',
        type: 'pills',
        label: 'At minute past the hour',
        class: 'je-atmin-seg',
        options: hourlyPill.value,
      });
    } else if (pattern.value === 'weekly') {
      schedule.push({
        key: 'days',
        type: 'multi',
        label: 'On days',
        options: DOW_OPTIONS,
        hint: periodic.days.length === 0 ? 'pick at least one day' : undefined,
        hintTone: 'warn',
      });
    }
    if (pattern.value !== 'minutes' && pattern.value !== 'hourly') {
      if (pattern.value === 'monthly') {
        schedule.push({
          key: 'monthDay',
          type: 'select',
          label: 'On day',
          options: dayOptions,
          hint: periodic.monthDay > 28 ? `months without day ${periodic.monthDay} skip that run` : undefined,
        });
      }
      schedule.push({ key: 'time', type: 'time', label: 'At time', id: 'je-time' });
    }
    schedule.push({
      key: 'missedPolicy',
      type: 'pills',
      label: 'If a run was missed while the backend was down',
      options: MISSED_POLICY_PILL,
    });
  }
  if (cronPreviewText.value) {
    schedule.push({
      key: 'cronPreview',
      type: 'info',
      class: cronOk.value ? 'je-cron-preview-info' : 'je-cron-preview-info--bad',
      text: cronPreviewText.value,
    });
  }
  return {
    title: dialogTitle.value,
    h1: [
      {
        id: 'job',
        title: 'Job',
        h2: [
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
          { title: 'Schedule', fields: schedule },
          {
            title: 'Model',
            note: modelNote.value,
            fields: [
              {
                key: 'model',
                type: 'select',
                label: 'Model override',
                blankLabel: 'session default',
                options: modelSelectOptions.value,
                hint: modelError.value || undefined,
                hintTone: modelError.value ? 'error' : undefined,
              },
            ],
          },
          {
            title: 'Session',
            fields: [
              {
                key: 'targetMode',
                type: 'cards',
                label: 'Target',
                options: targetCards.value,
              },
              ...(form.targetMode === 'file'
                ? [
                    {
                      key: 'sessionFile',
                      type: 'search' as const,
                      label: 'Session',
                      id: 'je-session',
                      options: sessionSearchOptions.value,
                      placeholder: 'filter sessions…',
                    },
                  ]
                : [
                    {
                      key: 'cwd',
                      type: 'input' as const,
                      label: 'Working directory',
                      mono: true,
                      placeholder: '/workspace/sf',
                      spellcheck: false,
                      id: 'je-cwd',
                    },
                  ]),
            ],
          },
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

  </PopupDialog>
</template>
