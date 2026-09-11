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
            <span class="welcome-m-card-text">All commands and tools, one tap away</span>
          </span>
        </div>
        <div class="welcome-m-card">
          <Icon icon="⚡" class="welcome-m-card-icon" />
          <span class="welcome-m-card-body">
            <span class="welcome-m-card-title">Session panel</span>
            <span class="welcome-m-card-text">Model and stats in the side panel</span>
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
    <div v-else class="welcome-d">
      <div class="welcome-d-hero">
        <h1>pi-agent-studio</h1>
        <p>Your pi agent, in the Studio shell</p>
      </div>
      <button class="welcome-btn welcome-d-cta" :disabled="store.backend === 'offline'" @click="store.newChat()">
        💬 Start a new chat
      </button>
      <div class="welcome-d-actions">
        <button class="welcome-d-action" @click="store.openModelCatalog()">
          <Icon icon="🤖" class="welcome-d-action-icon" />Model Catalog
        </button>
        <button class="welcome-d-action" @click="store.openPeakHours()">
          <Icon icon="🕒" class="welcome-d-action-icon" />Peak Hours
        </button>
        <button class="welcome-d-action" @click="store.openJobs()">
          <Icon icon="⏰" class="welcome-d-action-icon" />Scheduled Jobs
        </button>
      </div>
      <div class="welcome-d-facts">
        <div class="welcome-d-fact">
          <Icon icon="💬" class="welcome-d-fact-icon" />
          <span class="welcome-d-fact-body">
            <span class="welcome-d-fact-title">Chat panel</span>
            <span class="welcome-d-fact-text">Pinned, Chat History and live Sessions; the Directory tab filters chats by folder</span>
          </span>
        </div>
        <div class="welcome-d-fact">
          <Icon icon="🗂" class="welcome-d-fact-icon" />
          <span class="welcome-d-fact-body">
            <span class="welcome-d-fact-title">Workspaces</span>
            <span class="welcome-d-fact-text">Save the whole layout and bring it back later</span>
          </span>
        </div>
        <div class="welcome-d-fact">
          <Icon icon="⚡" class="welcome-d-fact-icon" />
          <span class="welcome-d-fact-body">
            <span class="welcome-d-fact-title">Session panel</span>
            <span class="welcome-d-fact-text">Switch model, watch live stats, set preferences for the active chat</span>
          </span>
        </div>
        <div class="welcome-d-fact">
          <Icon icon="⏰" class="welcome-d-fact-icon" />
          <span class="welcome-d-fact-body">
            <span class="welcome-d-fact-title">Scheduler</span>
            <span class="welcome-d-fact-text">Fire prompts on a cron — or at off-peak hours</span>
          </span>
        </div>
      </div>
      <p class="welcome-d-note">Busy agent? Messages queue up and flush when it idles — closing a chat tab never stops the session.</p>
    </div>
  </div>
</template>
