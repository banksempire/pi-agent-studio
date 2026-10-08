<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const info = ref('');
const visible = ref(false);
let vv: VisualViewport | null = null;

function read() {
  const doc = document.documentElement;
  const root = document.querySelector('.sf-root');
  const rect = root?.getBoundingClientRect();
  const cs = root ? getComputedStyle(root) : null;
  const parts = [
    `screen ${window.screen.width}x${window.screen.height}`,
    `inner ${Math.round(window.innerHeight)}`,
    `client ${doc.clientHeight}`,
    `vv ${vv ? Math.round(vv.height) : '-'}`,
    `vvOff ${vv ? Math.round(vv.offsetTop) : '-'}`,
    `safeTop ${cs?.getPropertyValue('--sf-safe-top')?.trim() ?? '?'}`,
    `safeBot ${cs?.getPropertyValue('--sf-safe-bottom')?.trim() ?? '?'}`,
    `pin ${document.documentElement.style.getPropertyValue('--sf-app-height')?.trim() || '-'}`,
    `root ${rect ? Math.round(rect.height) : '-'}`,
    `scrollY ${Math.round(window.scrollY)}`,
  ];
  info.value = parts.join('  ·  ');
}

onMounted(() => {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  if (!standalone) return;
  visible.value = true;
  vv = window.visualViewport;
  read();
  window.addEventListener('resize', read);
  window.addEventListener('orientationchange', read);
  vv?.addEventListener('resize', read);
  vv?.addEventListener('scroll', read);
});

onUnmounted(() => {
  window.removeEventListener('resize', read);
  window.removeEventListener('orientationchange', read);
  vv?.removeEventListener('resize', read);
  vv?.removeEventListener('scroll', read);
});
</script>

<template>
  <div v-if="visible" class="qs-wpa-probe">{{ info }}</div>
</template>

<style scoped>
.qs-wpa-probe {
  position: fixed;
  top: 2px;
  left: 2px;
  right: 2px;
  z-index: 9999;
  pointer-events: none;
  font-family: ui-monospace, monospace;
  font-size: 9px;
  line-height: 1.5;
  color: #ffd866;
  background: rgb(0 0 0 / 72%);
  padding: 2px 4px;
  border-radius: 4px;
  user-select: text;
  -webkit-user-select: text;
  word-break: break-all;
}
</style>
