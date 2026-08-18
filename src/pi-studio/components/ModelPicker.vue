<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import Menu from '@sf/components/Menu.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import type { KeyValueItem } from '@sf/types/panel';
import { computed, onMounted, ref, watch } from 'vue';
import type { ModelCatalog, ModelInfo } from '../modelInfo';
import { cachedModelMatches, getModelInfo, setCachedModel } from '../modelInfo';
import { api, useChatStore } from '../store/chat';

const LEVEL_DESCRIPTIONS: Record<string, string> = {
  off: 'No reasoning',
  minimal: 'Very brief reasoning (~1k tokens)',
  low: 'Light reasoning (~2k tokens)',
  medium: 'Moderate reasoning (~8k tokens)',
  high: 'Deep reasoning (~16k tokens)',
  xhigh: 'Extra-high reasoning (~32k tokens)',
  max: 'Maximum reasoning',
};

const store = useChatStore();

const catalog = ref<ModelCatalog | null>(null);
const busy = ref(false);
const error = ref('');
const open = ref(false);

const active = computed(() => (store.activeChatId ? (store.findSession(store.activeChatId) ?? null) : null));

async function load(force = false) {
  const s = active.value;
  if (!s?.file) {
    catalog.value = null;
    return;
  }
  error.value = '';
  try {
    catalog.value = await getModelInfo(s.file, force);
  } catch (e) {
    if (!(e instanceof TypeError)) {
      error.value = String((e as Error)?.message ?? e);
    }
    catalog.value = null;
  }
}

const activeFile = computed(() => active.value?.file ?? null);
watch(activeFile, () => {
  open.value = false;
  void load();
});
watch(
  () => active.value?.stats.model ?? null,
  (m) => {
    const f = active.value?.file;
    if (f && cachedModelMatches(f, m)) return;
    void load(true);
  },
);
onMounted(() => void load());

const providers = computed(() => {
  if (!catalog.value) return [];
  const seen = new Set<string>();
  for (const m of catalog.value.models) seen.add(m.provider);
  return [...seen].sort();
});

const modelsOf = (p: string) => catalog.value?.models.filter((m) => m.provider === p) ?? [];

const menuItems = computed<MenuNodeDef[]>(() =>
  providers.value.map((p) => ({
    id: p,
    label: p,
    items: modelsOf(p).map((m) => ({
      id: m.id,
      label: m.name || m.id,
      detail: m.reasoning ? 'thinking' : 'plain',
      items: m.thinkingLevels.map((l) => ({
        id: l,
        label: l === 'off' ? '(None)' : l,
        detail: LEVEL_DESCRIPTIONS[l] ?? '',
        data: { model: m, level: l },
      })),
    })),
  })),
);

function onSelect(item: MenuNodeDef) {
  const d = item.data as { model: ModelInfo; level: string } | undefined;
  if (d) void commit(d.model, d.level);
}

const current = computed(() => catalog.value?.current ?? null);
const thinkingLabel = computed(() => {
  const lvl = catalog.value?.currentThinkingLevel;
  return lvl && lvl !== 'off' ? lvl : '(None)';
});

const modelRows = computed<KeyValueItem[]>(() => [
  { key: 'Provider', value: current.value?.provider ?? '—' },
  { key: 'Model', value: current.value?.name || current.value?.id || '—' },
  { key: 'Thinking', value: thinkingLabel.value },
]);

async function commit(m: ModelInfo, thinkLevel: string) {
  const s = active.value;
  if (!s?.file || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const j = await api<{ ok: boolean; error?: string }>('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: s.file,
        command: 'model',
        args: `${m.provider}/${m.id}`,
        extra: { thinkLevel },
      }),
    });
    if (!j.ok) {
      error.value = j.error || 'Failed to apply model';
    } else {
      setCachedModel(s.file, m, thinkLevel);
      void load(true);
    }
  } catch (e) {
    if (!(e instanceof TypeError)) {
      error.value = String((e as Error)?.message ?? e);
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="model-menu">
    <KeyValueList :items="modelRows" />

    <Menu :items="menuItems" :open="open" title="Change Model" @update:open="(v) => (open = v)" @select="onSelect">
      <template #trigger="{ toggle }">
        <button class="model-menu-btn sf-panel-btn" :disabled="busy" @click="toggle">
          Change Model
        </button>
      </template>
    </Menu>

    <div v-if="busy" class="model-menu-note">Applying…</div>
    <div v-if="error" class="model-menu-note model-menu-note--err">{{ error }}</div>
    <div v-else-if="!active" class="model-menu-note">Open a chat window to change its model.</div>
  </div>
</template>
