<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed } from 'vue';
import { describeCron } from '../cronInfo';
import { fmtRelative, fmtTime, scheduleText, targetText } from '../jobText';
import type { JobInfo } from '../store/chat';

const props = defineProps<{ job: JobInfo }>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'edit'): void;
}>();

const cronDescribe = computed(() => (props.job.cron ? describeCron(props.job.cron) : ''));

const nextText = computed(() =>
  props.job.enabled ? `${fmtTime(props.job.nextDue)} · ${fmtRelative(props.job.nextDue)}` : '—',
);

const lastText = computed(() => {
  const r = props.job.lastRun;
  if (!r) return '—';
  return `${r.status} ${fmtRelative(r.finishedAt ?? r.queuedAt)}`;
});

const lastClass = computed(() => (props.job.lastRun ? `jd-status--${props.job.lastRun.status}` : ''));

const modelText = computed(() => {
  const m = props.job.payload.model;
  if (!m) return 'session default';
  return props.job.payload.thinkLevel ? `${m}·${props.job.payload.thinkLevel}` : m;
});

const missedText = computed(() =>
  props.job.missedPolicy === 'skip' ? 'skip, wait for the next occurrence' : 'run once on catch-up',
);
</script>

<template>
  <aside class="jobs-detail">
    <div class="jd-head">
      <span class="jd-name" :title="job.name">{{ job.name }}</span>
      <span class="jd-badge" :class="job.enabled ? 'jd-badge--on' : 'jd-badge--off'">{{
        job.enabled ? 'active' : 'paused'
      }}</span>
      <button class="jd-close" type="button" title="Close details" @click="emit('close')">
        <SvgIcon name="✕" />
      </button>
    </div>

    <div class="jd-rows">
      <div class="jd-row">
        <span class="jd-key">Schedule</span>
        <span class="jd-val jd-mono">{{ scheduleText(job) }}</span>
      </div>
      <div v-if="cronDescribe" class="jd-row">
        <span class="jd-key" />
        <span class="jd-val jd-desc">{{ cronDescribe }}</span>
      </div>
      <div class="jd-row">
        <span class="jd-key">Next run</span>
        <span class="jd-val" :title="job.enabled ? fmtTime(job.nextDue) : undefined">{{ nextText }}</span>
      </div>
      <div class="jd-row">
        <span class="jd-key">Last run</span>
        <span class="jd-val" :class="lastClass">{{ lastText }}</span>
      </div>
      <div class="jd-row">
        <span class="jd-key">Target</span>
        <span class="jd-val jd-mono" :title="targetText(job)">{{ targetText(job) }}</span>
      </div>
      <div class="jd-row">
        <span class="jd-key">Model</span>
        <span class="jd-val">{{ modelText }}</span>
      </div>
      <div v-if="job.scheduleType !== 'once'" class="jd-row">
        <span class="jd-key">Missed runs</span>
        <span class="jd-val">{{ missedText }}</span>
      </div>
    </div>

    <div class="jd-msg-block">
      <span class="jd-key">Message</span>
      <p class="jd-msg">{{ job.payload.message }}</p>
    </div>

    <div class="jd-foot">
      <span class="jd-mono jd-id" :title="job.id">{{ job.id }}</span>
      <span class="jd-meta">created {{ fmtTime(job.createdAt) }} · by {{ job.createdBy || '—' }}</span>
    </div>

    <div class="jd-actions">
      <button class="jd-edit" type="button" title="Edit job" @click="emit('edit')">
        <SvgIcon name="✎" />Edit job
      </button>
    </div>
  </aside>
</template>

<style scoped>
.jobs-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
}

.jd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.jd-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--sf-text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jd-badge {
  flex-shrink: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--sf-border);
}

.jd-badge--on {
  color: #7bd88f;
  border-color: rgba(123, 216, 143, 0.4);
}

.jd-badge--off {
  color: var(--sf-text-muted);
}

.jd-close {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  color: var(--sf-text-muted);
  cursor: pointer;
  padding: 2px 6px;
}

@media (hover: hover) {
  .jd-close:hover {
    color: var(--sf-text-bright);
  }
}

.jd-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.jd-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.jd-key {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--sf-text-muted);
}

.jd-val {
  font-size: 13px;
  color: var(--sf-text);
  overflow-wrap: anywhere;
}

.jd-desc {
  opacity: 0.8;
}

.jd-mono {
  font-family: var(--sf-mono, monospace);
  font-size: 12px;
}

.jd-msg-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.jd-msg {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--sf-text);
  max-height: 180px;
  overflow-y: auto;
}

.jd-foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--sf-text-muted);
  padding-top: 10px;
  border-top: 1px solid var(--sf-border);
}

.jd-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jd-meta {
  opacity: 0.8;
}

.jd-actions {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

.jd-edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sf-accent);
  border: 1px solid var(--sf-accent);
  border-radius: 4px;
  color: var(--sf-text-on-accent);
  font-family: var(--sf-font);
  font-size: 13px;
  padding: 5px 14px;
  cursor: pointer;
}

@media (hover: hover) {
  .jd-edit:not(:disabled):hover {
    box-shadow: inset 0 0 0 999px var(--sf-hover-overlay);
  }
}

.jd-status--ok {
  color: #7bd88f;
}

.jd-status--error {
  color: #ff6d6d;
}

.jd-status--skipped,
.jd-status--interrupted {
  opacity: 0.6;
}
</style>
