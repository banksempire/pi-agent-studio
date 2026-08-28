<script setup lang="ts">
import PillSelector from '@sf/components/PillSelector.vue';
import { computed, ref } from 'vue';
import { setDefaultModel } from '../modelInfo';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const detail = computed(() => store.modelDetail);
const busy = ref(false);
const error = ref('');

const levels = computed<string[]>(() => detail.value?.model.thinkingLevels ?? []);

const levelOptions = computed(() =>
  levels.value.map((l) => ({ value: l, label: l.charAt(0).toUpperCase() + l.slice(1) })),
);

const activeLevel = computed<string | null>(() => {
  const lv = store.modelDefaultLevel;
  if (lv && levels.value.includes(lv)) return lv;
  return levels.value[0] ?? null;
});

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

function onDefaultPick(want: boolean) {
  const d = detail.value;
  if (!d || busy.value || want === d.isDefault) return;
  void toggleDefault();
}

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
</script>

<template>
  <div class="model-preference">
    <template v-if="detail">
      <div class="prefs-row prefs-row--pill">
        <span class="prefs-key">Default model</span>
        <span class="prefs-right">
          <PillSelector
            :options="YES_NO"
            :model-value="detail.isDefault ? 'yes' : 'no'"
            @update:model-value="(v) => onDefaultPick(v === 'yes')"
          />
        </span>
      </div>
      <div v-if="detail.isDefault" class="model-preference-levels">
        <span class="model-preference-key">Thinking</span>
        <PillSelector
          class="model-preference-pills"
          :options="levelOptions"
          :model-value="activeLevel ?? ''"
          @update:model-value="(v) => pickLevel(String(v))"
        />
        <div v-if="store.modelDefaultSource === 'latest-chat'" class="model-preference-src">
          via latest new chat
        </div>
      </div>
      <div v-if="error" class="model-preference-note model-preference-note--err">{{ error }}</div>
    </template>
    <div v-else class="model-preference-hint">Select a model to change preferences.</div>
  </div>
</template>

<style scoped>
.model-preference {
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  row-gap: 10px;
}

.model-preference-hint {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.model-preference-levels {
  margin: 0 8px 8px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: 8px;
}

.model-preference-key {
  color: var(--sf-text-muted);
  font-size: 16px;
}

.model-preference-pills {
  text-align: right;
}

.model-preference :deep(.sf-pill-track) {
  flex-wrap: wrap;
  overflow-x: visible;
  scrollbar-width: auto;
}

.model-preference-src {
  grid-column: 1 / -1;
  color: var(--sf-text-muted);
  font-size: 14px;
  padding: 4px 0 0;
}

.model-preference-note {
  padding: 4px 8px;
  font-size: 16px;
  color: var(--sf-text-muted);
}

.model-preference-note--err {
  color: var(--sf-danger);
}
</style>
