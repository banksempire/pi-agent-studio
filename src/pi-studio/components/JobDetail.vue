<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { kPanelAction } from '@sf/composables/usePanelAction';
import { computed, inject } from 'vue';
import { describeCron } from '../cronInfo';
import { fmtRelative, fmtTime, scheduleText, targetText } from '../jobText';
import { useChatStore } from '../store/chat';

const store = useChatStore();

const job = computed(() => store.selectedJob);

type PanelActionFn = (action: { action?: string; payload?: unknown }) => void;
const panelAction = inject<PanelActionFn | null>(kPanelAction, null);

const cronDescribe = computed(() => (job.value?.cron ? describeCron(job.value.cron) : ''));

const nextText = computed(() =>
  !job.value?.enabled ? '—' : `${fmtTime(job.value.nextDue)} · ${fmtRelative(job.value.nextDue)}`,
);

const lastText = computed(() => {
  const r = job.value?.lastRun;
  if (!r) return '—';
  return `${r.status} ${fmtRelative(r.finishedAt ?? r.queuedAt)}`;
});

const lastClass = computed(() => (job.value?.lastRun ? `jd-status--${job.value.lastRun.status}` : ''));

const modelText = computed(() => {
  const m = job.value?.payload.model;
  if (!m) return 'session default';
  return job.value?.payload.thinkLevel ? `${m}·${job.value?.payload.thinkLevel}` : m;
});

const missedText = computed(() =>
  job.value?.missedPolicy === 'skip' ? 'skip, wait for the next occurrence' : 'run once on catch-up',
);

function edit() {
  if (!job.value) return;
  panelAction?.({ action: 'edit-job', payload: job.value.id });
}
</script>

<template>
  <div v-if="!job" class="jd-empty">Select a job in the table to see its details.</div>
  <div v-else class="job-detail">
    <div class="jd-head">
      <span class="jd-name" :title="job.name">{{ job.name }}</span>
      <span class="jd-badge" :class="job.enabled ? 'jd-badge--on' : 'jd-badge--off'">{{
        job.enabled ? 'active' : 'paused'
      }}</span>
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
      <button class="jd-edit" type="button" title="Edit job" @click="edit">
        <SvgIcon name="✎" />Edit job
      </button>
    </div>
  </div>
</template>

<style scoped>
.jd-empty {
  padding: 6px 8px;
  color: var(--sf-text-muted);
  font-size: 13px;
}

.job-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
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
  display: flex;
  justify-content: flex-end;
  padding-top: 2px;
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
