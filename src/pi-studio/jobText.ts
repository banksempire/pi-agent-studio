import type { JobInfo } from './store/chat';

export function scheduleText(job: JobInfo): string {
  if (job.scheduleType === 'nonpeak') {
    const model = job.payload.model;
    return model ? `off-peak daily · ${model}` : 'off-peak daily';
  }
  return job.scheduleType === 'cron' ? `cron ${job.cron}` : `once ${fmtTime(job.runAt)}`;
}

export function targetText(job: JobInfo): string {
  const t = job.payload.target;
  if (t.mode === 'file') return `session ${(t.sessionFile ?? '').split('/').pop()}`;
  return `${t.mode === 'new' ? 'new' : 'reuse'} · ${t.cwd ?? ''}`;
}

export function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function fmtRelative(ms: number | null): string {
  if (!ms) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const human =
    mins < 1
      ? 'now'
      : mins < 60
        ? `${mins}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${human}` : `${human} ago`;
}
