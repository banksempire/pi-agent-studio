<script setup lang="ts">
import { kIsMobile } from '@sf/composables/useWorkspace';
import { computed, inject, onBeforeUnmount, onMounted, type Ref, reactive, ref, watch } from 'vue';
import { parseHm } from '../peakHours';

const props = defineProps<{
  id?: string;
  modelValue: string;
}>();

const emit = defineEmits<(e: 'update:modelValue', v: string) => void>();

const injectedMobile = inject<Ref<boolean> | null>(kIsMobile, null);
const isMobile = computed(() => injectedMobile?.value ?? false);

const inputEl = ref<HTMLInputElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const popTarget = ref<HTMLElement | 'body'>('body');
const pop = reactive({ open: false, left: 0, top: 0, bottom: 0, below: true });

const raw = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    if (v !== raw.value) raw.value = v;
  },
);

const cur = computed(() => parseHm(props.modelValue));
const curHour = computed(() => (cur.value === null ? null : Math.floor(cur.value / 60)));
const curMinute = computed(() => (cur.value === null ? null : cur.value % 60));

const hours = Array.from({ length: 24 }, (_, h) => h);
const minutes = Array.from({ length: 60 }, (_, m) => m);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function publish(v: string) {
  raw.value = v;
  emit('update:modelValue', v);
}

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, '');
}

function looseNormalize(): string | null {
  const t = raw.value.trim();
  if (parseHm(t) !== null) return t;
  const d = digitsOnly(t);
  if (d.length === 1 || d.length === 2) {
    const h = Number(d);
    return h <= 23 ? `${pad2(h)}:00` : null;
  }
  if (d.length === 3 || d.length === 4) {
    const h = Number(d.slice(0, d.length - 2));
    const m = Number(d.slice(-2));
    return h <= 23 && m <= 59 ? `${pad2(h)}:${pad2(m)}` : null;
  }
  return null;
}

function onInput() {
  emit('update:modelValue', raw.value);
}

function onBlur() {
  const n = looseNormalize();
  if (n) publish(n);
}

function place() {
  const el = inputEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  pop.below = r.bottom + 250 < window.innerHeight;
  pop.left = Math.max(8, Math.min(r.left, window.innerWidth - 308));
  pop.top = r.bottom + 2;
  pop.bottom = window.innerHeight - r.top + 2;
}

function open() {
  place();
  pop.open = true;
}

function close() {
  pop.open = false;
}

function toggle() {
  inputEl.value?.focus();
  if (pop.open) close();
  else open();
}

function setHour(h: number) {
  publish(`${pad2(h)}:${pad2(curMinute.value ?? 0)}`);
}

function setMinute(m: number) {
  publish(`${pad2(curHour.value ?? 0)}:${pad2(m)}`);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && pop.open) {
    e.stopPropagation();
    close();
  } else if (e.key === 'Enter' && pop.open) {
    e.stopPropagation();
    close();
  }
}

function onDocMouseDown(e: MouseEvent) {
  if (!pop.open) return;
  const t = e.target as Node | null;
  if (rootEl.value?.contains(t)) return;
  if (t instanceof Element && t.closest('.tf-pop')) return;
  close();
}

onMounted(() => {
  popTarget.value = (document.querySelector('.sf-root') as HTMLElement | null) ?? 'body';
  window.addEventListener('mousedown', onDocMouseDown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDocMouseDown, true);
});

defineExpose({
  focus: () => inputEl.value?.focus(),
});
</script>

<template>
  <div ref="rootEl" class="tf" @click="toggle">
    <input
      :id="id"
      ref="inputEl"
      v-model="raw"
      class="tf-input"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      spellcheck="false"
      placeholder="HH:MM"
      :readonly="isMobile"
      @input="onInput"
      @blur="onBlur"
      @keydown="onKeydown"
    >
    <Teleport :to="popTarget">
      <div v-if="pop.open" class="tf-pop" :class="{ 'tf-pop--above': !pop.below }" :style="{
        left: `${pop.left}px`,
        top: pop.below ? `${pop.top}px` : 'auto',
        bottom: pop.below ? 'auto' : `${pop.bottom}px`,
      }" @mousedown.prevent>
        <div class="tf-col">
          <span class="tf-head">Hour</span>
          <div class="tf-grid tf-grid--hours">
            <button
              v-for="h in hours"
              :key="h"
              type="button"
              class="tf-cell"
              :class="{ 'tf-cell--sel': curHour === h }"
              :title="`${pad2(h)}:00`"
              @click="setHour(h)"
            >{{ pad2(h) }}</button>
          </div>
        </div>
        <div class="tf-col">
          <span class="tf-head">Minute</span>
          <div class="tf-grid tf-grid--minutes">
            <button
              v-for="m in minutes"
              :key="m"
              type="button"
              class="tf-cell"
              :class="{ 'tf-cell--sel': curMinute === m }"
              :title="`:${pad2(m)}`"
              @click="setMinute(m)"
            >{{ pad2(m) }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tf {
  position: relative;
  min-width: 0;
}

.tf-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--sf-bg);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 14px;
  padding: 5px 30px 5px 7px;
  outline: none;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none'><circle cx='12' cy='12' r='9' stroke='%23cccccc' stroke-width='2'/><path d='M12 7v5l3.5 2' stroke='%23cccccc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
}

.tf-input:focus {
  border-color: var(--sf-accent);
}

.tf-input[readonly] {
  color: var(--sf-text-bright);
}

.tf:hover .tf-input {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none'><circle cx='12' cy='12' r='9' stroke='%23e0e0e0' stroke-width='2'/><path d='M12 7v5l3.5 2' stroke='%23e0e0e0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>");
}

.tf-pop {
  position: fixed;
  z-index: 1150;
  display: flex;
  gap: 10px;
  padding: 8px;
  background: var(--sf-bg-lighter);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius);
  box-shadow: var(--sf-shadow);
  max-width: calc(100vw - 16px);
}

.tf-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tf-head {
  font-size: 11px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--sf-text-muted);
  padding: 0 2px 4px;
}

.tf-grid {
  display: grid;
  gap: 3px;
  overflow-y: auto;
  max-height: 190px;
  scrollbar-width: thin;
}

.tf-grid--hours {
  grid-template-columns: repeat(6, 30px);
}

.tf-grid--minutes {
  grid-template-columns: repeat(10, 30px);
}

.tf-cell {
  width: 30px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--sf-bg);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 0;
  cursor: pointer;
}

@media (hover: hover) {
  .tf-cell:hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.tf-cell--sel {
  background: var(--sf-accent);
  border-color: var(--sf-accent);
  color: var(--sf-text-on-accent);
}

@media (hover: hover) {
  .tf-cell--sel:hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
    color: var(--sf-text-on-accent);
  }
}

.sf-root--mobile .tf-pop {
  flex-direction: column;
  gap: 6px;
  left: 8px !important;
  right: 8px !important;
  top: auto !important;
  bottom: 8px !important;
  width: auto !important;
  max-width: none;
}

.sf-root--mobile .tf-grid {
  max-height: 120px;
}

.sf-root--mobile .tf-grid--hours,
.sf-root--mobile .tf-grid--minutes {
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
}

.sf-root--mobile .tf-cell {
  width: auto;
  height: 34px;
  font-size: 14px;
}
</style>
