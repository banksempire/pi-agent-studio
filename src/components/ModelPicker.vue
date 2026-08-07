<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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

// Cascade state: 0 = providers, 1 = models, 2 = think levels.
const level = ref(0);
const provider = ref<string | null>(null);
const model = ref<ModelInfo | null>(null);

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

// A new chat window (or none) resets the cascade and reloads the catalog.
// Watch the FILE PATH, not the session object: a refresh re-syncs the session
// list (new object identities) and would otherwise clear the notice / reset
// the cascade on every model change.
const activeFile = computed(() => active.value?.file ?? null);
watch(activeFile, () => {
  level.value = 0;
  provider.value = null;
  model.value = null;
  notice.value = '';
  void load();
});
// The model can also change from outside the menu (e.g. /model in the chat
// composer) — reload the catalog then, keeping the summary in sync.
watch(() => active.value?.stats.model ?? null, () => void load());
onMounted(() => void load());

const providers = computed(() => {
  if (!catalog.value) return [];
  const seen = new Set<string>();
  for (const m of catalog.value.models) seen.add(m.provider);
  return [...seen].sort();
});

const modelsOf = computed(
  () => catalog.value?.models.filter((m) => m.provider === provider.value) ?? [],
);

const levelsOf = computed(() => model.value?.thinkingLevels ?? []);

/** A model that offers only 'off' shows a single "(None)" row. */
const noneOnly = computed(() => levelsOf.value.length === 1 && levelsOf.value[0] === 'off');

const isCurrentModel = (m: ModelInfo | null) => {
  if (!m || !catalog.value?.current) return false;
  return catalog.value.current.provider === m.provider && catalog.value.current.id === m.id;
};

/** The active thinking level — only meaningful on the session's current model. */
const currentLevelFor = (m: ModelInfo | null) =>
  isCurrentModel(m) ? catalog.value?.currentThinkingLevel ?? null : null;

const current = computed(() => catalog.value?.current ?? null);
const currentLevel = computed(() => catalog.value?.currentThinkingLevel ?? null);

function pickProvider(p: string) {
  provider.value = p;
  model.value = null;
  level.value = 1;
}

function pickModel(m: ModelInfo) {
  model.value = m;
  level.value = 2;
}

function back() {
  if (level.value === 2) {
    model.value = null;
    level.value = 1;
  } else if (level.value === 1) {
    provider.value = null;
    level.value = 0;
  }
}

async function commit(thinkLevel: string) {
  const s = active.value;
  if (!s?.file || !model.value || busy.value) return;
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
        args: model.value.id,
        extra: { thinkLevel },
      }),
    });
    const j = await res.json();
    if (!j.ok) {
      error.value = j.error || 'Failed to apply model';
    } else {
      const label =
        thinkLevel === 'off' && !model.value.reasoning
          ? `${model.value.provider}/${model.value.id} · no thinking`
          : `${model.value.provider}/${model.value.id} · ${thinkLevel}`;
      notice.value = label;
      level.value = 0;
      provider.value = null;
      model.value = null;
      void load();
    }
  } catch (e) {
    error.value = String((e as Error)?.message ?? e);
  } finally {
    busy.value = false;
  }
}

function thinkLabel(l: string) {
  return l === 'off' ? '(None)' : l;
}
</script>

<template>
  <div class="model-menu">
    <!-- Current selection summary -->
    <div class="model-menu-current" :title="current ? `${current.provider}/${current.id}` : ''">
      <template v-if="catalog">
        <span class="model-menu-cur-prov">{{ current?.provider ?? '—' }}</span>
        <span class="model-menu-cur-model">{{ current?.name ?? current?.id ?? 'no model' }}</span>
        <span class="model-menu-cur-level">
          {{ currentLevel && currentLevel !== 'off' ? currentLevel : '(None)' }}
        </span>
      </template>
      <span v-else-if="!active" class="model-menu-hint">Open a chat window to change its model.</span>
      <span v-else class="model-menu-hint">Loading models…</span>
    </div>

    <div v-if="loading" class="model-menu-row model-menu-muted">Loading models…</div>
    <div v-else-if="error" class="model-menu-row model-menu-error">{{ error }}</div>
    <div v-else-if="!catalog" class="model-menu-row model-menu-muted">No models available.</div>
    <template v-else>
      <!-- Breadcrumb -->
      <div class="model-menu-crumbs">
        <button class="model-menu-crumb" :class="{ 'model-menu-crumb--on': level === 0 }" @click="level = 0; provider = null; model = null">
          Providers
        </button>
        <span class="model-menu-crumb-sep">▸</span>
        <button class="model-menu-crumb" :class="{ 'model-menu-crumb--on': level === 1 }" :disabled="!provider" @click="back()">
          {{ provider ?? 'Model' }}
        </button>
        <span class="model-menu-crumb-sep">▸</span>
        <button class="model-menu-crumb" :class="{ 'model-menu-crumb--on': level === 2 }" :disabled="!model" @click="back()">
          {{ model ? (noneOnly ? '(None)' : 'Think level') : 'Think level' }}
        </button>
      </div>

      <!-- Level 1: providers -->
      <template v-if="level === 0">
        <div
          v-for="p in providers"
          :key="p"
          class="model-menu-row"
          :class="{ 'model-menu-row--current': current?.provider === p }"
          @click="pickProvider(p)"
        >
          <span class="model-menu-dot">{{ current?.provider === p ? '●' : '○' }}</span>
          <span class="model-menu-name">{{ p }}</span>
          <span class="model-menu-count">{{ catalog.models.filter((m) => m.provider === p).length }}</span>
        </div>
      </template>

      <!-- Level 2: models of the provider -->
      <template v-else-if="level === 1">
        <div
          v-for="m in modelsOf"
          :key="m.id"
          class="model-menu-row"
          :class="{ 'model-menu-row--current': isCurrentModel(m) }"
          @click="pickModel(m)"
        >
          <span class="model-menu-dot">{{ isCurrentModel(m) ? '●' : '○' }}</span>
          <span class="model-menu-name" :title="`${m.provider}/${m.id}`">{{ m.name || m.id }}</span>
          <span class="model-menu-tag" :class="m.reasoning ? 'model-menu-tag--thinking' : 'model-menu-tag--plain'">
            {{ m.reasoning ? 'thinking' : 'plain' }}
          </span>
        </div>
      </template>

      <!-- Level 3: think levels offered by THIS model -->
      <template v-else>
        <template v-if="noneOnly">
          <div
            class="model-menu-row"
            :class="{ 'model-menu-row--current': isCurrentModel(model) && currentLevel === 'off' }"
            @click="commit('off')"
          >
            <span class="model-menu-dot">{{ isCurrentModel(model) && currentLevel === 'off' ? '●' : '○' }}</span>
            <span class="model-menu-name">(None)</span>
            <span class="model-menu-desc">No reasoning</span>
          </div>
        </template>
        <template v-else>
          <div
            v-for="l in levelsOf"
            :key="l"
            class="model-menu-row"
            :class="{ 'model-menu-row--current': isCurrentModel(model) && currentLevelFor(model) === l }"
            @click="commit(l)"
          >
            <span class="model-menu-dot">{{ isCurrentModel(model) && currentLevelFor(model) === l ? '●' : '○' }}</span>
            <span class="model-menu-name">{{ thinkLabel(l) }}</span>
            <span class="model-menu-desc">{{ LEVEL_DESCRIPTIONS[l] ?? '' }}</span>
          </div>
        </template>
      </template>

      <div v-if="busy" class="model-menu-row model-menu-muted">Applying…</div>
      <div v-if="notice" class="model-menu-row model-menu-notice">{{ notice }}</div>
    </template>
  </div>
</template>
