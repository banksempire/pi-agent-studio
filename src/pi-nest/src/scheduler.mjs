import { countCronMatches, nextCronTime } from './cron.mjs';

export const SCHEDULER_TICK_MS = 30_000;
const TIMER_MAX_MS = 2 ** 31 - 1;
export const DEFAULT_SCHED_LIMITS = { globalMax: 2, providerMax: 2, modelMax: 1 };
const ALWAYS_OPEN_PEAK = { isPeakAt: () => false, nextOpenAt: (_p, _m, fromMs) => fromMs };
const DEFER_FALLBACK_MS = 24 * 3600_000;
const DEFER_MIN_MS = 60_000;

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfNextLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function normLimit(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function jobModelKey(job) {
  const model = job?.payload?.model;
  if (typeof model !== 'string' || !model) return null;
  const sep = model.indexOf('/');
  if (sep < 1 || sep === model.length - 1) return null;
  return { provider: model.slice(0, sep).toLowerCase(), model: model.toLowerCase() };
}

function nextOpenFrom(peak, key, baseMs) {
  let open = null;
  if (key) {
    try {
      open = peak.nextOpenAt(key.provider, key.model, baseMs);
    } catch {}
  }
  return Number.isFinite(open) ? open : baseMs + DEFER_FALLBACK_MS;
}

export function computeNextDue(job, fromMs, peak = ALWAYS_OPEN_PEAK, { dayAnchored = false } = {}) {
  if (job.scheduleType === 'cron') return nextCronTime(job.cron, fromMs);
  if (job.scheduleType === 'nonpeak') {
    const base = dayAnchored ? startOfNextLocalDay(fromMs) : fromMs + DEFER_MIN_MS;
    return nextOpenFrom(peak, jobModelKey(job), base);
  }
  if (job.scheduleType === 'once') return job.runAt && job.runAt > fromMs ? job.runAt : fromMs;
  return null;
}

export class Scheduler {
  #journal;
  #registry;
  #onEvent;
  #tickMs;
  #peak;
  #limits;
  #interval = null;
  #timer = null;
  #ticking = false;
  #inflight = new Set();
  #changeWaiters = new Set();

  constructor({
    journal,
    registry,
    onEvent = null,
    tickMs = SCHEDULER_TICK_MS,
    peak = null,
    limits = {},
  } = {}) {
    this.#journal = journal;
    this.#registry = registry;
    this.#onEvent = onEvent;
    this.#tickMs = tickMs;
    this.#peak = peak ?? ALWAYS_OPEN_PEAK;
    this.#limits = {
      globalMax: normLimit(limits.globalMax, DEFAULT_SCHED_LIMITS.globalMax),
      providerMax: normLimit(limits.providerMax, DEFAULT_SCHED_LIMITS.providerMax),
      modelMax: normLimit(limits.modelMax, DEFAULT_SCHED_LIMITS.modelMax),
    };
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
    const rawDelay = earliest - Date.now();
    const delayMs =
      rawDelay < 0 && this.#inflight.size > 0 ? this.#tickMs : Math.max(0, Math.min(rawDelay, TIMER_MAX_MS));
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
        if (job.missedPolicy === 'skip') {
          const missedOccurrence =
            job.scheduleType === 'cron'
              ? countCronMatches(job.cron, job.nextDue, now) >= 1
              : job.scheduleType === 'nonpeak'
                ? job.nextDue < startOfLocalDay(now)
                : false;
          if (missedOccurrence) {
            await this.#skipMissed(job, now);
            continue;
          }
        }
        if (job.scheduleType === 'nonpeak' && this.#isPeakNow(job, now)) {
          this.#deferPastPeak(job, now);
          continue;
        }
        const slot = this.#acquire(job);
        if (!slot) continue;
        this.#launch(job, now, slot);
      }
    } finally {
      this.#ticking = false;
    }
    this.armTimer();
  }

  #isPeakNow(job, now) {
    const key = jobModelKey(job);
    if (!key) return false;
    try {
      return !!this.#peak.isPeakAt(key.provider, key.model, now);
    } catch {
      return false;
    }
  }

  #deferPastPeak(job, now) {
    const key = jobModelKey(job);
    let openAt = null;
    try {
      openAt = key ? this.#peak.nextOpenAt(key.provider, key.model, now) : null;
    } catch {}
    const deferTo = Math.max(Number.isFinite(openAt) ? openAt : now + DEFER_FALLBACK_MS, now + DEFER_MIN_MS);
    this.#journal.updateJob({ ...job, nextDue: deferTo, updatedAt: now });
    this.#emit('deferred', this.#journal.getJob(job.id), null);
    console.log(
      `[scheduler] deferred '${job.name}' — ${key ? `${key.provider}/${key.model}` : 'model'} is in a peak window (next attempt ${new Date(deferTo).toISOString()})`,
    );
  }

  #launch(job, now, slot) {
    this.fire(job, now)
      .catch((e) => console.error(`[scheduler] fire '${job.name}' failed:`, e?.message ?? e))
      .finally(() => {
        this.#release(slot);
        this.tick().catch((e) => console.error('[scheduler] retry tick failed:', e?.message ?? e));
      });
  }

  async #skipMissed(job, now) {
    const runId = this.#journal.insertRun(job.id);
    const nextDue = computeNextDue(job, now, this.#peak, { dayAnchored: true });
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
      } else if (job.scheduleType === 'cron' || job.scheduleType === 'nonpeak') {
        updated.nextDue = computeNextDue(job, now, this.#peak, { dayAnchored: true });
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
    const slot = await this.#waitForSlot(job);
    try {
      return await this.fire(job, Date.now(), { manual: true });
    } finally {
      this.#release(slot);
    }
  }

  #acquire(job) {
    if (this.#inflight.size >= this.#limits.globalMax) return null;
    const key = jobModelKey(job);
    if (key) {
      let perProvider = 0;
      let perModel = 0;
      for (const slot of this.#inflight) {
        if (!slot.key) continue;
        if (slot.key.provider === key.provider) perProvider++;
        if (slot.key.model === key.model) perModel++;
      }
      if (perProvider >= this.#limits.providerMax || perModel >= this.#limits.modelMax) return null;
    }
    const slot = { key };
    this.#inflight.add(slot);
    return slot;
  }

  #release(slot) {
    this.#inflight.delete(slot);
    if (this.#changeWaiters.size > 0) {
      const waiters = [...this.#changeWaiters];
      this.#changeWaiters.clear();
      for (const w of waiters) w();
    }
  }

  async #waitForSlot(job) {
    for (;;) {
      const slot = this.#acquire(job);
      if (slot) return slot;
      await new Promise((resolve) => this.#changeWaiters.add(resolve));
    }
  }

  async idle() {
    for (;;) {
      if (this.#inflight.size === 0 && !this.#ticking) return;
      const changed = new Promise((resolve) => this.#changeWaiters.add(resolve));
      const nudge = new Promise((resolve) => setTimeout(resolve, 25));
      await Promise.race([changed, nudge]);
    }
  }

  stats() {
    return {
      running: this.#inflight.size,
      waiting: this.#journal.dueJobs(Date.now()).length,
      limits: { ...this.#limits },
    };
  }

  #emit(action, job, runId, error = '', sessionFile = '') {
    if (!this.#onEvent) return;
    try {
      this.#onEvent({ action, runId: runId ?? null, error, sessionFile, job });
    } catch {}
  }
}
