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
const AUTOSAVE_DEBOUNCE_MS = 500;

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

const allValid = computed(() => valid(form.globalMax) && valid(form.providerMax) && valid(form.modelMax));

const dirty = computed(() => {
  const s = store.scheduler;
  if (!s) return false;
  return (
    form.globalMax !== s.limits.globalMax ||
    form.providerMax !== s.limits.providerMax ||
    form.modelMax !== s.limits.modelMax
  );
});

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

let saveTimer: number | null = null;

watch(form, () => {
  if (busy.value || saveTimer !== null || !dirty.value || !allValid.value) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void save();
  }, AUTOSAVE_DEBOUNCE_MS);
});

async function save() {
  if (busy.value || !dirty.value || !allValid.value) return;
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
    if (!error.value && dirty.value && allValid.value && saveTimer === null) {
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void save();
      }, AUTOSAVE_DEBOUNCE_MS);
    }
  }
}
</script>

<template>
  <div class="scheduler-prefs">
    <div class="sp-row">
      <span class="sp-key">Global</span>
      <StepperInput v-model="form.globalMax" :min="1" :max="CAP_MAX" :step="1" title="Global concurrent job runs" />
    </div>
    <div class="sp-row">
      <span class="sp-key">Per Provider</span>
      <StepperInput v-model="form.providerMax" :min="1" :max="CAP_MAX" :step="1" title="Concurrent job runs per provider" />
    </div>
    <div class="sp-row">
      <span class="sp-key">Per Model</span>
      <StepperInput v-model="form.modelMax" :min="1" :max="CAP_MAX" :step="1" title="Concurrent job runs per model" />
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

.sp-note {
  padding-top: 6px;
  color: var(--sf-text-muted);
  font-size: 16px;
}

.sp-note--err {
  color: var(--sf-danger);
}
</style>
