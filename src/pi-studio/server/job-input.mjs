import { existsSync, statSync } from 'node:fs';
import { cronError } from '../../pi-nest/src/cron.mjs';

export function normalizeJobInput(body) {
  const out = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 200) return { error: 'name must be 1-200 characters' };
    out.name = name;
  }
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.scheduleType !== undefined) {
    if (body.scheduleType !== 'once' && body.scheduleType !== 'cron' && body.scheduleType !== 'nonpeak') {
      return { error: "scheduleType must be 'once', 'cron' or 'nonpeak'" };
    }
    out.scheduleType = body.scheduleType;
  }
  if (body.runAt !== undefined) {
    const runAt = Number(body.runAt);
    if (!Number.isFinite(runAt) || runAt <= 0)
      return { error: 'runAt must be a positive epoch-ms timestamp' };
    out.runAt = Math.round(runAt);
  }
  if (body.cron !== undefined) {
    const cron = String(body.cron).trim();
    const err = cronError(cron);
    if (err) return { error: `invalid cron expression: ${err}` };
    out.cron = cron;
  }
  if (body.message !== undefined) {
    const message = String(body.message);
    if (!message.trim() || message.length > 100_000) return { error: 'message must be 1-100000 characters' };
    out.message = message;
  }
  if (body.targetMode !== undefined) {
    if (!['file', 'new', 'reuse'].includes(body.targetMode)) {
      return { error: "targetMode must be 'file', 'new' or 'reuse'" };
    }
    out.targetMode = body.targetMode;
  }
  if (body.sessionFile !== undefined) {
    if (typeof body.sessionFile !== 'string' || !body.sessionFile)
      return { error: 'sessionFile must be a path' };
    out.sessionFile = body.sessionFile;
  }
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== 'string' || !body.cwd) return { error: 'cwd must be a path' };
    out.cwd = body.cwd;
  }
  if (body.model !== undefined) out.model = body.model === null ? null : String(body.model);
  if (body.thinkLevel !== undefined)
    out.thinkLevel = body.thinkLevel === null ? null : String(body.thinkLevel);
  if (body.missedPolicy !== undefined) {
    if (body.missedPolicy !== 'coalesce' && body.missedPolicy !== 'skip') {
      return { error: "missedPolicy must be 'coalesce' or 'skip'" };
    }
    out.missedPolicy = body.missedPolicy;
  }
  if (body.createdBy !== undefined) out.createdBy = String(body.createdBy).slice(0, 100);
  return { value: out };
}

export function validateJob(job) {
  if (!job.name) return 'name is required';
  if (job.scheduleType === 'once') {
    if (!job.runAt) return 'runAt is required for once jobs';
  } else if (job.scheduleType === 'cron') {
    if (!job.cron) return 'cron is required for cron jobs';
  } else if (job.scheduleType === 'nonpeak') {
    if (!job.cron) return 'cron is required for non-peak jobs';
    const model = job.payload?.model;
    if (typeof model !== 'string' || !model.includes('/')) {
      return 'non-peak jobs need a model override (provider/model) — peak windows are configured per model';
    }
  } else {
    return 'scheduleType is required';
  }
  const payload = job.payload ?? {};
  if (!payload.message || !String(payload.message).trim()) return 'message is required';
  const target = payload.target ?? {};
  if (target.mode === 'file') {
    if (!target.sessionFile || !existsSync(target.sessionFile)) {
      return 'target session file not found';
    }
  } else if (target.mode === 'new' || target.mode === 'reuse') {
    if (!target.cwd) return 'target cwd is required';
    let st = null;
    try {
      st = statSync(target.cwd);
    } catch {}
    if (!st?.isDirectory()) return 'target cwd is not a directory';
  } else {
    return 'target mode is required';
  }
  return null;
}

export function payloadFromInput(input) {
  const payload = {};
  if (input.message !== undefined) payload.message = input.message;
  if (input.targetMode !== undefined || input.sessionFile !== undefined || input.cwd !== undefined) {
    const target = {};
    if (input.targetMode !== undefined) target.mode = input.targetMode;
    if (input.sessionFile !== undefined) target.sessionFile = input.sessionFile;
    if (input.cwd !== undefined) target.cwd = input.cwd;
    payload.target = target;
  }
  if (input.model !== undefined) payload.model = input.model;
  if (input.thinkLevel !== undefined) payload.thinkLevel = input.thinkLevel;
  return payload;
}
