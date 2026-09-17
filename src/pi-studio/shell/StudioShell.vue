<script setup lang="ts">
import PopupDialog from '@sf/components/PopupDialog.vue';
import Framework, { type FrameworkAction } from '@sf/Framework.vue';
import { registerUtilityMenu } from '@sf/registry';
import type { PopupDocument, PopupValues } from '@sf/types/popup';
import { computed, nextTick, ref, watch } from 'vue';
import PeakHoursDialog from '../components/PeakHoursDialog.vue';
import { confirmDocument, confirmState, settleConfirm } from '../confirm';
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
    case 'about':
      aboutOpen.value = true;
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

watch(
  () => dialogs.renameDialog.open,
  (open) => {
    if (open) void nextTick(() => document.getElementById('session-name-input')?.focus());
  },
);

const renameValues = computed({
  get: (): PopupValues => ({ name: dialogs.renameDialog.value }),
  set: (next) => {
    if (next.name !== undefined) dialogs.renameDialog.value = String(next.name);
  },
});

const renameDoc = computed(
  (): PopupDocument => ({
    title: 'Rename',
    sections: [
      {
        fields: [
          {
            key: 'name',
            type: 'input',
            label: 'Session name',
            placeholder: 'Session name',
            id: 'session-name-input',
            inputClass: 'sf-dialog-input',
            spellcheck: false,
          },
        ],
      },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', close: true },
      { id: 'save', label: 'Save', tone: 'danger' },
    ],
  }),
);

const confirmDoc = computed(() => confirmDocument());

const aboutOpen = ref(false);
const aboutDoc = computed<PopupDocument>(() => ({
  title: 'About pi-agent-studio',
  sections: [
    {
      fields: [
        {
          key: 'text',
          type: 'info',
          text: 'pi-agent-studio — browser UI for pi agents, sessions and scheduled jobs.',
        },
      ],
    },
  ],
  actions: [{ id: 'ok', label: 'OK', tone: 'accent', close: true }],
}));

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
      <PopupDialog
        v-model:open="dialogs.renameDialog.open"
        v-model:values="renameValues"
        :doc="renameDoc"
        @action="(id) => (id === 'save' ? dialogs.confirmRename() : undefined)"
      />

      <PopupDialog
        v-model:open="confirmState.open"
        :doc="confirmDoc"
        @action="(id) => settleConfirm(id === 'confirm')"
      />

      <PopupDialog v-model:open="aboutOpen" :doc="aboutDoc" />

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
