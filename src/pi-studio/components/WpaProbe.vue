<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const info = ref('');
const barInfo = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

function read() {
  const doc = document.documentElement;
  const root = document.querySelector('.sf-root');
  const bar = document.querySelector('.sf-status-bar');
  const rootRect = root?.getBoundingClientRect();
  const docRect = doc.getBoundingClientRect();
  const barRect = bar?.getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  const barCs = bar ? getComputedStyle(bar) : null;
  info.value = [
    `screen ${window.screen.width}x${window.screen.height}`,
    `inner ${Math.round(window.innerHeight)}`,
    `client ${doc.clientHeight}`,
    `dvh ${doc.clientHeight}`,
    `envT ${cs.getPropertyValue('--sf-safe-top').trim()}`,
    `envB ${cs.getPropertyValue('--sf-safe-bottom').trim()}`,
    `html ${Math.round(docRect.top)}..${Math.round(docRect.bottom)}`,
    `root ${rootRect ? `${Math.round(rootRect.top)}..${Math.round(rootRect.bottom)}` : '-'}`,
    `scroll ${Math.round(window.scrollY)}`,
  ].join('  ·  ');
  barInfo.value = barRect
    ? `bar ${Math.round(barRect.top)}..${Math.round(barRect.bottom)} h${Math.round(barRect.height)} padB ${barCs?.paddingBottom}`
    : 'bar -';
}

onMounted(() => {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  if (!standalone) return;
  read();
  timer = setInterval(read, 600);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="info" class="qs-wpa-probe">
    <div>{{ info }}</div>
    <div>{{ barInfo }}</div>
  </div>
</template>

<style scoped>
.qs-wpa-probe {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 68px);
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
