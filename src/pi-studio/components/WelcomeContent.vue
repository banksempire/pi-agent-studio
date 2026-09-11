<script setup lang="ts">
import Icon from '@sf/components/Icon.vue';
import { kIsMobile } from '@sf/composables/useWorkspace';
import { computed, inject, type Ref } from 'vue';
import { useChatStore } from '../store/chat';

const store = useChatStore();
const injectedMobile = inject<Ref<boolean> | null>(kIsMobile, null);
const isMobile = computed(() => injectedMobile?.value ?? false);
</script>

<template>
  <div class="sf-welcome">
    <div v-if="isMobile" class="welcome-m">
      <div class="welcome-m-hero">
        <h1>pi-agent-studio</h1>
        <p>Your pi agent, in the Studio shell</p>
      </div>
      <button class="welcome-btn welcome-m-cta" :disabled="store.backend === 'offline'" @click="store.newChat()">
        💬 Start a new chat
      </button>
      <div class="welcome-m-cards">
        <div class="welcome-m-card">
          <Icon icon="💬" class="welcome-m-card-icon" />
          <span class="welcome-m-card-body">
            <span class="welcome-m-card-title">Chat history</span>
            <span class="welcome-m-card-text">Reopen sessions from the bottom bar</span>
          </span>
        </div>
        <div class="welcome-m-card">
          <Icon icon="⋯" class="welcome-m-card-icon" />
          <span class="welcome-m-card-body">
            <span class="welcome-m-card-title">Menu</span>
            <span class="welcome-m-card-text">All commands and panels, one tap away</span>
          </span>
        </div>
        <div class="welcome-m-card">
          <Icon icon="▶" class="welcome-m-card-icon" />
          <span class="welcome-m-card-body">
            <span class="welcome-m-card-title">Live sessions</span>
            <span class="welcome-m-card-text">Closing a tab keeps the chat running</span>
          </span>
        </div>
      </div>
    </div>
    <div v-else class="sf-welcome-content">
      <h1>pi-agent-studio</h1>
      <p>Your pi agent, in the StudioFramework shell — real sessions, real agent.</p>

      <button class="welcome-btn" :disabled="store.backend === 'offline'" @click="store.newChat()">
        💬 Start a new chat
      </button>

      <div class="sf-welcome-shortcuts">
        <div class="sf-shortcut"><kbd>Ctrl+N</kbd> New Chat</div>
        <div class="sf-shortcut"><kbd>Click</kbd> a Chat History entry opens its window</div>
        <div class="sf-shortcut"><kbd>✕</kbd> on a tab closes the view — a running chat keeps going</div>
        <div class="sf-shortcut"><kbd>Right panel</kbd> shows live stats of the activated chat window</div>
      </div>
    </div>
  </div>
</template>
