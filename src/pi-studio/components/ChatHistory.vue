<script setup lang="ts">
import SingleMenu from '@sf/components/SingleMenu.vue';
import SvgIcon from '@sf/components/SvgIcon.vue';
import { kMobilePanelDismiss } from '@sf/composables/useWorkspace';
import type { SingleMenuOption } from '@sf/types/singleMenu';
import { computed, inject, nextTick, ref } from 'vue';
import { type ChatSession, endExternalDrag, startSessionDrag, timeAgo, useChatStore } from '../store/chat';

const store = useChatStore();
const dismissMobilePanel = inject<(() => void) | null>(kMobilePanelDismiss, null);

const sessions = computed(() => [...store.filteredSessions].sort((a, b) => b.lastActivity - a.lastActivity));

function open(s: ChatSession) {
  store.openChat(s.id);
  dismissMobilePanel?.();
}

function preview(s: ChatSession): string {
  const t = (s.preview || s.title).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

function menuItems(_s: ChatSession): SingleMenuOption[] {
  return [
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

function onDialogKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeDialog();
}

function onMenuSelect(s: ChatSession, item: SingleMenuOption) {
  if (item.id === 'rename') openRename(s);
  else if (item.id === 'delete') void store.deleteSession(s.id);
}
</script>

<template>
  <div class="chat-list">
    <div v-if="store.selectedDirs.size > 0 && sessions.length === 0" class="chat-list-empty">
      No chats in this directory.
    </div>
    <div v-else-if="sessions.length === 0" class="chat-list-empty">
      No chats yet — press Ctrl+N or click New Chat above to start one.
    </div>
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
            <span class="chat-list-status" :class="'chat-list-status--' + s.status">
              <SvgIcon v-if="s.status === 'running'" name="⏳" />
            </span>
            <span class="chat-list-preview">{{ preview(s) }}</span>
          </div>
        </div>
      </template>
    </SingleMenu>

    <div v-if="dialog" class="chat-dialog-backdrop" @click.self="closeDialog">
      <div class="chat-dialog" tabindex="-1" role="dialog" @keydown="onDialogKey">
        <div class="chat-dialog-title">Rename</div>

        <input
          ref="renameEl"
          v-model="renameInput"
          class="chat-dialog-input"
          placeholder="Session name"
          @keydown.enter.prevent="confirmDialog"
        />

        <div class="chat-dialog-actions">
          <button class="chat-dialog-btn" @click="closeDialog">Cancel</button>
          <button class="chat-dialog-btn chat-dialog-btn--danger" @click="confirmDialog">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>
