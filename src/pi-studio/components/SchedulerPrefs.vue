<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, reactive, ref, watch } from 'vue';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const form = reactive({ globalMax: 2, providerMax: 2, modelMax: 1 });
const busy = ref(false);
const error = ref('');
const saved = ref('');

type CapKey = 'globalMax' | 'providerMax' | 'modelMax';
const CAP_MAX = 10;

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

function clamp(key: CapKey) {
  const n = Math.round(Number(form[key]));
  form[key] = Math.min(CAP_MAX, Math.max(1, Number.isFinite(n) ? n : 1));
}

function step(key: CapKey, dir: number) {
  const base = Number(form[key]);
  const n = (Number.isFinite(base) ? base : 1) + dir;
  form[key] = Math.min(CAP_MAX, Math.max(1, n));
}

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
      <span class="sp-key">Max concurrent runs</span>
      <div class="sp-ctrl">
        <input
          v-model.number="form.globalMax"
          class="sp-range"
          type="range"
          min="1"
          :max="CAP_MAX"
          step="1"
        />
        <div class="sp-spin">
          <input
            v-model.number="form.globalMax"
            class="sp-input"
            type="number"
            min="1"
            :max="CAP_MAX"
            step="1"
            @change="clamp('globalMax')"
          />
          <div class="sp-spin-btns">
            <button
              class="sp-spin-btn"
              type="button"
              tabindex="-1"
              title="Increase"
              @click="step('globalMax', 1)"
            >
              <SvgIcon name="⌃" />
            </button>
            <button
              class="sp-spin-btn"
              type="button"
              tabindex="-1"
              title="Decrease"
              @click="step('globalMax', -1)"
            >
              <SvgIcon name="⌄" />
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-key">Max runs per provider</span>
      <div class="sp-ctrl">
        <input
          v-model.number="form.providerMax"
          class="sp-range"
          type="range"
          min="1"
          :max="CAP_MAX"
          step="1"
        />
        <div class="sp-spin">
          <input
            v-model.number="form.providerMax"
            class="sp-input"
            type="number"
            min="1"
            :max="CAP_MAX"
            step="1"
            @change="clamp('providerMax')"
          />
          <div class="sp-spin-btns">
            <button
              class="sp-spin-btn"
              type="button"
              tabindex="-1"
              title="Increase"
              @click="step('providerMax', 1)"
            >
              <SvgIcon name="⌃" />
            </button>
            <button
              class="sp-spin-btn"
              type="button"
              tabindex="-1"
              title="Decrease"
              @click="step('providerMax', -1)"
            >
              <SvgIcon name="⌄" />
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="sp-row">
      <span class="sp-key">Max runs per model</span>
      <div class="sp-ctrl">
        <input
          v-model.number="form.modelMax"
          class="sp-range"
          type="range"
          min="1"
          :max="CAP_MAX"
          step="1"
        />
        <div class="sp-spin">
          <input
            v-model.number="form.modelMax"
            class="sp-input"
            type="number"
            min="1"
            :max="CAP_MAX"
            step="1"
            @change="clamp('modelMax')"
          />
          <div class="sp-spin-btns">
            <button
              class="sp-spin-btn"
              type="button"
              tabindex="-1"
              title="Increase"
              @click="step('modelMax', 1)"
            >
              <SvgIcon name="⌃" />
            </button>
            <button
              class="sp-spin-btn"
              type="button"
              tabindex="-1"
              title="Decrease"
              @click="step('modelMax', -1)"
            >
              <SvgIcon name="⌄" />
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="sp-actions">
      <button class="sp-save" type="button" :disabled="!canSave" title="Save concurrency caps" @click="save">
        {{ busy ? 'Saving…' : 'Save' }}
      </button>
    </div>
    <div v-if="error" class="sp-note sp-note--err">{{ error }}</div>
    <div v-else-if="saved" class="sp-note">Saved — caps apply immediately and persist across restarts.</div>
    <div v-else class="sp-note">Caps apply immediately and persist across restarts.</div>
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

.sp-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sp-range {
  width: 110px;
  accent-color: var(--sf-accent);
  cursor: pointer;
}

.sp-spin {
  display: flex;
  align-items: stretch;
}

.sp-spin .sp-input {
  width: 52px;
  border-radius: var(--sf-radius-sm) 0 0 var(--sf-radius-sm);
}

.sp-spin-btns {
  display: flex;
  flex-direction: column;
  width: 20px;
}

.sp-spin-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--sf-border);
  border-left: none;
  background: var(--sf-bg-lighter);
  color: var(--sf-text-muted);
  cursor: pointer;
}

.sp-spin-btn:first-child {
  border-radius: 0 var(--sf-radius-sm) 0 0;
  border-bottom: none;
}

.sp-spin-btn:last-child {
  border-radius: 0 0 var(--sf-radius-sm) 0;
}

@media (hover: hover) {
  .sp-spin-btn:hover {
    color: var(--sf-text-bright);
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.sp-spin-btn:active {
  color: var(--sf-accent);
}

.sp-input {
  box-sizing: border-box;
  width: 56px;
  padding: 4px 8px;
  border-radius: var(--sf-radius-sm);
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15);
  color: var(--sf-text);
  font-size: 16px;
  font-family: var(--sf-mono, monospace);
  text-align: right;
  outline: none;
  appearance: textfield;
  -moz-appearance: textfield;
}

.sp-input::-webkit-outer-spin-button,
.sp-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.sp-input:hover {
  border-color: var(--sf-accent);
}

.sp-input:focus-visible {
  border-color: var(--sf-accent);
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
