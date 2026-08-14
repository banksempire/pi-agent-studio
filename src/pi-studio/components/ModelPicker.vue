<script setup lang="ts">
import KeyValueList from '@sf/components/KeyValueList.vue';
import Menu from '@sf/components/Menu.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import type { KeyValueItem } from '@sf/types/panel';
import { computed, onMounted, ref, watch } from 'vue';
import { api, useChatStore } from '../store/chat';

interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  thinkingLevels: string[];
}

interface ModelCatalog {
  models: ModelInfo[];
  current: ModelInfo | null;
  currentThinkingLevel: string | null;
}

/** Same descriptions as the pi TUI's thinking selector. */
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

async function load() {
  const s = active.value;
  if (!s?.file) {
    catalog.value = null;
    return;
  }
  error.value = '';
  try {
    const j = await api<{ ok: boolean; data?: ModelCatalog; error?: string }>('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file, command: 'model' }),
    });
    if (!j.ok) {
      error.value = j.error || 'Failed to load models';
      catalog.value = null;
    } else {
      catalog.value = j.data as ModelCatalog;
    }
  } catch (e) {
    // Connectivity failures are silent — the status-bar dot is the only
    // indicator; real backend rejections (j.ok === false) still show.
    if (!(e instanceof TypeError)) {
      error.value = String((e as Error)?.message ?? e);
    }
    catalog.value = null;
  }
}

// A new chat window (or none) resets and reloads. Watch the FILE PATH, not
// the session object: a refresh re-syncs the session list (new object
// identities) and would otherwise churn on every model change.
const activeFile = computed(() => active.value?.file ?? null);
watch(activeFile, () => {
  open.value = false;
  void load();
});
// The model can also change from outside the menu (e.g. /model in chat).
watch(
  () => active.value?.stats.model ?? null,
  () => void load(),
);
onMounted(() => void load());

// ── Menu items: Provider → Model → Think level ────────────────────────────

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

/** Current model's display values for the Provider / Model / Thinking lines. */
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
        // Fully-qualified provider/model id — several providers ship the
        // same model id (opencode, opencode-go, volcengine-plan …) and a
        // bare id would match whichever catalog entry comes first.
        args: `${m.provider}/${m.id}`,
        extra: { thinkLevel },
      }),
    });
    if (!j.ok) {
      error.value = j.error || 'Failed to apply model';
    } else {
      void load();
    }
  } catch (e) {
    // Connectivity failures are silent (the dot in the status bar says it
    // all); real backend rejections (j.ok === false) still show.
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
    <!-- Current selection: Provider / Model / Thinking (same key-value
         layout as the stats rows above — the unified KeyValueList). -->
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
