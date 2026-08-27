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

async function makeDefault() {
  const d = detail.value;
  if (!d || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await setDefaultModel(`${d.model.provider}/${d.model.id}`);
    store.applyModelDefault(res.default ?? d.model);
  } catch (e) {
    if (!(e instanceof TypeError)) error.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

function fmtContext(window: number): string {
  if (!window) return '—';
  return window >= 1000 ? `${(window / 1000).toLocaleString()}k` : String(window);
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
    <button
      v-if="detail && !detail.isDefault"
      class="model-detail-btn sf-panel-btn"
      :disabled="busy"
      title="Set as the default model for new chats"
      @click="makeDefault"
    >
      {{ busy ? 'Setting…' : 'Set Default' }}
    </button>
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

.model-detail-btn {
  margin: 6px 8px;
  border: 1px solid var(--sf-border);
  border-radius: 4px;
  color: var(--sf-text);
  font-size: 16px;
  padding: 5px 14px;
  cursor: pointer;
}

.model-detail-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (hover: hover) {
  .model-detail-btn:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-bright);
  }
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
