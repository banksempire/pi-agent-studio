<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import Menu from '@sf/components/Menu.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import type { KeyValueItem } from '@sf/types/panel';
import { computed, onMounted, ref, watch } from 'vue';
import type { ModelCatalogView, ModelInfo } from '../modelInfo';
import {
  cachedModelMatches,
  loadSessionModels,
  modelMenuItems,
  setCachedModel,
  setSessionModel,
} from '../modelInfo';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const catalog = ref<ModelCatalogView | null>(null);
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
    catalog.value = await loadSessionModels(s.file, force);
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

const menuItems = computed<MenuNodeDef[]>(() => modelMenuItems(catalog.value?.models ?? []));

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
    await setSessionModel(s.file, `${m.provider}/${m.id}`, thinkLevel);
    setCachedModel(s.file, m, thinkLevel);
    void load(true);
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
