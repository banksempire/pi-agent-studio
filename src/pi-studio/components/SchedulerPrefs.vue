<script setup lang="ts">
import StepperInput from '@sf/components/StepperInput.vue';
import { computed, reactive, ref, watch } from 'vue';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const form = reactive({ globalMax: 2, providerMax: 2, modelMax: 1 });
const busy = ref(false);
const error = ref('');

type CapKey = 'globalMax' | 'providerMax' | 'modelMax';
const CAP_MAX = 10;

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

const dirty = computed(() => {
  const s = store.scheduler;
  if (!s) return false;
  return (
    form.globalMax !== s.limits.globalMax ||
    form.providerMax !== s.limits.providerMax ||
    form.modelMax !== s.limits.modelMax
  );
});

const canSave = computed(
  () =>
    dirty.value && valid(form.globalMax) && valid(form.providerMax) && valid(form.modelMax) && !busy.value,
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
  try {
    await store.updateSchedulerConfig({
      globalMax: form.globalMax,
      providerMax: form.providerMax,
      modelMax: form.modelMax,
    });
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
      <span class="sp-key">Max concurrent runs</span>
      <StepperInput v-model="form.globalMax" :min="1" :max="CAP_MAX" :step="1" title="Max concurrent runs" />
    </div>
    <div class="sp-row">
      <span class="sp-key">Max runs per provider</span>
      <StepperInput v-model="form.providerMax" :min="1" :max="CAP_MAX" :step="1" title="Max runs per provider" />
    </div>
    <div class="sp-row">
      <span class="sp-key">Max runs per model</span>
      <StepperInput v-model="form.modelMax" :min="1" :max="CAP_MAX" :step="1" title="Max runs per model" />
    </div>
    <div class="sp-actions">
      <button
        class="sp-save"
        type="button"
        :disabled="!canSave"
        :title="canSave ? 'Save concurrency caps' : 'No changes to save'"
        @click="save"
      >
        {{ busy ? 'Saving…' : 'Save' }}
      </button>
    </div>
    <div v-if="error" class="sp-note sp-note--err">{{ error }}</div>
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
  padding: 4px 0;
  font-size: 16px;
}

.sp-key {
  color: var(--sf-text-muted);
  flex-shrink: 0;
}

.sp-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
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
  opacity: 0.4;
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
