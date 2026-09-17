<script setup lang="ts">
import PopupDialog from '@sf/components/PopupDialog.vue';
import type { PopupAction, PopupDocument, PopupField, PopupValues } from '@sf/types/popup';
import { computed, ref } from 'vue';
import type { PeakHourEntry } from '../peakHours';
import {
  ALL_WEEKDAYS,
  browserUtcOffset,
  createPeakHours,
  DOW_OPTIONS,
  fmtHm,
  OFFSET_OPTIONS,
  parseHm,
  splitModelKey,
  toLocalMinutes,
  toUtcMinutes,
  updatePeakHours,
} from '../peakHours';
import TimeField from './TimeField.vue';

export interface PeakHourModelChoice {
  key: string;
  provider: string;
  label: string;
}

const props = defineProps<{
  entry: PeakHourEntry | null;
  modelKey: string;
  modelChoices: PeakHourModelChoice[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const src = props.entry;
const editing = src !== null;
const selectable = !editing && props.modelChoices.length > 0;

const chosenKey = ref(
  selectable
    ? (props.modelChoices.find((c) => c.key === props.modelKey) ?? props.modelChoices[0]).key
    : props.modelKey,
);
const note = ref(editing ? src.note : '');
const utcOffset = ref(editing ? src.utcOffset : browserUtcOffset());
const weekdays = ref<number[]>([...(editing ? (src.weekdays ?? ALL_WEEKDAYS) : ALL_WEEKDAYS)]);
const startField = ref(
  editing ? fmtHm(toLocalMinutes(parseHm(src.startUtc) ?? 540, utcOffset.value)) : '09:00',
);
const endField = ref(editing ? fmtHm(toLocalMinutes(parseHm(src.endUtc) ?? 1020, utcOffset.value)) : '17:00');
const startUtcMin = ref(540);
const endUtcMin = ref(1020);

const formError = ref('');
const busy = ref(false);

const boundKey = computed(() => (editing ? src.key : chosenKey.value));

const groupedChoices = computed(() => {
  const groups: Array<{ provider: string; options: PeakHourModelChoice[] }> = [];
  for (const c of props.modelChoices) {
    let g = groups.find((x) => x.provider === c.provider);
    if (!g) {
      g = { provider: c.provider, options: [] };
      groups.push(g);
    }
    g.options.push(c);
  }
  return groups;
});

function recomputeUtcFromFields() {
  const s = parseHm(startField.value);
  const e = parseHm(endField.value);
  if (s !== null) startUtcMin.value = toUtcMinutes(s, utcOffset.value);
  if (e !== null) endUtcMin.value = toUtcMinutes(e, utcOffset.value);
}

function onStartTime(v: string) {
  startField.value = v;
  recomputeUtcFromFields();
}

function onEndTime(v: string) {
  endField.value = v;
  recomputeUtcFromFields();
}

function rederiveFieldsFromUtc() {
  startField.value = fmtHm(toLocalMinutes(startUtcMin.value, utcOffset.value));
  endField.value = fmtHm(toLocalMinutes(endUtcMin.value, utcOffset.value));
}

recomputeUtcFromFields();

const dialogTitle = computed(() => (editing ? `Edit peak hours — ${src.key}` : 'Add peak hours'));

const wraps = computed(() => startUtcMin.value !== endUtcMin.value && endUtcMin.value < startUtcMin.value);

const liveHint = computed(
  () =>
    `= (UTC) ${fmtHm(startUtcMin.value)}-${fmtHm(endUtcMin.value)}${wraps.value ? ' · wraps midnight' : ''}`,
);

const problems = computed<string[]>(() => {
  const list: string[] = [];
  if (!splitModelKey(boundKey.value)) list.push('model');
  if (weekdays.value.length === 0) list.push('at least one weekday');
  if (parseHm(startField.value) === null) list.push('start time');
  if (parseHm(endField.value) === null) list.push('end time');
  if (parseHm(startField.value) !== null && parseHm(endField.value) !== null) {
    if (startUtcMin.value === endUtcMin.value) list.push('a window (start ≠ end)');
  }
  return list;
});

const canSave = computed(() => problems.value.length === 0 && !busy.value);

const dialogActions = computed((): PopupAction[] => [
  { id: 'cancel', label: 'Cancel', close: true, disabled: busy.value, class: 'aph-cancel' },
  {
    id: 'save',
    label: busy.value ? 'Saving…' : 'Save',
    tone: 'accent',
    disabled: !canSave.value,
    class: 'aph-save',
  },
]);

const dialogDoc = computed<PopupDocument>(() => {
  const modelField: PopupField = selectable
    ? {
        key: 'model',
        type: 'select',
        label: 'Model',
        id: 'aph-model',
        options: groupedChoices.value.map((g) => ({
          group: g.provider,
          options: g.options.map((o) => ({ value: o.key, label: o.label })),
        })),
      }
    : { key: 'model', type: 'slot', label: 'Model' };
  return {
    title: dialogTitle.value,
    sections: [
      { title: 'Model', fields: [modelField] },
      {
        title: 'Peak hour',
        fields: [
          { key: 'start', type: 'slot', label: 'Peak start', half: true },
          { key: 'end', type: 'slot', label: 'Peak end', half: true },
          { key: 'live', type: 'info', text: liveHint.value, class: 'aph-live' },
        ],
      },
      {
        title: 'Weekdays',
        fields: [{ key: 'weekdays', type: 'multi', options: DOW_OPTIONS, class: 'aph-days' }],
      },
      {
        title: 'Timezone',
        fields: [
          { key: 'utcOffset', type: 'select', label: 'UTC offset', id: 'aph-tz', options: OFFSET_OPTIONS },
        ],
      },
      {
        title: 'Note',
        fields: [
          {
            key: 'note',
            type: 'input',
            label: 'Note',
            id: 'aph-note',
            placeholder: 'rate-limit window',
            spellcheck: false,
          },
          ...(problems.value.length
            ? [
                {
                  key: 'problems',
                  type: 'info' as const,
                  text: `needs ${problems.value.join(', ')}`,
                  class: 'aph-live--warn',
                  hintTone: 'warn' as const,
                },
              ]
            : []),
        ],
      },
    ],
    actions: dialogActions.value,
  };
});

const dialogValues = computed({
  get: (): PopupValues => ({
    model: chosenKey.value,
    start: startField.value,
    end: endField.value,
    weekdays: weekdays.value,
    utcOffset: utcOffset.value,
    note: note.value,
  }),
  set: (next) => {
    if (next.model !== undefined) chosenKey.value = String(next.model);
    if (next.start !== undefined && next.start !== startField.value) onStartTime(String(next.start));
    if (next.end !== undefined && next.end !== endField.value) onEndTime(String(next.end));
    if (Array.isArray(next.weekdays)) {
      const days = next.weekdays.map(Number).sort((a, b) => a - b);
      if (days.join(',') !== weekdays.value.join(',')) weekdays.value = days;
    }
    if (next.utcOffset !== undefined && Number(next.utcOffset) !== utcOffset.value) {
      utcOffset.value = Number(next.utcOffset);
      rederiveFieldsFromUtc();
    }
    if (next.note !== undefined) note.value = String(next.note);
  },
});

function onRequestClose() {
  if (!busy.value) emit('close');
}

async function save() {
  if (!canSave.value) return;
  const key = splitModelKey(boundKey.value);
  if (!key) return;
  busy.value = true;
  formError.value = '';
  try {
    const input = {
      provider: key.provider,
      model: key.model,
      start: startField.value,
      end: endField.value,
      utcOffset: utcOffset.value,
      weekdays: [...weekdays.value],
      note: note.value.trim(),
    };
    if (editing) await updatePeakHours(src.id, input);
    else await createPeakHours(input);
    emit('saved');
  } catch (e) {
    if (!(e instanceof TypeError)) formError.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PopupDialog
    v-model:values="dialogValues"
    :doc="dialogDoc"
    :open="true"
    wide
    :busy="busy"
    :error="formError"
    :disable-close="busy"
    @action="(id) => (id === 'save' ? save() : undefined)"
    @close="onRequestClose"
  >
    <template #field-start>
      <TimeField id="aph-start" :model-value="startField" @update:model-value="(v) => onStartTime(v)" />
    </template>
    <template #field-end>
      <TimeField id="aph-end" :model-value="endField" @update:model-value="(v) => onEndTime(v)" />
    </template>
    <template v-if="!selectable" #field-model>
      <div class="aph-model-bound" :title="boundKey">{{ boundKey }}</div>
      <span v-if="!editing" class="aph-field-note">bound to the model selected in the catalog</span>
    </template>
  </PopupDialog>
</template>

<style scoped>
.aph-model-bound {
  height: 36px;
  display: flex;
  align-items: center;
  padding: 7px 10px;
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  background: rgba(0, 0, 0, 0.15);
  color: var(--sf-text);
  font-family: var(--sf-mono, monospace);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aph-field-note {
  font-size: 12px;
  color: var(--sf-text-muted);
}
.aph-live {
  font-family: var(--sf-mono, monospace);
  font-size: 12px;
  color: var(--sf-text-muted);
}
</style>
