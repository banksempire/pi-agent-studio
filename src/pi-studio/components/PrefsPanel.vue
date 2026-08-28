<script setup lang="ts">
import PillSelector from '@sf/components/PillSelector.vue';
import type { SendKeyMode } from '../store/chat';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const SEND_OPTIONS = [
  { value: 'enter', label: 'Enter', title: 'Enter sends, Shift+Enter new line' },
  { value: 'shiftEnter', label: 'Shift+Enter', title: 'Shift+Enter sends, Enter new line' },
];

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];
</script>

<template>
  <div class="prefs-panel">
    <div class="prefs-row prefs-row--pill">
      <span class="prefs-key">Send with</span>
      <span class="prefs-right">
        <PillSelector
          :options="SEND_OPTIONS"
          :model-value="store.prefs.sendKey"
          @update:model-value="(v) => store.setSendKey(v as SendKeyMode)"
        />
      </span>
    </div>

    <div class="prefs-row prefs-row--pill">
      <span class="prefs-key">Render Markdown</span>
      <span class="prefs-right">
        <PillSelector
          :options="YES_NO"
          :model-value="store.prefs.renderMarkdown ? 'yes' : 'no'"
          @update:model-value="(v) => store.setRenderMarkdown(v === 'yes')"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
.prefs-panel {
  padding: 4px 0;
}
</style>
