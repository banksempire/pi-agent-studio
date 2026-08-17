<script setup lang="ts">
/**
 * User-message image attachments, rendered OUTSIDE the blue text bubble.
 *
 * Layout: all images in ONE horizontal row when they fit the available
 * width; otherwise a poker-card fan (leaves rotated around their bottom
 * edge, max 5 leaves — any extras are counted in a "+N" chip). A
 * ResizeObserver re-decides on panel/window resizes.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

export interface MessageImage {
  data: string;
  mimeType: string;
}

const props = defineProps<{ images: MessageImage[] }>();
const emit = defineEmits<{ open: [index: number] }>();

const box = ref<HTMLElement | null>(null);
const ratios = ref<number[]>([]);
const fan = ref(false);

/** Row-mode geometry: fixed thumb height, natural aspect up to a width cap. */
const THUMB_H = 150;
const ROW_MAX_W = 340;
const GAP = 8;
/** Fan-mode geometry: uniform cards so the leaves read as one structure. */
const FAN_W = 190;
const FAN_H = 150;

const urls = computed(() => props.images.map((im) => `data:${im.mimeType};base64,${im.data}`));

const fanLeaves = computed(() => Math.min(props.images.length, 5));
const fanExtra = computed(() => props.images.length - fanLeaves.value);

/** Leaf rotations: symmetric around 0°, spread ≤ 48°. */
const fanAngles = computed(() => {
  const n = fanLeaves.value;
  if (n <= 1) return [0];
  const step = n >= 5 ? 12 : Math.min(16, 48 / (n - 1));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
});

/** Fan container height = the rotated card's bounding box + shadow slack. */
const fanHeight = computed(() => {
  const maxA = (Math.max(0, ...fanAngles.value.map((a) => Math.abs(a))) * Math.PI) / 180;
  return Math.ceil(FAN_H * Math.cos(maxA) + FAN_W * Math.sin(maxA)) + 18;
});

function loadRatio(im: MessageImage): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight));
    img.onerror = () => resolve(1);
    img.src = `data:${im.mimeType};base64,${im.data}`;
  });
}

function rowWidths(): number[] {
  return ratios.value.map((r) => Math.min(r > 0 ? Math.round(THUMB_H * r) : THUMB_H, ROW_MAX_W));
}

function updateFit() {
  if (!box.value || ratios.value.length !== props.images.length) return;
  const widths = rowWidths();
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  fan.value = total > box.value.clientWidth;
}

function leafStyle(i: number) {
  return {
    width: `${FAN_W}px`,
    height: `${FAN_H}px`,
    marginLeft: `${-FAN_W / 2}px`,
    transform: `rotate(${fanAngles.value[i]}deg)`,
    zIndex: i + 1,
  };
}

let ro: ResizeObserver | null = null;
onMounted(async () => {
  ratios.value = await Promise.all(props.images.map(loadRatio));
  updateFit();
  ro = new ResizeObserver(updateFit);
  if (box.value) ro.observe(box.value);
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <div ref="box" class="msg-images" :class="{ 'msg-images--fan': fan }">
    <!-- Horizontal row: everything fits in one line -->
    <template v-if="!fan">
      <a
        v-for="(im, i) in images"
        :key="i"
        class="msg-image-link"
        :href="urls[i]"
        target="_blank"
        rel="noreferrer"
        title="Click to review"
        @click.prevent="emit('open', i)"
      >
        <img :src="urls[i]" class="msg-image" loading="lazy" alt="attached image" />
      </a>
    </template>
    <!-- Poker-card fan: leaves rotate around their bottom edge -->
    <template v-else>
      <div class="msg-fan" :style="{ height: fanHeight + 'px' }">
        <a
          v-for="(im, i) in images.slice(0, fanLeaves)"
          :key="i"
          class="msg-fan-leaf"
          :style="leafStyle(i)"
          :href="urls[i]"
          target="_blank"
          rel="noreferrer"
          title="Click to review"
          @click.prevent="emit('open', i)"
        >
          <img :src="urls[i]" loading="lazy" alt="attached image" />
        </a>
        <span v-if="fanExtra > 0" class="msg-fan-extra">+{{ fanExtra }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.msg-images {
  display: flex;
  flex-wrap: nowrap;
  align-items: flex-start;
  gap: 8px;
}
.msg-image-link {
  display: block;
  line-height: 0;
  flex: 0 0 auto;
  cursor: pointer;
}
.msg-image {
  display: block;
  height: 150px;
  width: auto;
  max-width: 340px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--sf-bg);
}
.msg-images--fan {
  display: block;
}
.msg-fan {
  position: relative;
}
.msg-fan-leaf {
  position: absolute;
  bottom: 0;
  left: 50%;
  display: block;
  line-height: 0;
  cursor: pointer;
  border: 2px solid var(--sf-bg);
  border-radius: 10px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
  overflow: hidden;
  transform-origin: 50% 100%;
  background: var(--sf-bg);
}
.msg-fan-leaf img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.msg-fan-extra {
  position: absolute;
  top: 0;
  left: calc(50% + 56px);
  min-width: 26px;
  padding: 1px 7px;
  border-radius: 12px;
  background: var(--sf-accent);
  color: var(--sf-text-on-accent);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}
</style>
