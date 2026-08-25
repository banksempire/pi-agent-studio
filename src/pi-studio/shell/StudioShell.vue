<script setup lang="ts">
import Framework, { type FrameworkAction } from '@sf/Framework.vue';
import { registerUtilityMenu } from '@sf/registry';
import { layout } from '../layout/loadLayout';
import { type JobsSort, type SessionSyncState, SYNC_STATES, useChatStore } from '../store/chat';

const store = useChatStore();

const JOBS_SORTS: Array<{ id: JobsSort; label: string }> = [
  { id: 'created', label: 'Create time' },
  { id: 'next', label: 'Next run time' },
  { id: 'name', label: 'Name' },
];

registerUtilityMenu('session-filter', () =>
  SYNC_STATES.map((s) => ({
    id: s,
    label: s,
    iconKind: 'check' as const,
    selected: store.stateFilter[s],
  })),
);

registerUtilityMenu('jobs-sort', () =>
  JOBS_SORTS.map((s) => ({
    id: s.id,
    label: s.label,
    iconKind: 'check' as const,
    selected: store.jobsSort === s.id,
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
    case 'new-job':
      store.openJobEditor(null);
      break;
    case 'jobs-sort':
      if (e.payload === 'created' || e.payload === 'next' || e.payload === 'name') {
        store.setJobsSort(e.payload);
      }
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
