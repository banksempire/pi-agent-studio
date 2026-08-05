<script setup lang="ts">
import { useChatStore } from '../store/chat';

const store = useChatStore();
</script>

<template>
  <div class="sf-welcome">
    <div class="sf-welcome-content">
      <h1>pi-agent-studio</h1>
      <p>Your pi agent, in the StudioFramework shell.</p>

      <button class="welcome-btn" @click="store.newChat()">💬 Start a new chat</button>

      <div class="sf-welcome-shortcuts">
        <div class="sf-shortcut"><kbd>Ctrl+N</kbd> New Chat</div>
        <div class="sf-shortcut"><kbd>Click</kbd> Chat History entry opens its window</div>
        <div class="sf-shortcut"><kbd>✕</kbd> on a tab closes the view — the session keeps running</div>
        <div class="sf-shortcut"><kbd>Right panel</kbd> shows live stats of the activated chat window</div>
      </div>
    </div>
  </div>
</template>
