<script setup lang="ts">
import { useChatStore } from '../store/chat';

const store = useChatStore();
</script>

<template>
  <div class="sf-welcome">
    <div class="sf-welcome-content">
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
