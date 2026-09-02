<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import Table from '@sf/components/Table.vue';
import type { TableColumn } from '@sf/types/table';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { ModelCatalogView } from '../modelInfo';
import { loadModelCatalog } from '../modelInfo';
import {
  deletePeakHours,
  type PeakHourEntry,
  updatePeakHours,
  weekdaysLabel,
  windowLabel,
} from '../peakHours';
import { useChatStore } from '../store/chat';
import PeakHoursDialog, { type PeakHourModelChoice } from './PeakHoursDialog.vue';

const store = useChatStore();

const catalog = ref<ModelCatalogView | null>(null);
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

const columns: TableColumn[] = [
  { key: 'enabled', label: 'On', width: 46, mobile: 'lead' },
  { key: 'key', label: 'Model', sortable: true, filter: true, mobile: 'title' },
  { key: 'window', label: 'Window', width: 200, sortable: true, mobile: 'sub' },
  { key: 'note', label: 'Note', filter: true },
];

const displayRows = computed(() =>
  [...store.peakHours]
    .sort((a, b) => a.key.localeCompare(b.key) || a.startUtc.localeCompare(b.startUtc))
    .map((e) => ({
      id: e.id,
      key: e.key,
      enabled: e.enabled,
      window: windowText(e),
      note: e.note ?? '',
      wraps: e.wrapsMidnightUtc,
      entry: e,
    })),
);

function windowText(e: PeakHourEntry): string {
  const days = weekdaysLabel(e.weekdays);
  const base = windowLabel(e.start, e.end, e.utcOffset);
  return days && days !== 'daily' ? `${base} · ${days}` : base;
}

function rowClass(row: Record<string, unknown>): Record<string, boolean> {
  return {
    'pht-row--clickable': catalogModelKeys.value.has(String(row.key)),
    'pht-row--selected': row.key === selected.value,
    'pht-row--off': row.enabled !== true,
  };
}

function onRowClick(row: Record<string, unknown>) {
  const key = String(row.key);
  const m = (catalog.value?.models ?? []).find((x) => `${x.provider}/${x.id}` === key);
  if (!m) return;
  selected.value = key;
  const d = catalog.value?.default;
  store.requestModelDetail(m, !!d && key === `${d.provider}/${d.id}`);
}

function openAdd() {
  dialog.entry = null;
  dialog.open = true;
}

function openEdit(row: Record<string, unknown>) {
  dialog.entry = row.entry as PeakHourEntry;
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

async function toggle(row: Record<string, unknown>) {
  const e = row.entry as PeakHourEntry;
  actionError.value = '';
  try {
    await updatePeakHours(e.id, { enabled: !e.enabled });
    await store.refreshPeakHours();
  } catch (err) {
    if (!(err instanceof TypeError)) actionError.value = String((err as Error)?.message ?? err);
  }
}

async function remove(row: Record<string, unknown>) {
  const e = row.entry as PeakHourEntry;
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
</script>

<template>
  <div class="pht">
    <div class="pht-bar">
      <span class="pht-count">{{ store.peakHours.length }} windows</span>
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
      <Table
        :columns="columns"
        :rows="displayRows"
        row-key="id"
        :row-title="(row) => String(row.key)"
        :row-class="rowClass"
        @row-click="onRowClick"
      >
        <template #cell-enabled="{ row }">
          <button
            class="md-switch pht-switch"
            :class="{ 'md-switch--on': row.enabled }"
            role="switch"
            :aria-checked="row.enabled === true"
            :title="row.enabled ? 'Disable window' : 'Enable window'"
            @click.stop="toggle(row)"
          ><span class="md-switch-knob" /></button>
        </template>
        <template #cell-key="{ row }">
          <span class="pht-key">{{ row.key }}</span>
          <span
            v-if="!catalogModelKeys.has(String(row.key))"
            class="pht-unknown"
            title="This model is not in the current catalog — the window is kept"
          >not in catalog</span>
        </template>
        <template #cell-window="{ row }">
          <span
            class="pht-muted pht-window-text"
            :title="row.wraps ? `${row.window} · crosses midnight UTC` : String(row.window)"
          >{{ row.window }}</span>
        </template>
        <template #cell-note="{ row }">
          <span class="pht-muted" :title="row.note ? String(row.note) : undefined">{{ row.note }}</span>
        </template>
        <template #actions="{ row }">
          <button class="sf-tbl-btn" type="button" title="Edit window" @click.stop="openEdit(row)">
            <SvgIcon name="✎" />
          </button>
          <button
            class="sf-tbl-btn sf-tbl-btn--danger"
            type="button"
            title="Delete window"
            @click.stop="remove(row)"
          >
            <SvgIcon name="✕" />
          </button>
        </template>
        <template #empty="{ filtered }">
          {{ filtered ? 'No windows match the filter.' : 'No peak hours yet.' }}
        </template>
      </Table>
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

.pht :deep(.sf-tbl-row.pht-row--clickable) {
  cursor: pointer;
}

.pht :deep(.sf-tbl-row.pht-row--selected) {
  background: var(--sf-selection);
}

.pht :deep(.sf-tbl-row.pht-row--off) {
  opacity: 0.55;
}

.pht :deep(.sf-tbl-head) {
  font-size: 16px;
}

.pht-key {
  font-weight: 600;
}

.pht-muted {
  color: var(--sf-text-muted);
}

.pht-window-text {
  font-variant-numeric: tabular-nums;
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

.sf-root--mobile .pht :deep(.sf-tbl-row) {
  padding: 8px 12px;
}

.sf-root--mobile .pht :deep(.sf-tbl-c--title),
.sf-root--mobile .pht :deep(.sf-tbl-c--sub) {
  line-height: 20px;
}

.sf-root--mobile .pht :deep(.pht-unknown) {
  line-height: 1;
}
</style>
