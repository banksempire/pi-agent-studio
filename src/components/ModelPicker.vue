<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Menu from '@sf/components/Menu.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import { useChatStore } from '../store/chat';

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
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const open = ref(false);

const active = computed(() =>
  store.activeChatId ? store.findSession(store.activeChatId) ?? null : null,
);

async function load() {
  const s = active.value;
  if (!s?.file) {
    catalog.value = null;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: s.file, command: 'model' }),
    });
    const j = await res.json();
    if (!j.ok) {
      error.value = j.error || 'Failed to load models';
      catalog.value = null;
    } else {
      catalog.value = j.data as ModelCatalog;
    }
  } catch (e) {
    error.value = String((e as Error)?.message ?? e);
    catalog.value = null;
  } finally {
    loading.value = false;
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
watch(() => active.value?.stats.model ?? null, () => void load());
onMounted(() => void load());

// ── Menu items: Provider → Model → Think level ────────────────────────────

const providers = computed(() => {
  if (!catalog.value) return [];
  const seen = new Set<string>();
  for (const m of catalog.value.models) seen.add(m.provider);
  return [...seen].sort();
});

const modelsOf = (p: string) =>
  catalog.value?.models.filter((m) => m.provider === p) ?? [];

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

const currentSummary = computed(() => {
  const cur = catalog.value?.current;
  if (!cur) return '—';
  const lvl = catalog.value?.currentThinkingLevel;
  const levelLabel = lvl && lvl !== 'off' ? lvl : '(None)';
  return `${cur.provider}/${cur.name || cur.id} · ${levelLabel}`;
});

function onSelect(item: MenuNodeDef) {
  const d = item.data as { model: ModelInfo; level: string } | undefined;
  if (d) void commit(d.model, d.level);
}

async function commit(m: ModelInfo, thinkLevel: string) {
  const s = active.value;
  if (!s?.file || busy.value) return;
  busy.value = true;
  notice.value = '';
  error.value = '';
  try {
    const res = await fetch('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: s.file,
        command: 'model',
        args: m.id,
        extra: { thinkLevel },
      }),
    });
    const j = await res.json();
    if (!j.ok) {
      error.value = j.error || 'Failed to apply model';
    } else {
      const label =
        thinkLevel === 'off' && !m.reasoning
          ? `${m.provider}/${m.name || m.id} · no thinking`
          : `${m.provider}/${m.name || m.id} · ${thinkLevel}`;
      notice.value = label;
      void load();
    }
  } catch (e) {
    error.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="model-menu">
    <Menu :items="menuItems" :open="open" @update:open="(v) => (open = v)" @select="onSelect">
      <template #trigger="{ toggle, open: isOpen }">
        <button class="model-menu-trigger" :disabled="busy" @click="toggle">
          <span class="model-menu-trigger-label">Model</span>
          <span class="model-menu-trigger-cur" :title="currentSummary">{{ currentSummary }}</span>
          <span class="model-menu-trigger-caret">{{ isOpen ? '▲' : '▾' }}</span>
        </button>
      </template>
    </Menu>

    <div v-if="busy" class="model-menu-note">Applying…</div>
    <div v-if="notice" class="model-menu-note model-menu-note--ok">{{ notice }}</div>
    <div v-else-if="error" class="model-menu-note model-menu-note--err">{{ error }}</div>
    <div v-else-if="loading" class="model-menu-note">Loading models…</div>
    <div v-else-if="!active && !catalog" class="model-menu-note">Open a chat window to change its model.</div>
  </div>
</template>
