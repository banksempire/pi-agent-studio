<script setup lang="ts">
import Dialog from '@sf/components/Dialog.vue';
import SingleMenu from '@sf/components/SingleMenu.vue';
import { kMobilePanelDismiss } from '@sf/composables/useWorkspace';
import type { SingleMenuOption } from '@sf/types/singleMenu';
import { computed, inject, nextTick, ref } from 'vue';
import { type ChatSession, endExternalDrag, startSessionDrag, timeAgo, useChatStore } from '../store/chat';
import SessionStatusDot from './SessionStatusDot.vue';

const props = defineProps<{ pinned?: boolean }>();

const store = useChatStore();
const dismissMobilePanel = inject<(() => void) | null>(kMobilePanelDismiss, null);

const sessions = computed(() =>
  [...store.filteredSessions]
    .filter((s) => store.isPinned(s.id) === !!props.pinned)
    .sort((a, b) => b.lastActivity - a.lastActivity),
);

const emptyMessage = computed(() => {
  if (store.filteredSessions.length === 0) {
    return store.selectedDirs.size > 0
      ? 'No chats in this directory.'
      : 'No chats yet — press Ctrl+N or click New Chat above to start one.';
  }
  return props.pinned ? 'No pinned chats — right-click one below to pin it.' : 'All chats are pinned.';
});

function open(s: ChatSession) {
  store.openChat(s.id);
  dismissMobilePanel?.();
}

function preview(s: ChatSession): string {
  const t = (s.preview || s.title).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

function menuItems(s: ChatSession): SingleMenuOption[] {
  const pinItem: SingleMenuOption = store.isPinned(s.id)
    ? { id: 'unpin', label: 'Unpin', icon: 'unpin' }
    : { id: 'pin', label: 'Pin', icon: 'pin' };
  return [
    pinItem,
    { id: 'rename', label: 'Rename', icon: '✎' },
    { id: 'delete', label: 'Delete', icon: '🗑', danger: true },
  ];
}

type RowDialog = { kind: 'rename'; session: ChatSession };
const dialog = ref<RowDialog | null>(null);
const renameEl = ref<HTMLInputElement | null>(null);
const renameInput = ref('');

function openRename(s: ChatSession) {
  renameInput.value = s.title;
  dialog.value = { kind: 'rename', session: s };
  nextTick(() => renameEl.value?.focus());
}
function closeDialog() {
  dialog.value = null;
}

async function confirmDialog() {
  const d = dialog.value;
  if (!d) return;
  closeDialog();
  const name = renameInput.value.trim();
  if (name && name !== d.session.title) await store.renameSession(d.session.id, name);
}

function onMenuSelect(s: ChatSession, item: SingleMenuOption) {
  if (item.id === 'pin' || item.id === 'unpin') store.togglePinned(s.id);
  else if (item.id === 'rename') openRename(s);
  else if (item.id === 'delete') void store.deleteSession(s.id);
}
</script>

<template>
  <div class="chat-list">
    <div v-if="sessions.length === 0" class="chat-list-empty">{{ emptyMessage }}</div>
    <SingleMenu
      :items="sessions"
      :options="menuItems"
      :key-of="(s: ChatSession) => s.id"
      :title-of="(s: ChatSession) => s.title"
      draggable
      @activate="open"
      @select="onMenuSelect"
      @dragstart="(s: ChatSession, e: DragEvent) => startSessionDrag(e, s)"
      @dragend="endExternalDrag"
    >
      <template #item="{ item: s }">
        <div
          class="chat-list-item"
          :class="{ 'chat-list-item--active': s.id === store.activeChatId }"
          :title="'Open chat window: ' + s.title"
        >
          <div class="chat-list-row1">
            <span class="chat-list-title">{{ s.title }}</span>
            <span class="chat-list-time">{{ timeAgo(s.lastActivity) }}</span>
          </div>
          <div class="chat-list-row2">
            <SessionStatusDot :session="s" />
            <span class="chat-list-preview">{{ preview(s) }}</span>
          </div>
        </div>
      </template>
    </SingleMenu>

    <Dialog :open="dialog !== null" title="Rename" @close="closeDialog">
      <input
        ref="renameEl"
        v-model="renameInput"
        class="chat-dialog-input"
        placeholder="Session name"
        @keydown.enter.prevent="confirmDialog"
      />
      <template #actions>
        <button class="sf-dialog-btn" type="button" @click="closeDialog">Cancel</button>
        <button class="sf-dialog-btn sf-dialog-btn--danger" type="button" @click="confirmDialog">
          Save
        </button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.chat-dialog-input {
  background: var(--sf-bg);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  color: var(--sf-text);
  font-family: var(--sf-font);
  font-size: 16px;
  padding: 6px 8px;
  outline: none;
}

.chat-dialog-input:focus {
  border-color: var(--sf-accent);
}
</style>
