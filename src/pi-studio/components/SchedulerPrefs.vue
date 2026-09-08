<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const form = reactive({ globalMax: 2, providerMax: 2, modelMax: 1 });
const busy = ref(false);
const error = ref('');
const saved = ref('');

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

const canSave = computed(
  () => valid(form.globalMax) && valid(form.providerMax) && valid(form.modelMax) && !busy.value,
);

watch(
  () => store.scheduler,
  (s) => {
    if (!s || busy.value) return;
    form.globalMax = s.limits.globalMax;
    form.providerMax = s.limits.providerMax;
    form.modelMax = s.limits.modelMax;
  },
  { immediate: true },
);

async function save() {
  if (!canSave.value) return;
  busy.value = true;
  error.value = '';
  saved.value = '';
  try {
    await store.updateSchedulerConfig({
      globalMax: form.globalMax,
      providerMax: form.providerMax,
      modelMax: form.modelMax,
    });
    saved.value = 'saved';
  } catch (err) {
    if (!(err instanceof TypeError)) error.value = String((err as Error)?.message ?? err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="scheduler-prefs">
    <div class="sp-row">
      <span class="sp-key">Max runs — global</span>
      <input v-model.number="form.globalMax" class="sp-input" type="number" min="1" step="1" />
    </div>
    <div class="sp-row">
      <span class="sp-key">Per provider</span>
      <input v-model.number="form.providerMax" class="sp-input" type="number" min="1" step="1" />
    </div>
    <div class="sp-row">
      <span class="sp-key">Per model</span>
      <input v-model.number="form.modelMax" class="sp-input" type="number" min="1" step="1" />
    </div>
    <div class="sp-actions">
      <button class="sp-save" type="button" :disabled="!canSave" title="Save concurrency caps" @click="save">
        {{ busy ? 'Saving…' : 'Save' }}
      </button>
    </div>
    <div v-if="error" class="sp-note sp-note--err">{{ error }}</div>
    <div v-else-if="saved" class="sp-note">Saved — caps apply immediately and survive restarts.</div>
    <div v-else class="sp-note">Caps apply immediately and survive restarts.</div>
  </div>
</template>

<style scoped>
.scheduler-prefs {
  padding: 4px 0;
}

.sp-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 3px 0;
  font-size: 16px;
}

.sp-key {
  color: var(--sf-text-muted);
  flex-shrink: 0;
}

.sp-input {
  box-sizing: border-box;
  width: 76px;
  padding: 4px 8px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15);
  color: var(--sf-text);
  font-size: 16px;
  font-family: var(--sf-mono, monospace);
  text-align: right;
  outline: none;
}

.sp-input:focus-visible {
  border-color: var(--sf-accent);
}

.sp-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 6px;
}

.sp-save {
  background: var(--sf-accent);
  border: 1px solid var(--sf-accent);
  border-radius: 4px;
  color: var(--sf-text-on-accent);
  font-family: var(--sf-font);
  font-size: 16px;
  padding: 4px 16px;
  cursor: pointer;
}

.sp-save:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (hover: hover) {
  .sp-save:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.sp-note {
  padding-top: 6px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.sp-note--err {
  color: var(--sf-danger);
}
</style>
