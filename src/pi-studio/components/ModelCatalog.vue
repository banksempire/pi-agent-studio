<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import { loadModelCatalog, refreshModelCatalog } from '../modelInfo';

const catalog = ref<ModelCatalogView | null>(null);
const busy = ref(false);
const error = ref('');
const refreshErrors = ref<string[]>([]);
const filter = ref('');

async function load(force = false) {
  error.value = '';
  try {
    const data: ModelCatalogView & { errors?: string[] } = force
      ? await refreshModelCatalog()
      : await loadModelCatalog();
    catalog.value = data;
    refreshErrors.value = data.errors ?? [];
  } catch (e) {
    if (!(e instanceof TypeError)) error.value = String((e as Error)?.message ?? e);
  }
}

onMounted(() => void load());

async function refresh() {
  if (busy.value) return;
  busy.value = true;
  try {
    await load(true);
  } finally {
    busy.value = false;
  }
}

function fmtContext(window: number): string {
  if (!window) return '—';
  return window >= 1000 ? `${(window / 1000).toLocaleString()}k` : String(window);
}

function fmtCost(m: ModelInfo): string {
  const c = m.cost;
  if (!c) return '—';
  return `$${c.input.toFixed(2)} / $${c.output.toFixed(2)} per M`;
}

function fmtLevels(m: ModelInfo): string {
  if (!m.reasoning) return 'plain';
  return m.thinkingLevels.filter((l) => l !== 'off').join(', ') || 'off';
}

const providers = computed(() => {
  if (!catalog.value) return [];
  const q = filter.value.trim().toLowerCase();
  const groups: Array<{ provider: string; models: ModelInfo[] }> = [];
  for (const m of catalog.value.models) {
    if (
      q &&
      !`${m.provider}/${m.id}`.toLowerCase().includes(q) &&
      !(m.name ?? '').toLowerCase().includes(q)
    ) {
      continue;
    }
    let g = groups.find((x) => x.provider === m.provider);
    if (!g) {
      g = { provider: m.provider, models: [] };
      groups.push(g);
    }
    g.models.push(m);
  }
  return groups;
});

const defaultKey = computed(() => {
  const d = catalog.value?.default;
  return d ? `${d.provider}/${d.id}` : '';
});

const totalCount = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return catalog.value?.models.length ?? 0;
  return providers.value.reduce((n, g) => n + g.models.length, 0);
});
</script>

<template>
  <div class="model-catalog">
    <div class="model-catalog-bar">
      <input
        v-model="filter"
        class="model-catalog-filter"
        type="text"
        placeholder="Filter models…"
      >
      <span class="model-catalog-count">{{ totalCount }} models</span>
      <button class="model-catalog-refresh sf-panel-btn" :disabled="busy" @click="refresh">
        {{ busy ? 'Refreshing…' : 'Refresh Catalog' }}
      </button>
    </div>
    <div v-if="error" class="model-catalog-note model-catalog-note--err">{{ error }}</div>
    <div v-else-if="refreshErrors.length" class="model-catalog-note">
      Refreshed with errors: {{ refreshErrors.join(', ') }}
    </div>
    <div class="model-catalog-body">
      <div v-for="g in providers" :key="g.provider" class="model-catalog-group">
        <div class="model-catalog-group-head">{{ g.provider }}</div>
        <div
          v-for="m in g.models"
          :key="`${m.provider}/${m.id}`"
          class="model-catalog-row"
          :title="`${m.provider}/${m.id}`"
        >
          <span class="model-catalog-name">
            {{ m.name || m.id }}
            <span v-if="`${m.provider}/${m.id}` === defaultKey" class="model-catalog-badge">default</span>
          </span>
          <span class="model-catalog-id">{{ m.id }}</span>
          <span class="model-catalog-ctx">{{ fmtContext(m.contextWindow) }}</span>
          <span class="model-catalog-cost">{{ fmtCost(m) }}</span>
          <span class="model-catalog-levels" :title="m.thinkingLevels.join(', ')">{{ fmtLevels(m) }}</span>
        </div>
      </div>
      <div v-if="!providers.length && !error" class="model-catalog-empty">
        {{ catalog ? 'No models match the filter.' : 'Loading models…' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-catalog {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--sf-bg);
}

.model-catalog-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sf-border);
  flex-shrink: 0;
}

.model-catalog-filter {
  flex: 1;
  min-width: 120px;
  max-width: 320px;
}

.model-catalog-count {
  color: var(--sf-text-muted);
  font-size: 16px;
  margin-right: auto;
}

.model-catalog-note {
  padding: 6px 12px;
  font-size: 16px;
  color: var(--sf-text-muted);
  border-bottom: 1px solid var(--sf-border);
}

.model-catalog-note--err {
  color: var(--sf-danger);
}

.model-catalog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}

.model-catalog-group-head {
  position: sticky;
  top: 0;
  padding: 4px 12px;
  font-size: 16px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--sf-text-bright);
  background: var(--sf-bg-lighter);
  border-bottom: 1px solid var(--sf-border);
}

.model-catalog-row {
  display: grid;
  grid-template-columns: minmax(120px, 1.4fr) minmax(100px, 1fr) 70px minmax(140px, 1fr) minmax(100px, 1fr);
  gap: 8px;
  align-items: baseline;
  padding: 4px 12px;
  font-size: 16px;
}

.model-catalog-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-catalog-badge {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--sf-accent);
  color: var(--sf-text-on-accent);
  font-size: 14px;
}

.model-catalog-id {
  font-family: var(--sf-mono);
  color: var(--sf-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-catalog-ctx,
.model-catalog-cost,
.model-catalog-levels {
  color: var(--sf-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-catalog-empty {
  padding: 24px;
  text-align: center;
  color: var(--sf-text-muted);
}
</style>
