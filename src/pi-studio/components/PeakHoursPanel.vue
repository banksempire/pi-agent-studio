<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { ModelCatalogView } from '../modelInfo';
import { loadModelCatalog } from '../modelInfo';
import {
  browserUtcOffset,
  createPeakHours,
  deletePeakHours,
  fmtHm,
  loadPeakHours,
  OFFSET_OPTIONS,
  offsetLabel,
  type PeakHourEntry,
  parseHm,
  splitModelKey,
  toLocalMinutes,
  toUtcMinutes,
  updatePeakHours,
} from '../peakHours';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const entries = ref<PeakHourEntry[]>([]);
const catalog = ref<ModelCatalogView | null>(null);
const error = ref('');
const formError = ref('');
const busy = ref(false);
const loaded = ref(false);

const editor = reactive<{
  open: boolean;
  id: string | null;
  modelKey: string;
  note: string;
  utcOffset: number;
}>({ open: false, id: null, modelKey: '', note: '', utcOffset: 0 });

const startField = ref('09:00');
const endField = ref('17:00');
const startUtcMin = ref(540);
const endUtcMin = ref(1020);
const startInput = ref<HTMLInputElement | null>(null);

const selectedModelKey = computed(() => {
  const d = store.modelDetail;
  return d ? `${d.model.provider}/${d.model.id}` : '';
});

const dialogTarget = ref<HTMLElement | 'body'>('body');

async function reload() {
  try {
    entries.value = await loadPeakHours();
    error.value = '';
  } catch (e) {
    if (!(e instanceof TypeError)) error.value = String((e as Error)?.message ?? e);
  } finally {
    loaded.value = true;
  }
}

async function reloadCatalog() {
  try {
    catalog.value = await loadModelCatalog();
  } catch {
    catalog.value = null;
  }
}

onMounted(() => {
  dialogTarget.value = (document.querySelector('.sf-root') as HTMLElement | null) ?? 'body';
  void reload();
  void reloadCatalog();
});

watch(
  () => store.modelDefaultTick,
  () => void reloadCatalog(),
);

const catalogModelKeys = computed(() => {
  const set = new Set<string>();
  for (const m of catalog.value?.models ?? []) {
    set.add(`${m.provider}/${m.id}`);
  }
  return set;
});

function recomputeUtcFromFields() {
  const s = parseHm(startField.value);
  const e = parseHm(endField.value);
  if (s !== null) startUtcMin.value = toUtcMinutes(s, editor.utcOffset);
  if (e !== null) endUtcMin.value = toUtcMinutes(e, editor.utcOffset);
}

function rederiveFieldsFromUtc() {
  startField.value = fmtHm(toLocalMinutes(startUtcMin.value, editor.utcOffset));
  endField.value = fmtHm(toLocalMinutes(endUtcMin.value, editor.utcOffset));
}

async function openAdd() {
  editor.open = true;
  editor.id = null;
  editor.modelKey = selectedModelKey.value;
  editor.note = '';
  editor.utcOffset = browserUtcOffset();
  startField.value = '09:00';
  endField.value = '17:00';
  recomputeUtcFromFields();
  formError.value = '';
  await nextTick();
  startInput.value?.focus();
}

async function openEdit(e: PeakHourEntry) {
  editor.open = true;
  editor.id = e.id;
  editor.modelKey = e.key;
  editor.note = e.note;
  editor.utcOffset = e.utcOffset;
  startUtcMin.value = parseHm(e.startUtc) ?? 540;
  endUtcMin.value = parseHm(e.endUtc) ?? 1020;
  rederiveFieldsFromUtc();
  formError.value = '';
  await nextTick();
  startInput.value?.focus();
}

function closeEditor() {
  editor.open = false;
  editor.id = null;
  formError.value = '';
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && editor.open) closeEditor();
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onDocKey);
  onUnmounted(() => window.removeEventListener('keydown', onDocKey));
}

const dialogTitle = computed(() => (editor.id ? `Edit peak hours — ${editor.modelKey}` : 'Add peak hours'));

const wraps = computed(() => startUtcMin.value !== endUtcMin.value && endUtcMin.value < startUtcMin.value);

const liveHint = computed(
  () =>
    `= ${fmtHm(startUtcMin.value)}–${fmtHm(endUtcMin.value)} UTC${wraps.value ? ' · wraps midnight' : ''}`,
);

const problems = computed<string[]>(() => {
  const list: string[] = [];
  if (!splitModelKey(editor.modelKey)) list.push('model');
  if (parseHm(startField.value) === null) list.push('start time');
  if (parseHm(endField.value) === null) list.push('end time');
  if (parseHm(startField.value) !== null && parseHm(endField.value) !== null) {
    if (startUtcMin.value === endUtcMin.value) list.push('a window (start ≠ end)');
  }
  return list;
});

const canSave = computed(() => problems.value.length === 0 && !busy.value);

async function save() {
  if (!canSave.value) return;
  const key = splitModelKey(editor.modelKey);
  if (!key) return;
  busy.value = true;
  formError.value = '';
  try {
    const input = {
      provider: key.provider,
      model: key.model,
      start: startField.value,
      end: endField.value,
      utcOffset: editor.utcOffset,
      note: editor.note.trim(),
    };
    if (editor.id) await updatePeakHours(editor.id, input);
    else await createPeakHours(input);
    await reload();
    closeEditor();
  } catch (e) {
    if (!(e instanceof TypeError)) formError.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

async function toggle(e: PeakHourEntry) {
  error.value = '';
  try {
    await updatePeakHours(e.id, { enabled: !e.enabled });
    await reload();
  } catch (err) {
    if (!(err instanceof TypeError)) error.value = String((err as Error)?.message ?? err);
  }
}

async function remove(e: PeakHourEntry) {
  if (!window.confirm(`Delete peak hours for ${e.key}?`)) return;
  error.value = '';
  try {
    await deletePeakHours(e.id);
    if (editor.id === e.id) closeEditor();
    await reload();
  } catch (err) {
    if (!(err instanceof TypeError)) error.value = String((err as Error)?.message ?? err);
  }
}

function onBackdropDown(e: MouseEvent) {
  if (e.target === e.currentTarget) closeEditor();
}

function windowText(e: PeakHourEntry): string {
  return `${e.start}–${e.end} ${offsetLabel(e.utcOffset)}`;
}

function utcText(e: PeakHourEntry): string {
  return `${e.startUtc}–${e.endUtc} UTC${e.wrapsMidnightUtc ? ' ↻' : ''}`;
}
</script>

<template>
  <div class="aph">
    <div v-if="error" class="aph-error">{{ error }}</div>

    <div class="aph-head">
      <span class="aph-hint">rush-hour price windows per model</span>
      <button
        class="aph-btn aph-btn--accent aph-add"
        :disabled="!selectedModelKey"
        :title="selectedModelKey ? 'Add peak hours' : 'Select a model in the catalog first'"
        @click="openAdd"
      >
        <SvgIcon name="＋" />add
      </button>
    </div>
    <div v-if="!entries.length && loaded && !error" class="aph-empty">
      No peak hours yet — add a window for a model that doubles its price on rush hours.
    </div>
    <div v-for="e in entries" :key="e.id" class="aph-row" :class="{ 'aph-row--off': !e.enabled }">
      <div class="aph-row-top">
        <button
          class="md-switch sf-panel-btn aph-switch"
          :class="{ 'md-switch--on': e.enabled }"
          role="switch"
          :aria-checked="e.enabled"
          :title="e.enabled ? 'Disable window' : 'Enable window'"
          @click="toggle(e)"
        ><span class="md-switch-knob" /></button>
        <span class="aph-api" :title="e.key">{{ e.key }}</span>
        <span
          v-if="!catalogModelKeys.has(e.key)"
          class="aph-unknown"
          title="This model is not in the current catalog — the window is kept"
        >not in catalog</span>
        <span class="aph-actions">
          <button class="aph-btn aph-iconbtn" title="Edit window" @click="openEdit(e)">
            <SvgIcon name="✎" />
          </button>
          <button class="aph-btn aph-iconbtn aph-iconbtn--danger" title="Delete window" @click="remove(e)">
            <SvgIcon name="✕" />
          </button>
        </span>
      </div>
      <div class="aph-window" :title="`peak ${e.start}–${e.end} ${offsetLabel(e.utcOffset)}`">
        {{ windowText(e) }}
      </div>
      <div class="aph-utc" :title="e.wrapsMidnightUtc ? 'window crosses midnight UTC' : ''">
        {{ utcText(e) }}
      </div>
      <div v-if="e.note" class="aph-note" :title="e.note">{{ e.note }}</div>
    </div>

    <Teleport :to="dialogTarget">
      <div v-if="editor.open" class="aph-dialog-backdrop" @mousedown="onBackdropDown">
        <div class="aph-dialog" role="dialog" aria-modal="true" :aria-label="dialogTitle">
          <header class="aph-dialog-head">
            <span class="aph-dialog-title">{{ dialogTitle }}</span>
            <button class="aph-btn aph-iconbtn aph-dialog-close" title="Close" @click="closeEditor">
              <SvgIcon name="✕" />
            </button>
          </header>
          <div class="aph-dialog-body">
            <div class="aph-field">
              <label class="aph-label">Model</label>
              <div class="aph-model-bound" :title="editor.modelKey">{{ editor.modelKey }}</div>
              <span class="aph-field-note">bound to the model selected in the catalog</span>
            </div>
            <div class="aph-times">
              <div class="aph-field">
                <label class="aph-label" for="aph-start">Peak start</label>
                <input
                  id="aph-start"
                  ref="startInput"
                  v-model="startField"
                  class="aph-input aph-time"
                  type="time"
                  @input="recomputeUtcFromFields"
                >
              </div>
              <div class="aph-field">
                <label class="aph-label" for="aph-end">Peak end</label>
                <input
                  id="aph-end"
                  v-model="endField"
                  class="aph-input aph-time"
                  type="time"
                  @input="recomputeUtcFromFields"
                >
              </div>
            </div>
            <div class="aph-field">
              <label class="aph-label" for="aph-tz">Timezone</label>
              <select
                id="aph-tz"
                v-model.number="editor.utcOffset"
                class="aph-input"
                @change="rederiveFieldsFromUtc"
              >
                <option v-for="o in OFFSET_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <div class="aph-live" :title="liveHint">{{ liveHint }}</div>
            <div class="aph-field">
              <label class="aph-label" for="aph-note">Note</label>
              <input id="aph-note" v-model="editor.note" class="aph-input" placeholder="rate-limit window" >
            </div>
            <div v-if="formError" class="aph-error">{{ formError }}</div>
            <div v-else-if="problems.length" class="aph-live aph-live--warn">
              needs {{ problems.join(', ') }}
            </div>
          </div>
          <footer class="aph-dialog-foot">
            <button class="aph-btn aph-cancel" :disabled="busy" @click="closeEditor">Cancel</button>
            <button class="aph-btn aph-btn--accent aph-save" :disabled="!canSave" @click="save">
              {{ busy ? 'Saving…' : 'Save' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.aph {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  min-height: 0;
}

.aph-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
}

.aph-hint {
  flex: 1;
  min-width: 0;
  color: var(--sf-text-muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aph-empty {
  padding: 8px 2px;
  color: var(--sf-text-muted);
  font-size: 14px;
  line-height: 1.4;
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

.aph-iconbtn {
  padding: 2px 5px;
  background: var(--sf-bar);
}

.aph-iconbtn--danger:hover {
  color: var(--sf-danger);
}

.aph-row {
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius);
  padding: 5px 7px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.aph-row--off {
  opacity: 0.55;
}

.aph-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.aph-switch {
  padding: 0;
}

.aph-api {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.aph-unknown {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--sf-text-muted);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  padding: 0 3px;
  white-space: nowrap;
}

.aph-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.aph-window {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.aph-utc {
  font-size: 12px;
  color: var(--sf-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.aph-note {
  font-size: 12px;
  color: var(--sf-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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

.aph-dialog-close {
  flex-shrink: 0;
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

.aph-time {
  font-variant-numeric: tabular-nums;
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
