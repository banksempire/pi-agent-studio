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
    <label class="sp-field">
      <span class="sp-label">Max concurrent runs — global</span>
      <input v-model.number="form.globalMax" class="sp-input" type="number" min="1" step="1" />
    </label>
    <label class="sp-field">
      <span class="sp-label">Per provider</span>
      <input v-model.number="form.providerMax" class="sp-input" type="number" min="1" step="1" />
    </label>
    <label class="sp-field">
      <span class="sp-label">Per model</span>
      <input v-model.number="form.modelMax" class="sp-input" type="number" min="1" step="1" />
    </label>
    <button class="sp-save" type="button" :disabled="!canSave" title="Save concurrency caps" @click="save">
      {{ busy ? 'Saving…' : 'Save' }}
    </button>
    <div v-if="error" class="sp-note sp-note--err">{{ error }}</div>
    <div v-else-if="saved" class="sp-note">Saved — caps apply immediately and survive restarts.</div>
    <div v-else class="sp-note">Caps apply immediately and survive restarts.</div>
  </div>
</template>

<style scoped>
.scheduler-prefs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
}

.sp-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sp-label {
  color: var(--sf-text-muted);
  font-size: 16px;
}

.sp-input {
  box-sizing: border-box;
  width: 110px;
  padding: 6px 10px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15);
  color: var(--sf-text);
  font-size: 16px;
  font-family: var(--sf-font);
  outline: none;
}

.sp-input:focus-visible {
  border-color: var(--sf-accent);
}

.sp-save {
  align-self: flex-start;
  background: var(--sf-accent);
  border: 1px solid var(--sf-accent);
  border-radius: 4px;
  color: var(--sf-text-on-accent);
  font-family: var(--sf-font);
  font-size: 16px;
  padding: 5px 14px;
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
  color: var(--sf-text-muted);
  font-size: 16px;
}

.sp-note--err {
  color: var(--sf-danger);
}
</style>
