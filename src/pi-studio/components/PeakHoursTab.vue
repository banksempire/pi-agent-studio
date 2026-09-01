<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { ModelCatalogView } from '../modelInfo';
import { loadModelCatalog } from '../modelInfo';
import { deletePeakHours, type PeakHourEntry, shortOffsetLabel, updatePeakHours } from '../peakHours';
import { useChatStore } from '../store/chat';
import PeakHoursDialog, { type PeakHourModelChoice } from './PeakHoursDialog.vue';

const store = useChatStore();

const catalog = ref<ModelCatalogView | null>(null);
const filter = ref('');
const actionError = ref('');
const selected = ref('');

const dialog = reactive<{ open: boolean; entry: PeakHourEntry | null }>({ open: false, entry: null });

const selectedModelKey = computed(() => {
  const d = store.modelDetail;
  return d ? `${d.model.provider}/${d.model.id}` : '';
});

async function reloadCatalog() {
  try {
    catalog.value = await loadModelCatalog();
  } catch {
    catalog.value = null;
  }
}

onMounted(() => {
  void store.refreshPeakHours();
  void reloadCatalog();
});

watch(
  () => store.modelDefaultTick,
  () => void reloadCatalog(),
);

const modelChoices = computed<PeakHourModelChoice[]>(() => {
  const choices: PeakHourModelChoice[] = [];
  for (const m of catalog.value?.models ?? []) {
    choices.push({
      key: `${m.provider}/${m.id}`,
      provider: m.provider,
      label: m.name || m.id,
    });
  }
  return choices;
});

const catalogModelKeys = computed(() => new Set(modelChoices.value.map((c) => c.key)));

const entries = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = [...store.peakHours];
  if (q) {
    return list.filter((e) => e.key.toLowerCase().includes(q) || (e.note ?? '').toLowerCase().includes(q));
  }
  return list.sort((a, b) => a.key.localeCompare(b.key) || a.startUtc.localeCompare(b.startUtc));
});

function openAdd() {
  dialog.entry = null;
  dialog.open = true;
}

function openEdit(e: PeakHourEntry) {
  dialog.entry = e;
  dialog.open = true;
}

function closeDialog() {
  dialog.open = false;
  dialog.entry = null;
}

async function onSaved() {
  closeDialog();
  await store.refreshPeakHours();
}

async function toggle(e: PeakHourEntry) {
  actionError.value = '';
  try {
    await updatePeakHours(e.id, { enabled: !e.enabled });
    await store.refreshPeakHours();
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  }
}

async function remove(e: PeakHourEntry) {
  if (!window.confirm(`Delete peak hours for ${e.key}?`)) return;
  actionError.value = '';
  try {
    await deletePeakHours(e.id);
    if (dialog.entry?.id === e.id) closeDialog();
    await store.refreshPeakHours();
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  }
}

function onRowClick(e: PeakHourEntry) {
  const m = (catalog.value?.models ?? []).find((x) => `${x.provider}/${x.id}` === e.key);
  if (!m) return;
  selected.value = e.key;
  const d = catalog.value?.default;
  store.requestModelDetail(m, !!d && e.key === `${d.provider}/${d.id}`);
}

function windowText(e: PeakHourEntry): string {
  return `${e.start} - ${e.end} (${shortOffsetLabel(e.utcOffset)})`;
}
</script>

<template>
  <div class="pht">
    <div class="pht-bar">
      <input
        v-model="filter"
        class="pht-filter"
        type="text"
        placeholder="Filter peak hours…"
      >
      <span class="pht-count">{{ entries.length }} windows</span>
      <button
        class="pht-add"
        :disabled="!modelChoices.length"
        :title="modelChoices.length ? 'Add peak hours' : 'The model catalog is not loaded yet'"
        @click="openAdd"
      >
        <SvgIcon name="＋" />add
      </button>
    </div>
    <div v-if="store.peakHoursError" class="pht-note pht-note--err">{{ store.peakHoursError }}</div>
    <div v-else-if="actionError" class="pht-note pht-note--err">{{ actionError }}</div>
    <div class="pht-body">
      <div class="pht-head-row">
        <span class="pht-col pht-col--switch" />
        <span class="pht-col pht-col--model">Model</span>
        <span class="pht-col pht-col--window">Window</span>
        <span class="pht-col pht-col--note">Note</span>
        <span class="pht-col pht-col--actions" />
      </div>
      <div
        v-for="e in entries"
        :key="e.id"
        class="pht-row"
        :class="{
          'pht-row--off': !e.enabled,
          'pht-row--clickable': catalogModelKeys.has(e.key),
          'pht-row--selected': e.key === selected,
        }"
        :title="e.key"
        @click="onRowClick(e)"
      >
        <div class="pht-cell pht-col--switch">
          <button
            class="md-switch sf-panel-btn pht-switch"
            :class="{ 'md-switch--on': e.enabled }"
            role="switch"
            :aria-checked="e.enabled"
            :title="e.enabled ? 'Disable window' : 'Enable window'"
            @click="toggle(e)"
          ><span class="md-switch-knob" /></button>
        </div>
        <div class="pht-cell pht-col--model">
          <span class="pht-key">{{ e.key }}</span>
          <span
            v-if="!catalogModelKeys.has(e.key)"
            class="pht-unknown"
            title="This model is not in the current catalog — the window is kept"
          >not in catalog</span>
        </div>
        <div
          class="pht-cell pht-col--window"
          :title="e.wrapsMidnightUtc ? `${windowText(e)} · crosses midnight UTC` : windowText(e)"
        >
          {{ windowText(e) }}
        </div>
        <div class="pht-cell pht-col--note" :title="e.note || undefined">{{ e.note }}</div>
        <div class="pht-cell pht-col--actions">
          <button class="pht-iconbtn" title="Edit window" @click="openEdit(e)">
            <SvgIcon name="✎" />
          </button>
          <button class="pht-iconbtn pht-iconbtn--danger" title="Delete window" @click="remove(e)">
            <SvgIcon name="✕" />
          </button>
        </div>
      </div>
      <div v-if="!entries.length && store.peakHoursLoaded" class="pht-empty">
        {{ filter.trim() ? 'No windows match the filter.' : 'No peak hours yet.' }}
      </div>
    </div>

    <PeakHoursDialog
      v-if="dialog.open"
      :entry="dialog.entry"
      :model-key="selectedModelKey"
      :model-choices="modelChoices"
      @close="closeDialog"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.pht {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--sf-bg);
}

.pht-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sf-border);
  flex-shrink: 0;
}

.pht-filter {
  flex: 1;
  min-width: 120px;
  max-width: 320px;
  background: var(--sf-bg);
  border: 1px solid var(--sf-border);
  border-radius: 4px;
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 16px;
  padding: 5px 8px;
  outline: none;
}

.pht-filter:focus {
  border-color: var(--sf-accent);
}

.pht-count {
  color: var(--sf-text-muted);
  font-size: 16px;
  margin-right: auto;
}

.pht-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--sf-accent);
  border: 1px solid var(--sf-accent);
  border-radius: 4px;
  color: var(--sf-text-on-accent);
  font-family: var(--sf-font);
  font-size: 16px;
  padding: 5px 14px;
  cursor: pointer;
}

.pht-add:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (hover: hover) {
  .pht-add:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-on-accent);
  }
}

.pht-note {
  padding: 6px 12px;
  font-size: 16px;
  color: var(--sf-text-muted);
  border-bottom: 1px solid var(--sf-border);
}

.pht-note--err {
  color: var(--sf-danger);
}

.pht-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.pht-head-row,
.pht-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 2fr) minmax(0, 0.75fr) minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 4px 12px;
}

.pht-head-row {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 30px;
  padding: 0 12px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--sf-text-bright);
  background: var(--sf-bg-lighter);
  border-bottom: 1px solid var(--sf-border);
  user-select: none;
}

.pht-col--window {
  font-variant-numeric: tabular-nums;
}

.pht-row {
  min-height: 32px;
  font-size: 16px;
  border-bottom: 1px solid var(--sf-border);
}

@media (hover: hover) {
  .pht-row:hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.pht-row--clickable {
  cursor: pointer;
}

.pht-row--selected {
  background: var(--sf-selection);
}

.pht-row--off {
  opacity: 0.55;
}

.pht-cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pht-col--window,
.pht-col--note {
  color: var(--sf-text-muted);
}

.pht-key {
  font-weight: 600;
}

.pht-unknown {
  margin-left: 6px;
  padding: 0 4px;
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.pht-switch {
  padding: 0;
}

.pht-col--actions {
  display: flex;
  gap: 4px;
}

.pht-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--sf-bar);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 14px;
  padding: 2px 5px;
  cursor: pointer;
}

@media (hover: hover) {
  .pht-iconbtn:hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.pht-iconbtn--danger {
  color: var(--sf-danger);
}

.pht-empty {
  padding: 24px;
  text-align: center;
  color: var(--sf-text-muted);
}

.sf-root--mobile .pht-bar {
  flex-wrap: wrap;
}

.sf-root--mobile .pht-filter {
  max-width: none;
}

.sf-root--mobile .pht-head-row {
  display: none;
}

.sf-root--mobile .pht-row {
  grid-template:
    'switch model actions' auto
    'switch window actions' auto / auto minmax(0, 1fr) auto;
  row-gap: 4px;
  padding: 8px 12px;
  align-content: center;
}

.sf-root--mobile .pht-col--switch {
  grid-area: switch;
}

.sf-root--mobile .pht-col--model {
  grid-area: model;
}

.sf-root--mobile .pht-col--window {
  grid-area: window;
  text-align: left;
}

.sf-root--mobile .pht-col--model,
.sf-root--mobile .pht-col--window {
  line-height: 20px;
}

.sf-root--mobile .pht-unknown {
  line-height: 1;
}

.sf-root--mobile .pht-col--note {
  display: none;
}

.sf-root--mobile .pht-col--actions {
  grid-area: actions;
}

.sf-root--mobile .pht-iconbtn {
  width: 44px;
  height: 44px;
  padding: 0;
  font-size: 16px;
}
</style>
