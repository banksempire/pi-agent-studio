<script setup lang="ts">
import Framework, { type FrameworkAction } from '@sf/Framework.vue';
import { registerUtilityMenu } from '@sf/registry';
import { layout } from '../layout/loadLayout';
import { SYNC_STATES, type SessionSyncState, useChatStore } from '../store/chat';

const store = useChatStore();

registerUtilityMenu('session-filter', () =>
  SYNC_STATES.map((s) => ({
    id: s,
    label: s,
    iconKind: 'check' as const,
    selected: store.stateFilter[s],
  })),
);

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
    case 'session-filter':
      if (typeof e.payload === 'string') store.toggleStateFilter(e.payload as SessionSyncState);
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
