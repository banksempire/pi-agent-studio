<script setup lang="ts">
import Dialog from '@sf/components/Dialog.vue';
import MultiSelectGroup from '@sf/components/MultiSelectGroup.vue';
import { computed, ref } from 'vue';
import type { PeakHourEntry } from '../peakHours';
import {
  ALL_WEEKDAYS,
  browserUtcOffset,
  createPeakHours,
  DOW_OPTIONS,
  fmtHm,
  OFFSET_OPTIONS,
  offsetLabel,
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
    `= ${fmtHm(startUtcMin.value)}–${fmtHm(endUtcMin.value)} UTC${wraps.value ? ' · wraps midnight' : ''}`,
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
  <Dialog
    :open="true"
    :title="dialogTitle"
    :close-on-backdrop="!busy"
    :close-on-escape="!busy"
    @close="onRequestClose"
  >
    <div class="aph-field">
      <label v-if="selectable" class="aph-label" for="aph-model">Model</label>
      <span v-else class="aph-label">Model</span>
      <select v-if="selectable" id="aph-model" v-model="chosenKey" class="aph-input">
        <optgroup v-for="g in groupedChoices" :key="g.provider" :label="g.provider">
          <option v-for="o in g.options" :key="o.key" :value="o.key">{{ o.label }}</option>
        </optgroup>
      </select>
      <template v-else>
        <div class="aph-model-bound" :title="boundKey">{{ boundKey }}</div>
        <span v-if="!editing" class="aph-field-note">bound to the model selected in the catalog</span>
      </template>
    </div>
    <div class="aph-times">
      <div class="aph-field">
        <label class="aph-label" for="aph-start">Peak start</label>
        <TimeField
          id="aph-start"
          :model-value="startField"
          @update:model-value="(v) => onStartTime(v)"
        />
      </div>
      <div class="aph-field">
        <label class="aph-label" for="aph-end">Peak end</label>
        <TimeField
          id="aph-end"
          :model-value="endField"
          @update:model-value="(v) => onEndTime(v)"
        />
      </div>
    </div>
    <div class="aph-field">
      <span class="aph-label">Days</span>
      <MultiSelectGroup
        class="aph-days"
        :options="DOW_OPTIONS"
        :model-value="weekdays"
        @update:model-value="(v) => (weekdays = v as number[])"
      />
    </div>
    <div class="aph-field">
      <label class="aph-label" for="aph-tz">Timezone</label>
      <select
        id="aph-tz"
        v-model.number="utcOffset"
        class="aph-input"
        @change="rederiveFieldsFromUtc"
      >
        <option v-for="o in OFFSET_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="aph-live" :title="liveHint">{{ liveHint }}</div>
    <div class="aph-field">
      <label class="aph-label" for="aph-note">Note</label>
      <input id="aph-note" v-model="note" class="aph-input" placeholder="rate-limit window">
    </div>
    <div v-if="formError" class="aph-error">{{ formError }}</div>
    <div v-else-if="problems.length" class="aph-live aph-live--warn">
      needs {{ problems.join(', ') }}
    </div>
    <template #actions>
      <button class="sf-dialog-btn aph-cancel" type="button" :disabled="busy" @click="onRequestClose">
        Cancel
      </button>
      <button
        class="sf-dialog-btn sf-dialog-btn--accent aph-save"
        type="button"
        :disabled="!canSave"
        @click="save"
      >
        {{ busy ? 'Saving…' : 'Save' }}
      </button>
    </template>
  </Dialog>
</template>

<style scoped>
.aph-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.aph-label {
  font-size: 12px;
  color: var(--sf-text-muted);
}

.aph-field-note {
  font-size: 12px;
  color: var(--sf-text-muted);
}

.aph-model-bound {
  min-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  color: var(--sf-text-bright);
}

.aph-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--sf-bg);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 14px;
  padding: 5px 7px;
  outline: none;
}

.aph-input:focus {
  border-color: var(--sf-accent);
}

.aph-times {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.aph-days {
  font-size: 13px;
}

.aph-live {
  font-size: 12px;
  color: var(--sf-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aph-live--warn {
  color: var(--sf-danger);
}

.aph-error {
  padding: 5px 7px;
  border-radius: var(--sf-radius-sm);
  font-size: 12px;
  background: color-mix(in srgb, var(--sf-danger) 14%, transparent);
  color: var(--sf-danger);
  word-break: break-word;
}
</style>
