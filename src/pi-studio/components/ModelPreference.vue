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

const levelOptions = computed(() => levels.value.map((l) => ({ value: l, label: l })));

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
</script>

<template>
  <div class="model-preference">
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
}

.model-preference-hint {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.model-preference .prefs-row {
  margin: 6px 8px 0;
}

.model-preference-levels {
  margin: 2px 8px 6px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.model-preference-key {
  color: var(--sf-text-muted);
  font-size: 16px;
}

.model-preference-pills {
  margin-left: auto;
}

.model-preference-src {
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
