<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { PeakHourEntry } from '../peakHours';
import {
  browserUtcOffset,
  createPeakHours,
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
const startField = ref(
  editing ? fmtHm(toLocalMinutes(parseHm(src.startUtc) ?? 540, utcOffset.value)) : '09:00',
);
const endField = ref(editing ? fmtHm(toLocalMinutes(parseHm(src.endUtc) ?? 1020, utcOffset.value)) : '17:00');
const startUtcMin = ref(540);
const endUtcMin = ref(1020);

const formError = ref('');
const busy = ref(false);
const startInput = ref<{ focus: () => void } | null>(null);

const boundKey = computed(() => (editing ? src.key : chosenKey.value));

const dialogTarget = ref<HTMLElement | 'body'>('body');

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
  if (parseHm(startField.value) === null) list.push('start time');
  if (parseHm(endField.value) === null) list.push('end time');
  if (parseHm(startField.value) !== null && parseHm(endField.value) !== null) {
    if (startUtcMin.value === endUtcMin.value) list.push('a window (start ≠ end)');
  }
  return list;
});

const canSave = computed(() => problems.value.length === 0 && !busy.value);

function close() {
  if (busy.value) return;
  emit('close');
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

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  dialogTarget.value = (document.querySelector('.sf-root') as HTMLElement | null) ?? 'body';
  void nextTick(() => startInput.value?.focus());
  window.addEventListener('keydown', onDocKey);
});

onUnmounted(() => window.removeEventListener('keydown', onDocKey));

function onBackdropDown(e: MouseEvent) {
  if (e.target === e.currentTarget) close();
}
</script>

<template>
  <Teleport :to="dialogTarget">
    <div class="aph-dialog-backdrop" @mousedown="onBackdropDown">
      <div class="aph-dialog" role="dialog" aria-modal="true" :aria-label="dialogTitle">
        <header class="aph-dialog-head">
          <span class="aph-dialog-title">{{ dialogTitle }}</span>
          <button class="aph-btn aph-dialog-close" title="Close" @click="close">
            <SvgIcon name="✕" />
          </button>
        </header>
        <div class="aph-dialog-body">
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
                ref="startInput"
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
        </div>
        <footer class="aph-dialog-foot">
          <button class="aph-btn aph-cancel" :disabled="busy" @click="close">Cancel</button>
          <button class="aph-btn aph-btn--accent aph-save" :disabled="!canSave" @click="save">
            {{ busy ? 'Saving…' : 'Save' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.aph-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}

.aph-dialog {
  width: min(440px, 100%);
  background: var(--sf-bg-lighter);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius);
  box-shadow: var(--sf-shadow);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 24px);
}

.aph-dialog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sf-border);
}

.aph-dialog-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  color: var(--sf-text-bright);
}

.aph-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 14px;
  overflow-y: auto;
}

.aph-dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--sf-border);
}

.aph-save {
  min-width: 88px;
}

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

.aph-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--sf-bg);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 13px;
  padding: 3px 10px;
  cursor: pointer;
}

.aph-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (hover: hover) {
  .aph-btn:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.aph-btn--accent {
  background: var(--sf-accent);
  border-color: var(--sf-accent);
  color: var(--sf-text-on-accent);
}

@media (hover: hover) {
  .aph-btn--accent:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-on-accent);
  }
}

.aph-dialog-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: var(--sf-radius-sm);
  background: var(--sf-danger);
  border-color: var(--sf-danger);
  color: var(--sf-text-on-accent);
}

@media (hover: hover) {
  .aph-dialog-close:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-on-accent);
  }
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
