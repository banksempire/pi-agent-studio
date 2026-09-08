<script setup lang="ts">
import Framework, { type FrameworkAction } from '@sf/Framework.vue';
import { registerUtilityMenu } from '@sf/registry';
import { layout } from '../layout/loadLayout';
import { refreshModelCatalog } from '../modelInfo';
import { type SessionSyncState, SYNC_STATES, useChatStore } from '../store/chat';

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
    case 'open-model-catalog':
      store.openModelCatalog();
      break;
    case 'open-peak-hours':
      store.openPeakHours();
      break;
    case 'open-jobs':
      store.openJobs();
      break;
    case 'edit-job':
      if (store.selectedJob) store.openJobEditor(store.selectedJob.id);
      break;
    case 'refresh-model-catalog':
      void refreshModelCatalog().catch(() => {});
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
