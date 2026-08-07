<script setup lang="ts">
import Framework, { type FrameworkAction } from '@sf/Framework.vue';
import { layout } from '../layout/loadLayout';
import { useChatStore } from '../store/chat';

const store = useChatStore();

function onAction(e: FrameworkAction) {
  switch (e.action) {
    case 'new-chat':
      store.newChat();
      break;
    case 'close-chat':
      if (store.activeChatId) store.closeChatView(store.activeChatId);
      break;
    case 'stop-chat':
      if (store.activeChatId) store.stopSession(store.activeChatId);
      break;
  }
}
</script>

<template>
  <Framework
    :layout="layout"
    @action="onAction"
    @workspace-ready="store.bindWorkspace"
  />
</template>
