<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  options: Array<{ value: string | number; label: string; title?: string }>;
  modelValue: Array<string | number>;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: Array<string | number>] }>();

const trackEl = ref<HTMLElement | null>(null);
const itemEls: Array<HTMLElement | undefined> = [];
const rowBreakBefore = ref<Set<number>>(new Set());

const selectedSet = computed(() => new Set(props.modelValue));

function isSelected(v: string | number): boolean {
  return selectedSet.value.has(v);
}

function setItemEl(i: number, el: unknown) {
  itemEls[i] = (el as HTMLElement) ?? undefined;
}

function toggle(v: string | number) {
  const set = new Set(props.modelValue);
  if (set.has(v)) set.delete(v);
  else set.add(v);
  emit(
    'update:modelValue',
    props.options.map((o) => o.value).filter((x) => set.has(x)),
  );
}

function itemClasses(i: number): Record<string, boolean> {
  const on = isSelected(props.options[i].value);
  const prevOn = i > 0 && isSelected(props.options[i - 1].value);
  const nextOn = i < props.options.length - 1 && isSelected(props.options[i + 1].value);
  return {
    'je-ms-item--on': on,
    'je-ms-item--start': on && !prevOn,
    'je-ms-item--end': on && !nextOn,
    'je-ms-item--cont': on && nextOn,
    'je-ms-item--wrapclose': on && nextOn && rowBreakBefore.value.has(i + 1),
    'je-ms-item--wrapopen': on && prevOn && rowBreakBefore.value.has(i),
  };
}

function computeRows() {
  const next = new Set<number>();
  for (let i = 1; i < itemEls.length; i++) {
    const prev = itemEls[i - 1];
    const cur = itemEls[i];
    if (!prev || !cur) continue;
    if (Math.abs(cur.getBoundingClientRect().top - prev.getBoundingClientRect().top) > 1) next.add(i);
  }
  rowBreakBefore.value = next;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  computeRows();
  resizeObserver = new ResizeObserver(() => computeRows());
  if (trackEl.value) resizeObserver.observe(trackEl.value);
  document.fonts?.ready.then(() => computeRows());
});

onBeforeUnmount(() => resizeObserver?.disconnect());

watch(
  () => [props.modelValue, props.options],
  () => {
    void nextTick(computeRows);
  },
  { deep: true },
);
</script>

<template>
  <div class="je-ms" role="group">
    <div ref="trackEl" class="je-ms-track">
      <button
        v-for="(opt, i) in options"
        :key="opt.value"
        :ref="(el) => setItemEl(i, el)"
        type="button"
        class="je-ms-item"
        :class="itemClasses(i)"
        :title="opt.title ?? opt.label"
        :aria-pressed="isSelected(opt.value)"
        @click="toggle(opt.value)"
      >{{ opt.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.je-ms {
  max-width: 100%;
  container-type: inline-size;
}
.je-ms-track {
  --je-ms-gap: 5px;
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--je-ms-gap);
  padding: 3px;
  border-radius: 8px;
  border: 1px solid var(--sf-border);
  background: rgba(0, 0, 0, 0.15);
  width: fit-content;
  max-width: 100%;
}
.je-ms-item {
  position: relative;
  isolation: isolate;
  padding: 3px 11px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 16px;
  font-family: var(--sf-font);
  cursor: pointer;
  opacity: 0.75;
}
.je-ms-item:hover {
  opacity: 1;
}
.je-ms-item:focus-visible {
  outline: 2px solid var(--sf-accent-dim);
  outline-offset: 1px;
}
.je-ms-item--on {
  color: var(--sf-text-bright);
  opacity: 1;
}
.je-ms-item--on::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--sf-accent-soft);
  border: 1px solid var(--sf-accent-dim);
  border-radius: 8px;
}
.je-ms-item--cont::before {
  right: calc(var(--je-ms-gap, 5px) * -1);
  border-right: none;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.je-ms-item--cont.je-ms-item--wrapclose::before {
  right: 0;
  border-right: 1px solid var(--sf-accent-dim);
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
}
.je-ms-item--on:not(.je-ms-item--start)::before {
  left: 0;
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.je-ms-item--on:not(.je-ms-item--start).je-ms-item--wrapopen::before {
  border-left: 1px solid var(--sf-accent-dim);
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
}

@container (max-width: 640px) {
  .je-ms-track {
    --je-ms-gap: 4px;
  }
  .je-ms-item {
    padding: 3px 9px;
  }
}
@container (max-width: 540px) {
  .je-ms-track {
    --je-ms-gap: 2px;
  }
  .je-ms-item {
    padding: 3px 6px;
  }
}
@container (max-width: 490px) {
  .je-ms-track {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .je-ms-item {
    flex-shrink: 0;
  }
}
</style>
