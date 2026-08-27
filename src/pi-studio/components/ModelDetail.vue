<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import type { KeyValueItem } from '@sf/types/panel';
import { computed, ref } from 'vue';
import type { ModelInfo } from '../modelInfo';
import { setDefaultModel } from '../modelInfo';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const detail = computed(() => store.modelDetail);
const busy = ref(false);
const error = ref('');

const levels = computed<string[]>(() => detail.value?.model.thinkingLevels ?? []);

const activeLevel = computed<string | null>(() => {
  const lv = store.modelDefaultLevel;
  if (lv && levels.value.includes(lv)) return lv;
  return levels.value[0] ?? null;
});

async function toggleDefault() {
  const d = detail.value;
  if (!d || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const key = `${d.model.provider}/${d.model.id}`;
    const level = store.modelDefaultLevel ?? undefined;
    const res = d.isDefault ? await setDefaultModel(null) : await setDefaultModel(key, level);
    store.applyModelDefault(res);
  } catch (e) {
    if (!(e instanceof TypeError)) error.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

async function pickLevel(lvl: string) {
  const d = detail.value;
  if (!d || busy.value || lvl === activeLevel.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await setDefaultModel(`${d.model.provider}/${d.model.id}`, lvl);
    store.applyModelDefault(res);
  } catch (e) {
    if (!(e instanceof TypeError)) error.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

function fmtContext(window: number): string {
  if (!window) return '—';
  return window >= 1000 ? `${Math.round(window / 1000).toLocaleString()}k` : String(window);
}

function fmtTokens(n?: number): string {
  if (!n) return '—';
  return n.toLocaleString();
}

function fmtRate(v?: number): string {
  if (v === undefined || v === null) return '—';
  return `$${v.toFixed(2)}`;
}

const rows = computed<KeyValueItem[]>(() => {
  const d = detail.value;
  const m: ModelInfo | null = d?.model ?? null;
  if (!m) return [];
  const cost = m.cost;
  const input = m.input?.length ? m.input.join(' + ') : 'text';
  return [
    { key: 'Provider', value: m.provider },
    { key: 'Model', value: m.name || m.id },
    { key: 'ID', value: m.id },
    { key: 'API', value: m.api || '—' },
    { key: 'Endpoint', value: m.baseUrl || '—' },
    { key: 'Input', value: input },
    { key: 'Reasoning', value: m.reasoning ? 'yes' : 'no' },
    { key: 'Context', value: fmtContext(m.contextWindow) },
    { key: 'Max Output', value: fmtTokens(m.maxTokens) },
    { key: 'Cost In/Out', value: cost ? `${fmtRate(cost.input)} / ${fmtRate(cost.output)} per M` : '—' },
    {
      key: 'Cache R/W',
      value: cost ? `${fmtRate(cost.cacheRead)} / ${fmtRate(cost.cacheWrite)} per M` : '—',
    },
    {
      key: 'Thinking',
      value: m.reasoning ? m.thinkingLevels.filter((l) => l !== 'off').join(', ') || 'off' : '—',
    },
    { key: 'Default', value: d?.isDefault ? 'yes' : 'no', pill: true, tone: d?.isDefault ? 'ok' : 'muted' },
  ];
});
</script>

<template>
  <div class="model-detail">
    <KeyValueList v-if="rows.length" :items="rows" />
    <div v-else class="model-detail-hint">Click a model in the Model Catalog to inspect it.</div>
    <template v-if="detail">
      <div class="prefs-row">
        <span class="prefs-key">Default model</span>
        <span class="prefs-right">
          <span class="prefs-hint">{{ detail.isDefault ? 'yes' : 'no' }}</span>
          <button
            class="md-switch sf-panel-btn"
            :class="{ 'md-switch--on': detail.isDefault }"
            role="switch"
            :aria-checked="detail.isDefault"
            :disabled="busy"
            :title="detail.isDefault ? 'This model is the default — click to unset' : 'Set this model as the default for new chats'"
            @click="toggleDefault"
          ><span class="md-switch-knob" /></button>
        </span>
      </div>
      <div v-if="detail.isDefault" class="model-detail-levels">
        <span class="model-detail-levels-label">Thinking</span>
        <div class="model-detail-pills">
          <button
            v-for="lvl in levels"
            :key="lvl"
            class="model-detail-pill sf-panel-btn"
            :class="{ 'model-detail-pill--on': lvl === activeLevel }"
            :disabled="busy"
            :title="`Default thinking level: ${lvl}`"
            @click="pickLevel(lvl)"
          >
            {{ lvl }}
          </button>
        </div>
        <div v-if="store.modelDefaultSource === 'latest-chat'" class="model-detail-src">via latest new chat</div>
      </div>
    </template>
    <div v-if="error" class="model-detail-note model-detail-note--err">{{ error }}</div>
  </div>
</template>

<style scoped>
.model-detail {
  padding: 4px 0;
}

.model-detail-hint {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.model-detail .prefs-row {
  margin: 6px 8px 0;
}

.model-detail-levels {
  margin: 2px 8px 6px;
}

.model-detail-levels-label {
  display: block;
  color: var(--sf-text-muted);
  font-size: 16px;
  padding: 4px 0;
}

.model-detail-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.model-detail-pill {
  border: 1px solid var(--sf-border);
  border-radius: 10px;
  color: var(--sf-text-muted);
  font-size: 14px;
  padding: 1px 10px;
  cursor: pointer;
}

.model-detail-pill:disabled {
  opacity: 0.6;
  cursor: default;
}

.model-detail-pill--on {
  background: var(--sf-accent);
  border-color: var(--sf-accent);
  color: var(--sf-text-on-accent);
}

@media (hover: hover) {
  .model-detail-pill:not(:disabled):not(.model-detail-pill--on):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-bright);
  }
}

.model-detail-src {
  color: var(--sf-text-muted);
  font-size: 14px;
  padding: 4px 0 0;
}

.model-detail-note {
  padding: 4px 8px;
  font-size: 16px;
  color: var(--sf-text-muted);
}

.model-detail-note--err {
  color: var(--sf-danger);
}
</style>
