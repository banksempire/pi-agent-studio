<script setup lang="ts">
import { kIsMobile } from '@sf/composables/useWorkspace';
import { computed, inject, onBeforeUnmount, type Ref, ref, watch } from 'vue';
import { parseHm } from '../peakHours';

const props = defineProps<{
  id?: string;
  modelValue: string;
}>();

const emit = defineEmits<(e: 'update:modelValue', v: string) => void>();

const injectedMobile = inject<Ref<boolean> | null>(kIsMobile, null);
const isMobile = computed(() => injectedMobile?.value ?? false);

const inputEl = ref<HTMLInputElement | null>(null);

const raw = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    if (v !== raw.value) raw.value = v;
  },
);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
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

function onTextInput() {
  emit('update:modelValue', raw.value);
}

function onBlur() {
  const n = looseNormalize();
  if (n) {
    raw.value = n;
    emit('update:modelValue', n);
  }
}

function onNativeInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}

let pickerSwallow: ((e: MouseEvent) => void) | null = null;

function disarmPickerSwallow() {
  if (!pickerSwallow) return;
  window.removeEventListener('mousedown', pickerSwallow, true);
  pickerSwallow = null;
}

function armPickerSwallow() {
  if (pickerSwallow) return;
  pickerSwallow = (e: MouseEvent) => {
    disarmPickerSwallow();
    if (e.target instanceof Node && inputEl.value?.contains(e.target)) return;
    e.stopPropagation();
  };
  window.addEventListener('mousedown', pickerSwallow, true);
}

function onNativeClick() {
  try {
    inputEl.value?.showPicker();
    armPickerSwallow();
  } catch {}
}

onBeforeUnmount(disarmPickerSwallow);

defineExpose({
  focus: () => inputEl.value?.focus(),
});
</script>

<template>
  <div class="tf">
    <input
      v-if="isMobile"
      :id="id"
      ref="inputEl"
      class="tf-input tf-input--native"
      type="time"
      :value="modelValue"
      @input="onNativeInput"
      @change="disarmPickerSwallow"
      @click="onNativeClick"
    >
    <input
      v-else
      :id="id"
      ref="inputEl"
      v-model="raw"
      class="tf-input"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      spellcheck="false"
      placeholder="HH:MM"
      @input="onTextInput"
      @blur="onBlur"
    >
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
  cursor: text;
  font-variant-numeric: tabular-nums;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none'><circle cx='12' cy='12' r='9' stroke='%23cccccc' stroke-width='2'/><path d='M12 7v5l3.5 2' stroke='%23cccccc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
}

.tf-input:focus {
  border-color: var(--sf-accent);
}

.tf:hover .tf-input {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none'><circle cx='12' cy='12' r='9' stroke='%23e0e0e0' stroke-width='2'/><path d='M12 7v5l3.5 2' stroke='%23e0e0e0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>");
}

.tf-input--native {
  color-scheme: dark;
  cursor: pointer;
}

.tf-input--native::-webkit-calendar-picker-indicator {
  display: none;
  -webkit-appearance: none;
}
</style>
