<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import Menu from '@sf/components/Menu.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import { useChatStore, timeAgo, startSessionDrag, endExternalDrag, type ChatSession } from '../store/chat';

const store = useChatStore();

const sessions = computed(() =>
  [...store.filteredSessions].sort((a, b) => b.lastActivity - a.lastActivity),
);

function preview(s: ChatSession): string {
  const t = (s.preview || s.title).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? t.slice(0, 56) + '…' : t;
}

/** Which row's ⋮ action menu is open (session id; null = none). */
const menuOpenFor = ref<string | null>(null);

function menuItems(s: ChatSession): MenuNodeDef[] {
  return [
    { id: 'rename', label: 'Rename' },
    { id: 'delete', label: 'Delete' },
  ];
}

/** Inline themed dialog (no browser popups): rename input or delete confirm. */
type RowDialog =
  | { kind: 'rename'; session: ChatSession }
  | { kind: 'delete'; session: ChatSession };
const dialog = ref<RowDialog | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const renameEl = ref<HTMLInputElement | null>(null);
const renameInput = ref('');

function openRename(s: ChatSession) {
  renameInput.value = s.title;
  dialog.value = { kind: 'rename', session: s };
  nextTick(() => renameEl.value?.focus());
}
function openDelete(s: ChatSession) {
  dialog.value = { kind: 'delete', session: s };
  nextTick(() => dialogEl.value?.focus());
}
function closeDialog() {
  dialog.value = null;
}

async function confirmDialog() {
  const d = dialog.value;
  if (!d) return;
  closeDialog();
  if (d.kind === 'rename') {
    const name = renameInput.value.trim();
    if (name && name !== d.session.title) await store.renameSession(d.session.id, name);
  } else {
    await store.deleteSession(d.session.id);
  }
}

function onDialogKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeDialog();
}

function onMenuSelect(s: ChatSession, item: MenuNodeDef) {
  if (item.id === 'rename') openRename(s);
  else if (item.id === 'delete') openDelete(s);
}
</script>

<template>
  <div class="chat-list">
    <div v-if="store.backend === 'offline'" class="chat-list-empty">
      ⚠ Backend offline — start it with <code>npm run server</code> in pi-agent-studio.
      <div v-if="store.backendError" class="chat-list-error">{{ store.backendError }}</div>
    </div>
    <div v-else-if="store.selectedDirs.size > 0 && sessions.length === 0" class="chat-list-empty">
      No chats in this directory.
    </div>
    <div v-else-if="sessions.length === 0" class="chat-list-empty">
      No chats yet — press Ctrl+N or click New Chat above to start one.
    </div>
    <div
      v-for="s in sessions"
      :key="s.id"
      class="chat-list-item"
      :class="{ 'chat-list-item--active': s.id === store.activeChatId }"
      :title="'Open chat window: ' + s.title"
      draggable="true"
      @click="store.openChat(s.id)"
      @dragstart="startSessionDrag($event, s)"
      @dragend="endExternalDrag"
    >
      <div class="chat-list-row1">
        <span class="chat-list-title">{{ s.title }}</span>
        <span class="chat-list-time">{{ timeAgo(s.lastActivity) }}</span>
        <!-- Row action menu: ⋮ appears on hover; rename / delete. -->
        <Menu
          :items="menuItems(s)"
          :open="menuOpenFor === s.id"
          @update:open="(v: boolean) => { menuOpenFor = v ? s.id : null }"
          @select="(item: MenuNodeDef) => onMenuSelect(s, item)"
        >
          <template #trigger="{ toggle }">
            <button
              class="chat-item-menu"
              :class="{ 'chat-item-menu--open': menuOpenFor === s.id }"
              title="Session actions"
              @click.stop="toggle"
            >⋮</button>
          </template>
        </Menu>
      </div>
      <div class="chat-list-row2">
        <span class="chat-list-status" :class="'chat-list-status--' + s.status">
          {{ s.status === 'running' ? '⏳' : '' }}
        </span>
        <span class="chat-list-preview">{{ preview(s) }}</span>
      </div>
    </div>

    <!-- Inline themed dialog — rename input / delete confirm. Never the
         browser's native popup. -->
    <div v-if="dialog" class="chat-dialog-backdrop" @click.self="closeDialog">
      <div
        ref="dialogEl"
        class="chat-dialog"
        tabindex="-1"
        role="dialog"
        @keydown="onDialogKey"
      >
        <div class="chat-dialog-title">{{ dialog.kind === 'rename' ? 'Rename' : 'Delete chat' }}</div>

        <template v-if="dialog.kind === 'rename'">
          <input
            ref="renameEl"
            v-model="renameInput"
            class="chat-dialog-input"
            placeholder="Session name"
            @keydown.enter.prevent="confirmDialog"
          />
        </template>
        <div v-else class="chat-dialog-body">
          Delete “{{ dialog.session.title }}”? This permanently removes the session file.
        </div>

        <div class="chat-dialog-actions">
          <button class="chat-dialog-btn" @click="closeDialog">Cancel</button>
          <button class="chat-dialog-btn chat-dialog-btn--danger" @click="confirmDialog">
            {{ dialog.kind === 'rename' ? 'Save' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
