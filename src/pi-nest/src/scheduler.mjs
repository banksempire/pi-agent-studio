import { countCronMatches, nextCronTime } from './cron.mjs';

export const SCHEDULER_TICK_MS = 30_000;
const TIMER_MAX_MS = 2 ** 31 - 1;

export function computeNextDue(job, fromMs) {
  if (job.scheduleType === 'cron') return nextCronTime(job.cron, fromMs);
  if (job.scheduleType === 'once') return job.runAt && job.runAt > fromMs ? job.runAt : fromMs;
  return null;
}

export class Scheduler {
  #journal;
  #registry;
  #onEvent;
  #tickMs;
  #interval = null;
  #timer = null;
  #ticking = false;

  constructor({ journal, registry, onEvent = null, tickMs = SCHEDULER_TICK_MS }) {
    this.#journal = journal;
    this.#registry = registry;
    this.#onEvent = onEvent;
    this.#tickMs = tickMs;
  }

  start() {
    const swept = this.#journal.sweepInterruptedRuns('backend restarted before delivery');
    if (swept > 0) console.log(`[scheduler] marked ${swept} interrupted run(s) from previous boot`);
    this.#interval = setInterval(() => {
      this.tick().catch((e) => console.error('[scheduler] tick failed:', e?.message ?? e));
    }, this.#tickMs);
    this.#interval.unref?.();
    this.tick().catch((e) => console.error('[scheduler] boot tick failed:', e?.message ?? e));
  }

  stop() {
    if (this.#interval) clearInterval(this.#interval);
    if (this.#timer) clearTimeout(this.#timer);
    this.#interval = null;
    this.#timer = null;
  }

  reschedule() {
    this.armTimer();
  }

  armTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    let earliest = null;
    for (const job of this.#journal.listJobs()) {
      if (!job.enabled) continue;
      if (earliest === null || job.nextDue < earliest) earliest = job.nextDue;
    }
    if (earliest === null) return;
    const delayMs = Math.max(0, Math.min(earliest - Date.now(), TIMER_MAX_MS));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.tick().catch((e) => console.error('[scheduler] timer tick failed:', e?.message ?? e));
    }, delayMs);
    this.#timer.unref?.();
  }

  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = Date.now();
      for (const job of this.#journal.dueJobs(now)) {
        if (job.scheduleType === 'cron' && job.missedPolicy === 'skip') {
          const missed = countCronMatches(job.cron, job.nextDue, now);
          if (missed >= 1) {
            await this.#skipMissed(job, now);
            continue;
          }
        }
        await this.fire(job, now).catch((e) =>
          console.error(`[scheduler] fire '${job.name}' failed:`, e?.message ?? e),
        );
      }
    } finally {
      this.#ticking = false;
    }
    this.armTimer();
  }

  async #skipMissed(job, now) {
    const runId = this.#journal.insertRun(job.id);
    const nextDue = computeNextDue(job, now);
    this.#journal.updateJob({ ...job, nextDue });
    if (runId !== null) this.#journal.finishRun(runId, 'skipped', 'missed while backend was down');
    this.#emit('skipped', this.#journal.getJob(job.id), runId);
    console.log(`[scheduler] skipped missed occurrence(s) of '${job.name}'`);
  }

  async fire(job, now = Date.now(), { manual = false } = {}) {
    const runId = this.#journal.insertRun(job.id);
    const updated = { ...job, updatedAt: now };
    if (!manual) {
      if (job.scheduleType === 'once') {
        updated.enabled = false;
      } else if (job.scheduleType === 'cron') {
        updated.nextDue = computeNextDue(job, now);
        if (updated.nextDue === null) {
          console.warn(`[scheduler] job '${job.name}' has no future occurrence — disabling`);
          updated.enabled = false;
        }
      }
      this.#journal.updateJob(updated);
    }
    this.#emit('fired', this.#journal.getJob(job.id), runId);
    const fresh = this.#journal.getJob(job.id) ?? job;
    let result;
    try {
      result = await this.#deliver(fresh, runId);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (runId !== null) this.#journal.finishRun(runId, 'error', msg);
      this.#emit('failed', fresh, runId, msg);
      console.error(`[scheduler] job '${job.name}' failed: ${msg}`);
      return { ok: false, runId, error: msg };
    }
    if (runId !== null) this.#journal.finishRun(runId, 'ok', '');
    this.#emit('finished', fresh, runId, '', result?.sessionFile);
    return { ok: true, runId, sessionFile: result?.sessionFile };
  }

  async #deliver(job, runId) {
    const payload = job.payload ?? {};
    const target = payload.target ?? {};
    let file = null;
    if (target.mode === 'file') {
      file = target.sessionFile;
    } else if (target.mode === 'reuse') {
      file = (await this.#registry.reuseOrCreateSession(target.cwd)).file;
    } else {
      file = (await this.#registry.createSession(target.cwd)).file;
    }
    if (!file || typeof file !== 'string') throw new Error('job target resolved to no session file');
    if (payload.model) {
      this.#registry.setPendingModel(file, payload.model, payload.thinkLevel ?? null);
    }
    this.#journal.markRunStarted(runId, {
      startedAt: Date.now(),
      sessionFile: file,
      queueItemId: null,
    });
    await this.#registry.prompt(file, payload.message ?? '', {
      interrupt: false,
      onQueued: (queueItemId) => {
        this.#journal.markRunStarted(runId, { startedAt: Date.now(), sessionFile: file, queueItemId });
      },
    });
    return { sessionFile: file };
  }

  async runNow(jobId) {
    const job = this.#journal.getJob(jobId);
    if (!job) return { ok: false, error: 'job not found' };
    return this.fire(job, Date.now(), { manual: true });
  }

  #emit(action, job, runId, error = '', sessionFile = '') {
    if (!this.#onEvent) return;
    try {
      this.#onEvent({ action, runId: runId ?? null, error, sessionFile, job });
    } catch {}
  }
}
