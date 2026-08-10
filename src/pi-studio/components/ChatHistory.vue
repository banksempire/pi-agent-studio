<script setup lang="ts">
import { computed, ref } from 'vue';
import Menu from '@sf/components/Menu.vue';
import type { MenuNodeDef } from '@sf/types/layout';
import { useChatStore, timeAgo, type ChatSession } from '../store/chat';

const store = useChatStore();

const sessions = computed(() =>
  [...store.sessions].sort((a, b) => b.lastActivity - a.lastActivity),
);

function preview(s: ChatSession): string {
  const t = (s.preview || s.title).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? t.slice(0, 56) + '…' : t;
}

/** Which row's ⋮ action menu is open (session id; null = none). */
const menuOpenFor = ref<string | null>(null);

function menuItems(s: ChatSession): MenuNodeDef[] {
  return [
    { id: 'rename', label: 'Rename session' },
    { id: 'delete', label: 'Delete' },
  ];
}

async function onMenuSelect(s: ChatSession, item: MenuNodeDef) {
  if (item.id === 'rename') {
    const name = window.prompt('Rename session', s.title);
    if (name !== null && name.trim() && name.trim() !== s.title) {
      await store.renameSession(s.id, name.trim());
    }
  } else if (item.id === 'delete') {
    if (window.confirm(`Delete chat “${s.title}”? This permanently removes the session file.`)) {
      await store.deleteSession(s.id);
    }
  }
}
</script>

<template>
  <div class="chat-list">
    <div v-if="store.backend === 'offline'" class="chat-list-empty">
      ⚠ Backend offline — start it with <code>npm run server</code> in pi-agent-studio.
      <div v-if="store.backendError" class="chat-list-error">{{ store.backendError }}</div>
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
      @click="store.openChat(s.id)"
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
  </div>
</template>
