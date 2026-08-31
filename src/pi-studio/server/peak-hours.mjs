import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_API_LEN = 64;
const MAX_NOTE_LEN = 200;
const OFFSET_ABS_MAX = 14 * 60;
const NOT_FOUND = 'peak-hours entry not found';

export function parseHm(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fmtHm(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function toUtcMinutes(localMins, offset) {
  return (((localMins - offset) % 1440) + 1440) % 1440;
}

export function toLocalMinutes(utcMins, offset) {
  return (((utcMins + offset) % 1440) + 1440) % 1440;
}

export function utcMinutesAt(at) {
  const d = new Date(at);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function windowIsPeakAt(startUtc, endUtc, at) {
  const mins = utcMinutesAt(at);
  return startUtc <= endUtc ? mins >= startUtc && mins < endUtc : mins >= startUtc || mins < endUtc;
}

export function isPeakAt(entries, api, at) {
  const name = String(api ?? '').toLowerCase();
  return entries.some(
    (e) => e.api.toLowerCase() === name && e.enabled && windowIsPeakAt(e.startUtc, e.endUtc, at),
  );
}

function validStoredEntry(e) {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.api === 'string' &&
    e.api.trim().length > 0 &&
    Number.isInteger(e.startUtc) &&
    e.startUtc >= 0 &&
    e.startUtc < 1440 &&
    Number.isInteger(e.endUtc) &&
    e.endUtc >= 0 &&
    e.endUtc < 1440 &&
    e.startUtc !== e.endUtc &&
    Number.isInteger(e.utcOffset) &&
    Math.abs(e.utcOffset) <= OFFSET_ABS_MAX &&
    typeof e.enabled === 'boolean' &&
    Number.isFinite(e.createdAt) &&
    Number.isFinite(e.updatedAt)
  );
}

function normApi(value, fallback) {
  const v = fallback === undefined ? value : (value ?? fallback);
  if (typeof v !== 'string') return { error: 'api must be a string' };
  const api = v.trim();
  if (!api) return { error: 'api is required' };
  if (api.length > MAX_API_LEN) return { error: `api must be at most ${MAX_API_LEN} chars` };
  return { api };
}

function normOffset(value, fallback) {
  const v = fallback === undefined ? value : (value ?? fallback);
  if (!Number.isInteger(v)) return { error: 'utcOffset must be an integer minute offset' };
  if (Math.abs(v) > OFFSET_ABS_MAX) {
    return { error: `utcOffset must be within ±${OFFSET_ABS_MAX} minutes` };
  }
  return { offset: v };
}

function normNote(value, fallback) {
  const v = fallback === undefined ? value : (value ?? fallback ?? '');
  if (typeof v !== 'string') return { error: 'note must be a string' };
  const note = v.trim();
  if (note.length > MAX_NOTE_LEN) return { error: `note must be at most ${MAX_NOTE_LEN} chars` };
  return { note };
}

function normEnabled(value, fallback) {
  const v = fallback === undefined ? value : (value ?? fallback);
  if (typeof v !== 'boolean') return { error: 'enabled must be a boolean' };
  return { enabled: v };
}

function view(e) {
  return {
    id: e.id,
    api: e.api,
    startUtc: fmtHm(e.startUtc),
    endUtc: fmtHm(e.endUtc),
    start: fmtHm(toLocalMinutes(e.startUtc, e.utcOffset)),
    end: fmtHm(toLocalMinutes(e.endUtc, e.utcOffset)),
    utcOffset: e.utcOffset,
    note: e.note,
    enabled: e.enabled,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    wrapsMidnightUtc: e.endUtc < e.startUtc,
  };
}

export function createPeakHoursStore({
  persistPath,
  now = () => Date.now(),
  idOf = () => randomUUID().slice(0, 8),
} = {}) {
  if (!persistPath) throw new Error('createPeakHoursStore requires persistPath');
  const entries = new Map();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = JSON.parse(readFileSync(persistPath, 'utf8'));
    } catch {
      return;
    }
    if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.entries)) return;
    for (const e of raw.entries) {
      if (!validStoredEntry(e)) continue;
      if (typeof e.note !== 'string') continue;
      entries.set(e.id, {
        id: e.id,
        api: e.api,
        startUtc: e.startUtc,
        endUtc: e.endUtc,
        utcOffset: e.utcOffset,
        note: e.note,
        enabled: e.enabled,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      });
    }
  }

  function persist() {
    const list = [...entries.values()].sort((a, b) => {
      const byApi = a.api.localeCompare(b.api);
      if (byApi !== 0) return byApi;
      if (a.startUtc !== b.startUtc) return a.startUtc - b.startUtc;
      return a.id.localeCompare(b.id);
    });
    const shape = { version: STORE_VERSION, entries: list };
    mkdirSync(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(shape, null, 2)}\n`);
    renameSync(tmp, persistPath);
  }

  function duplicateOf(entry, ownId) {
    for (const e of entries.values()) {
      if (e.id === ownId) continue;
      if (e.api === entry.api && e.startUtc === entry.startUtc && e.endUtc === entry.endUtc) return true;
    }
    return false;
  }

  function create(input) {
    ensureLoaded();
    if (!input || typeof input !== 'object') return { error: 'invalid body' };
    const apiR = normApi(input.api);
    if (apiR.error) return { error: apiR.error };
    const offsetR = normOffset(input.utcOffset, 0);
    if (offsetR.error) return { error: offsetR.error };
    const noteR = normNote(input.note, '');
    if (noteR.error) return { error: noteR.error };
    const enabledR = normEnabled(input.enabled, true);
    if (enabledR.error) return { error: enabledR.error };
    const startLocal = parseHm(input.start);
    if (startLocal === null) return { error: 'start must be HH:MM (00:00–23:59)' };
    const endLocal = parseHm(input.end);
    if (endLocal === null) return { error: 'end must be HH:MM (00:00–23:59)' };
    const startUtc = toUtcMinutes(startLocal, offsetR.offset);
    const endUtc = toUtcMinutes(endLocal, offsetR.offset);
    if (startUtc === endUtc) return { error: 'start and end must differ' };
    if (entries.size >= MAX_ENTRIES) return { error: `too many entries (max ${MAX_ENTRIES})` };
    const t = now();
    const entry = {
      id: idOf(),
      api: apiR.api,
      startUtc,
      endUtc,
      utcOffset: offsetR.offset,
      note: noteR.note,
      enabled: enabledR.enabled,
      createdAt: t,
      updatedAt: t,
    };
    if (duplicateOf(entry, null)) return { error: `an identical window already exists for ${entry.api}` };
    entries.set(entry.id, entry);
    try {
      persist();
    } catch (e) {
      entries.delete(entry.id);
      return { error: `failed to persist: ${e?.message ?? e}` };
    }
    return { entry: view(entry) };
  }

  function update(id, patch) {
    ensureLoaded();
    const existing = entries.get(id);
    if (!existing) return { error: NOT_FOUND };
    if (!patch || typeof patch !== 'object') return { error: 'invalid body' };
    const apiR = normApi(patch.api, existing.api);
    if (apiR.error) return { error: apiR.error };
    const offsetR = normOffset(patch.utcOffset, existing.utcOffset);
    if (offsetR.error) return { error: offsetR.error };
    const noteR = normNote(patch.note, existing.note);
    if (noteR.error) return { error: noteR.error };
    const enabledR = normEnabled(patch.enabled, existing.enabled);
    if (enabledR.error) return { error: enabledR.error };
    const startLocal =
      patch.start === undefined ? toLocalMinutes(existing.startUtc, offsetR.offset) : parseHm(patch.start);
    if (startLocal === null) return { error: 'start must be HH:MM (00:00–23:59)' };
    const endLocal =
      patch.end === undefined ? toLocalMinutes(existing.endUtc, offsetR.offset) : parseHm(patch.end);
    if (endLocal === null) return { error: 'end must be HH:MM (00:00–23:59)' };
    const startUtc = toUtcMinutes(startLocal, offsetR.offset);
    const endUtc = toUtcMinutes(endLocal, offsetR.offset);
    if (startUtc === endUtc) return { error: 'start and end must differ' };
    const entry = {
      ...existing,
      api: apiR.api,
      startUtc,
      endUtc,
      utcOffset: offsetR.offset,
      note: noteR.note,
      enabled: enabledR.enabled,
      updatedAt: now(),
    };
    if (duplicateOf(entry, entry.id)) return { error: `an identical window already exists for ${entry.api}` };
    entries.set(entry.id, entry);
    try {
      persist();
    } catch (e) {
      entries.set(entry.id, existing);
      return { error: `failed to persist: ${e?.message ?? e}` };
    }
    return { entry: view(entry) };
  }

  function remove(id) {
    ensureLoaded();
    if (!entries.has(id)) return false;
    const backup = entries.get(id);
    entries.delete(id);
    try {
      persist();
    } catch (e) {
      entries.set(id, backup);
      throw e;
    }
    return true;
  }

  function list() {
    ensureLoaded();
    return [...entries.values()]
      .sort((a, b) => {
        const byApi = a.api.localeCompare(b.api);
        if (byApi !== 0) return byApi;
        if (a.startUtc !== b.startUtc) return a.startUtc - b.startUtc;
        return a.id.localeCompare(b.id);
      })
      .map(view);
  }

  return { create, update, remove, list, isPeakAt: (api, at) => isPeakAt([...entries.values()], api, at) };
}
