<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import type { ChatSession } from '../store/chat';

const props = defineProps<{ session: ChatSession }>();
</script>

<template>
  <span class="chat-list-status" :class="'chat-list-status--' + props.session.status">
    <SvgIcon v-if="props.session.status === 'running'" name="⏳" />
  </span>
</template>
