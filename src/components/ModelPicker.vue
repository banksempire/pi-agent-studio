<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

/** Width of a flyout level. Submenus open LEFT of their parent item with a
 *  small OVERLAP (6px) so the mouse can cross from a row into its submenu
 *  without leaving the menu region (a gap would close the flyout mid-hover). */
const SUB_WIDTH = 210;
const SUB_OVERLAP = 6;

const store = useChatStore();

const catalog = ref<ModelCatalog | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');

// Menu state
const open = ref(false);
const popStyle = ref({ left: '0px', top: '0px' });
const hoveredProvider = ref<string | null>(null);
const hoveredModel = ref<ModelInfo | null>(null);
// Fixed-positioned submenus (escape any ancestor overflow clipping).
const modelsSubStyle = ref({ left: '0px', top: '0px' });
const levelsSubStyle = ref({ left: '0px', top: '0px' });
const triggerEl = ref<HTMLButtonElement | null>(null);
const regionEl = ref<HTMLDivElement | null>(null);

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
  closeMenu();
  void load();
});
// The model can also change from outside the menu (e.g. /model in chat).
watch(() => active.value?.stats.model ?? null, () => void load());
onMounted(() => void load());

// ── Traditional flyout menu ────────────────────────────────────────────────

const providers = computed(() => {
  if (!catalog.value) return [];
  const seen = new Set<string>();
  for (const m of catalog.value.models) seen.add(m.provider);
  return [...seen].sort();
});

const modelsOf = (p: string) =>
  catalog.value?.models.filter((m) => m.provider === p) ?? [];

const isCurrentModel = (m: ModelInfo | null) =>
  !!m &&
  !!catalog.value?.current &&
  catalog.value.current.provider === m.provider &&
  catalog.value.current.id === m.id;

const currentLevelFor = (m: ModelInfo | null) =>
  isCurrentModel(m) ? catalog.value?.currentThinkingLevel ?? null : null;

const currentSummary = computed(() => {
  const cur = catalog.value?.current;
  if (!cur) return '—';
  const lvl = catalog.value?.currentThinkingLevel;
  const levelLabel = lvl && lvl !== 'off' ? lvl : '(None)';
  return `${cur.provider}/${cur.name || cur.id} · ${levelLabel}`;
});

function toggle() {
  if (open.value) closeMenu();
  else openMenu();
}

function openMenu() {
  if (!triggerEl.value) return;
  const r = triggerEl.value.getBoundingClientRect();
  popStyle.value = { left: `${r.left}px`, top: `${r.bottom + 2}px` };
  hoveredProvider.value = null;
  hoveredModel.value = null;
  open.value = true;
}

function closeMenu() {
  open.value = false;
  hoveredProvider.value = null;
  hoveredModel.value = null;
}

/** Open the models submenu to the LEFT of the hovered provider item. */
function onProviderEnter(e: MouseEvent, p: string) {
  hoveredProvider.value = p;
  hoveredModel.value = null;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  modelsSubStyle.value = { left: `${r.left - SUB_WIDTH + SUB_OVERLAP}px`, top: `${r.top - 3}px` };
}

/** Open the think-levels submenu to the LEFT of the hovered model item. */
function onModelEnter(e: MouseEvent, m: ModelInfo) {
  hoveredModel.value = m;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  levelsSubStyle.value = { left: `${r.left - SUB_WIDTH + SUB_OVERLAP}px`, top: `${r.top - 3}px` };
}

function onDocDown(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as Node;
  // Inside the trigger or the flyout region: let the normal click flow run
  // (the trigger toggles; a level row commits). Closing here would unmount
  // the row before its click fires.
  if (triggerEl.value?.contains(t) || regionEl.value?.contains(t)) return;
  closeMenu();
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu();
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onDocKey);
});

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
      closeMenu();
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
    <!-- Menu-bar-style trigger -->
    <button ref="triggerEl" class="model-menu-trigger" :disabled="busy" @click="toggle">
      <span class="model-menu-trigger-label">Model</span>
      <span class="model-menu-trigger-cur" :title="currentSummary">{{ currentSummary }}</span>
      <span class="model-menu-trigger-caret">{{ open ? '▲' : '▾' }}</span>
    </button>

    <div v-if="busy" class="model-menu-note">Applying…</div>
    <div v-if="notice" class="model-menu-note model-menu-note--ok">{{ notice }}</div>
    <div v-else-if="error" class="model-menu-note model-menu-note--err">{{ error }}</div>
    <div v-else-if="loading" class="model-menu-note">Loading models…</div>
    <div v-else-if="!active && !catalog" class="model-menu-note">Open a chat window to change its model.</div>

    <!-- Providers -->
    <div v-if="open" ref="regionEl" class="model-menu-region" @mouseleave="closeMenu()">
      <div class="model-menu-pop" :style="popStyle">
        <div class="mm-scroll">
          <div
            v-for="p in providers"
            :key="p"
            class="mm-item"
            :class="{ 'mm-item--on': hoveredProvider === p }"
            @mouseenter="onProviderEnter($event, p)"
          >
            <span class="mm-label">{{ p }}</span>
            <span class="mm-caret">▶</span>
          </div>
        </div>
      </div>

      <!-- Models of the hovered provider (fixed-positioned, opens left) -->
      <div v-if="hoveredProvider" class="mm-sub" :style="modelsSubStyle">
        <div class="mm-scroll">
          <div
            v-for="m in modelsOf(hoveredProvider)"
            :key="m.id"
            class="mm-item"
            :class="{ 'mm-item--on': hoveredModel === m }"
            @mouseenter="onModelEnter($event, m)"
          >
            <span class="mm-label" :title="`${m.provider}/${m.id}`">{{ m.name || m.id }}</span>
            <span class="mm-tag" :class="m.reasoning ? 'mm-tag--thinking' : 'mm-tag--plain'">
              {{ m.reasoning ? 'thinking' : 'plain' }}
            </span>
            <span class="mm-caret">▶</span>
          </div>
        </div>
      </div>

      <!-- Think levels THIS model offers (fixed-positioned, opens left) -->
      <div v-if="hoveredModel" class="mm-sub" :style="levelsSubStyle">
        <div class="mm-scroll">
          <div
            v-for="l in hoveredModel.thinkingLevels"
            :key="l"
            class="mm-item"
            :class="{ 'mm-item--cur': isCurrentModel(hoveredModel) && currentLevelFor(hoveredModel) === l }"
            :title="LEVEL_DESCRIPTIONS[l] ?? ''"
            @click.stop="commit(hoveredModel, l)"
          >
            <span class="mm-label">{{ thinkLabel(l) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
