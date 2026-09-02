import { api } from './store/chat';

export interface PeakHourEntry {
  id: string;
  provider: string;
  model: string;
  key: string;
  startUtc: string;
  endUtc: string;
  start: string;
  end: string;
  utcOffset: number;
  weekdays?: number[];
  note: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  wrapsMidnightUtc?: boolean;
}

export interface PeakHourInput {
  provider: string;
  model: string;
  start: string;
  end: string;
  utcOffset: number;
  weekdays?: number[];
  note?: string;
  enabled?: boolean;
}

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export const DOW_OPTIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, d) => ({
  value: d,
  label: name,
  title: name,
}));

export function weekdaysLabel(days: number[] | undefined): string {
  const wd = [...(days ?? [])].sort((a, b) => a - b);
  if (wd.length === 0) return '';
  if (wd.length === 7) return 'daily';
  const runs: string[] = [];
  let i = 0;
  while (i < wd.length) {
    let j = i;
    while (j + 1 < wd.length && wd[j + 1] === wd[j] + 1) j++;
    const first = DOW_OPTIONS[wd[i]].label;
    const last = DOW_OPTIONS[wd[j]].label;
    runs.push(j > i ? `${first}–${last}` : first);
    i = j + 1;
  }
  return runs.join(', ');
}

export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return mm === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(mm).padStart(2, '0')}`;
}

export const OFFSET_OPTIONS: Array<{ value: number; label: string }> = (() => {
  const out: Array<{ value: number; label: string }> = [];
  for (let h = -12; h <= 12; h++) out.push({ value: h * 60, label: offsetLabel(h * 60) });
  return out;
})();

export function browserUtcOffset(): number {
  return Math.round(-new Date().getTimezoneOffset() / 60) * 60;
}

export function parseHm(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function toUtcMinutes(localMinutes: number, offset: number): number {
  return (((localMinutes - offset) % 1440) + 1440) % 1440;
}

export function toLocalMinutes(utcMinutes: number, offset: number): number {
  return (((utcMinutes + offset) % 1440) + 1440) % 1440;
}

export function fmtHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function splitModelKey(key: string): { provider: string; model: string } | null {
  const t = key.trim();
  const sep = t.indexOf('/');
  if (sep <= 0 || sep >= t.length - 1) return null;
  return { provider: t.slice(0, sep), model: t.slice(sep + 1) };
}

export async function loadPeakHours(): Promise<PeakHourEntry[]> {
  const j = await api<{ entries: PeakHourEntry[] }>('/api/peak-hours');
  return j.entries ?? [];
}

export async function createPeakHours(input: PeakHourInput): Promise<PeakHourEntry> {
  const j = await api<{ entry: PeakHourEntry }>('/api/peak-hours', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return j.entry;
}

export async function updatePeakHours(id: string, patch: Partial<PeakHourInput>): Promise<PeakHourEntry> {
  const j = await api<{ entry: PeakHourEntry }>(`/api/peak-hours/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return j.entry;
}

export async function deletePeakHours(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/peak-hours/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
