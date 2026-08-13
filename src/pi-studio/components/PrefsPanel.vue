<script setup lang="ts">
import { useChatStore } from '../store/chat';

const store = useChatStore();
</script>

<template>
  <div class="prefs-panel">
    <!-- Global: which key sends; the other key inserts a new line. -->
    <div class="prefs-row">
      <span class="prefs-key">Send with</span>
      <span class="prefs-right">
        <span class="prefs-hint">{{ store.prefs.sendKey === 'enter' ? 'Enter ↵' : 'Shift+Enter' }}</span>
        <button
          class="md-switch sf-panel-btn"
          :class="{ 'md-switch--on': store.prefs.sendKey === 'shiftEnter' }"
          role="switch"
          :aria-checked="store.prefs.sendKey === 'shiftEnter'"
          :title="store.prefs.sendKey === 'enter' ? 'Enter sends, Shift+Enter new line' : 'Shift+Enter sends, Enter new line'"
          @click="store.setSendKey(store.prefs.sendKey === 'enter' ? 'shiftEnter' : 'enter')"
        ><span class="md-switch-knob" /></button>
      </span>
    </div>

    <!-- Global: render message text as markdown in every chat window. -->
    <div class="prefs-row">
      <span class="prefs-key">Markdown</span>
      <span class="prefs-right">
        <span class="prefs-hint">{{ store.prefs.renderMarkdown ? 'md' : 'raw' }}</span>
        <button
          class="md-switch sf-panel-btn"
          :class="{ 'md-switch--on': store.prefs.renderMarkdown }"
          role="switch"
          :aria-checked="store.prefs.renderMarkdown"
          :title="store.prefs.renderMarkdown ? 'Markdown rendered — click to show raw text' : 'Raw text — click to render markdown'"
          @click="store.setRenderMarkdown(!store.prefs.renderMarkdown)"
        ><span class="md-switch-knob" /></button>
      </span>
    </div>
  </div>
</template>
