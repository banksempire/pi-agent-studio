import { api } from './store/chat';

export interface PeakHourEntry {
  id: string;
  api: string;
  startUtc: string;
  endUtc: string;
  start: string;
  end: string;
  utcOffset: number;
  note: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  wrapsMidnightUtc?: boolean;
}

export interface PeakHourInput {
  api: string;
  start: string;
  end: string;
  utcOffset: number;
  note?: string;
  enabled?: boolean;
}

export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

export const OFFSET_OPTIONS: Array<{ value: number; label: string }> = (() => {
  const out: Array<{ value: number; label: string }> = [];
  for (let m = -12 * 60; m <= 14 * 60; m += 15) out.push({ value: m, label: offsetLabel(m) });
  return out;
})();

export function browserUtcOffset(): number {
  return Math.round(-new Date().getTimezoneOffset() / 15) * 15;
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
