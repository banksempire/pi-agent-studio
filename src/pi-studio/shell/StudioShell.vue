<script setup lang="ts">
import Dialog from '@sf/components/Dialog.vue';
import Framework, { type FrameworkAction } from '@sf/Framework.vue';
import { registerUtilityMenu } from '@sf/registry';
import { nextTick, ref, watch } from 'vue';
import PeakHoursDialog from '../components/PeakHoursDialog.vue';
import { layout } from '../layout/loadLayout';
import { handlePanelAction, usePanelDialogs } from '../layout/panelData';
import { refreshModelCatalog } from '../modelInfo';
import type { PeakHourEntry } from '../peakHours';
import { type SessionSyncState, SYNC_STATES, useChatStore } from '../store/chat';

const store = useChatStore();
const dialogs = usePanelDialogs();

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
    default:
      if (e.source === 'panel') handlePanelAction(e.action, e.payload);
  }
}

const renameInput = ref<HTMLInputElement | null>(null);

watch(
  () => dialogs.renameDialog.open,
  (open) => {
    if (open) void nextTick(() => renameInput.value?.focus());
  },
);

const peakEntry = ref<PeakHourEntry | null>(null);
watch(
  () => dialogs.peakDialog.open,
  (open) => {
    if (!open) {
      peakEntry.value = null;
      return;
    }
    const id = dialogs.peakDialog.entryId;
    peakEntry.value = id ? (store.peakHours.find((e) => e.id === id) ?? null) : null;
  },
);
</script>

<template>
  <Framework
    :layout="layout"
    @action="onAction"
    @workspace-ready="store.bindWorkspace"
  >
    <template #overlay>
      <Dialog
    :open="dialogs.renameDialog.open"
    title="Rename"
    @close="dialogs.renameDialog.open = false"
  >
    <input
      ref="renameInput"
      v-model="dialogs.renameDialog.value"
      class="sf-dialog-input"
      placeholder="Session name"
      @keydown.enter.prevent="dialogs.confirmRename()"
    />
    <template #actions>
      <button class="sf-dialog-btn" type="button" @click="dialogs.renameDialog.open = false">
        Cancel
      </button>
      <button class="sf-dialog-btn sf-dialog-btn--danger" type="button" @click="dialogs.confirmRename()">
        Save
      </button>
    </template>
  </Dialog>

      <PeakHoursDialog
        v-if="dialogs.peakDialog.open"
        :entry="peakEntry"
        :model-key="dialogs.peakModelKey.value"
        :model-choices="[]"
        @close="dialogs.closePeakDialog()"
        @saved="dialogs.onPeakSaved()"
      />
    </template>
  </Framework>
</template>
