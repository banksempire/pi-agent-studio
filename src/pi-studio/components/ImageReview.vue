<script setup lang="ts">
/**
 * In-chat image review overlay. Rendered INSIDE the chat window the
 * images belong to (absolute over the window root — never a global
 * modal). Big image on top, a small-thumbnail gallery strip below —
 * the gallery only renders when the message has more than one image.
 * Close: ✕ button, Escape, or clicking the backdrop; ←/→ switch.
 */
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { MessageImage } from './MessageImages.vue';

const props = defineProps<{ images: MessageImage[]; start: number }>();
const emit = defineEmits<{ close: [] }>();

const idx = ref(Math.min(Math.max(0, props.start), props.images.length - 1));
const urls = computed(() => props.images.map((im) => `data:${im.mimeType};base64,${im.data}`));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close');
  } else if (e.key === 'ArrowLeft') {
    idx.value = (idx.value - 1 + props.images.length) % props.images.length;
  } else if (e.key === 'ArrowRight') {
    idx.value = (idx.value + 1) % props.images.length;
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="img-review" @click.self="emit('close')">
    <button class="img-review-close" title="Close (Esc)" @click="emit('close')"><SvgIcon name="✕" /></button>
    <div class="img-review-stage">
      <img :src="urls[idx]" class="img-review-main" alt="reviewed image" />
    </div>
    <div v-if="images.length > 1" class="img-review-gallery">
      <button
        v-for="(im, i) in images"
        :key="i"
        class="img-review-thumb"
        :class="{ 'img-review-thumb--active': i === idx }"
        :title="`Image ${i + 1} of ${images.length}`"
        @click="idx = i"
      >
        <img :src="urls[i]" alt="thumbnail" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.img-review {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: rgba(8, 9, 12, 0.86);
  user-select: none;
}
.img-review-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 34px 18px 6px;
}
.img-review-main {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.55);
}
.img-review-close {
  position: absolute;
  top: 8px;
  right: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}
.img-review-close:hover {
  background: rgba(255, 255, 255, 0.22);
}
.img-review-gallery {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 8px 14px 14px;
  overflow-x: auto;
}
.img-review-thumb {
  flex: 0 0 auto;
  width: 60px;
  height: 60px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  overflow: hidden;
  background: none;
  cursor: pointer;
}
.img-review-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.img-review-thumb--active {
  border-color: var(--sf-accent);
}
</style>
