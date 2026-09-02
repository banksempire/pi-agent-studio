<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, onMounted, reactive, ref } from 'vue';
import {
  deletePeakHours,
  offsetLabel,
  type PeakHourEntry,
  updatePeakHours,
  weekdaysLabel,
} from '../peakHours';
import { useChatStore } from '../store/chat';
import PeakHoursDialog from './PeakHoursDialog.vue';

const store = useChatStore();

const dialog = reactive<{ open: boolean; entry: PeakHourEntry | null }>({ open: false, entry: null });
const actionError = ref('');

const selectedModelKey = computed(() => {
  const d = store.modelDetail;
  return d ? `${d.model.provider}/${d.model.id}` : '';
});

const entries = computed(() => store.peakHours.filter((e) => e.key === selectedModelKey.value));

onMounted(() => void store.refreshPeakHours());

function openAdd() {
  if (!selectedModelKey.value) return;
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

function windowText(e: PeakHourEntry): string {
  const days = weekdaysLabel(e.weekdays);
  const base = `${e.start}–${e.end} ${offsetLabel(e.utcOffset)}`;
  return days && days !== 'daily' ? `${base} · ${days}` : base;
}

function utcText(e: PeakHourEntry): string {
  return `${e.startUtc}–${e.endUtc} UTC${e.wrapsMidnightUtc ? ' ↻' : ''}`;
}
</script>

<template>
  <div class="aph">
    <div v-if="store.peakHoursError" class="aph-error">{{ store.peakHoursError }}</div>
    <div v-else-if="actionError" class="aph-error">{{ actionError }}</div>

    <div class="aph-head">
      <span class="aph-hint" :title="selectedModelKey || undefined">{{
        selectedModelKey || 'select a model in the catalog'
      }}</span>
      <button
        class="aph-btn aph-btn--accent aph-add"
        :disabled="!selectedModelKey"
        :title="selectedModelKey ? 'Add peak hours' : 'Select a model in the catalog first'"
        @click="openAdd"
      >
        <SvgIcon name="＋" />add
      </button>
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
        <span class="aph-window" :title="`peak ${e.start}–${e.end} ${offsetLabel(e.utcOffset)}`">
          {{ windowText(e) }}
        </span>
        <span class="aph-actions">
          <button class="aph-btn aph-iconbtn" title="Edit window" @click="openEdit(e)">
            <SvgIcon name="✎" />
          </button>
          <button class="aph-btn aph-iconbtn aph-iconbtn--danger" title="Delete window" @click="remove(e)">
            <SvgIcon name="✕" />
          </button>
        </span>
      </div>
      <div class="aph-utc" :title="e.wrapsMidnightUtc ? 'window crosses midnight UTC' : ''">
        {{ utcText(e) }}
      </div>
      <div v-if="e.note" class="aph-note" :title="e.note">{{ e.note }}</div>
    </div>

    <PeakHoursDialog
      v-if="dialog.open"
      :entry="dialog.entry"
      :model-key="selectedModelKey"
      :model-choices="[]"
      @close="closeDialog"
      @saved="onSaved"
    />
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

.aph-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.aph-window {
  min-width: 0;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.aph-utc {
  padding-left: 30px;
  font-size: 12px;
  color: var(--sf-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.aph-note {
  padding-left: 30px;
  font-size: 12px;
  color: var(--sf-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
