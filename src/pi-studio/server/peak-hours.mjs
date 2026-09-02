import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const MAX_ENTRIES = 400;
const MAX_PROVIDER_LEN = 64;
const MAX_MODEL_LEN = 128;
const MAX_NOTE_LEN = 200;
const OFFSET_ABS_MAX = 12 * 60;
const NOT_FOUND = 'peak-hours entry not found';
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

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

export function localDayOfWeekAt(at, offset) {
  const d = new Date(at);
  const carry = Math.floor((utcMinutesAt(at) + (offset ?? 0)) / 1440);
  return (d.getUTCDay() + carry + 7) % 7;
}

export function windowIsPeakAt(startUtc, endUtc, at) {
  const mins = utcMinutesAt(at);
  return startUtc <= endUtc ? mins >= startUtc && mins < endUtc : mins >= startUtc || mins < endUtc;
}

export function modelKeyOf(provider, model) {
  return `${String(provider ?? '')}/${String(model ?? '')}`;
}

export function isPeakAt(entries, provider, model, at) {
  const want = modelKeyOf(provider, model).toLowerCase();
  return entries.some(
    (e) =>
      modelKeyOf(e.provider, e.model).toLowerCase() === want &&
      e.enabled &&
      (e.weekdays ?? ALL_WEEKDAYS).includes(localDayOfWeekAt(at, e.utcOffset)) &&
      windowIsPeakAt(e.startUtc, e.endUtc, at),
  );
}

function validStoredEntry(e) {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.provider === 'string' &&
    e.provider.trim().length > 0 &&
    typeof e.model === 'string' &&
    e.model.trim().length > 0 &&
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
    Number.isFinite(e.updatedAt) &&
    validWeekdays(e.weekdays)
  );
}

function validWeekdays(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

function normWeekdays(value, fallback) {
  if (value === undefined) return { weekdays: [...fallback] };
  if (!validWeekdays(value)) {
    return { error: 'weekdays must be an array of day numbers 0–6 (at least one)' };
  }
  return { weekdays: [...new Set(value)].sort((a, b) => a - b) };
}

function normToken(name, value, fallback, maxLen) {
  const v = fallback === undefined ? value : (value ?? fallback);
  if (typeof v !== 'string') return { error: `${name} must be a string` };
  const out = v.trim();
  if (!out) return { error: `${name} is required` };
  if (out.length > maxLen) return { error: `${name} must be at most ${maxLen} chars` };
  if (out.includes('/')) return { error: `${name} must not contain "/"` };
  return { value: out };
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
    provider: e.provider,
    model: e.model,
    key: modelKeyOf(e.provider, e.model),
    startUtc: fmtHm(e.startUtc),
    endUtc: fmtHm(e.endUtc),
    start: fmtHm(toLocalMinutes(e.startUtc, e.utcOffset)),
    end: fmtHm(toLocalMinutes(e.endUtc, e.utcOffset)),
    utcOffset: e.utcOffset,
    weekdays: e.weekdays ?? ALL_WEEKDAYS,
    note: e.note,
    enabled: e.enabled,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    wrapsMidnightUtc: e.endUtc < e.startUtc,
  };
}

function sortEntries(list) {
  return list.sort((a, b) => {
    const byKey = modelKeyOf(a.provider, a.model).localeCompare(modelKeyOf(b.provider, b.model));
    if (byKey !== 0) return byKey;
    if (a.startUtc !== b.startUtc) return a.startUtc - b.startUtc;
    return a.id.localeCompare(b.id);
  });
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
        provider: e.provider,
        model: e.model,
        startUtc: e.startUtc,
        endUtc: e.endUtc,
        utcOffset: e.utcOffset,
        weekdays: e.weekdays ? [...new Set(e.weekdays)].sort((a, b) => a - b) : [...ALL_WEEKDAYS],
        note: e.note,
        enabled: e.enabled,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      });
    }
  }

  function persist() {
    const shape = { version: STORE_VERSION, entries: sortEntries([...entries.values()]) };
    mkdirSync(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(shape, null, 2)}\n`);
    renameSync(tmp, persistPath);
  }

  function duplicateOf(entry, ownId) {
    for (const e of entries.values()) {
      if (e.id === ownId) continue;
      if (
        e.provider === entry.provider &&
        e.model === entry.model &&
        e.startUtc === entry.startUtc &&
        e.endUtc === entry.endUtc &&
        (e.weekdays ?? ALL_WEEKDAYS).join() === entry.weekdays.join()
      ) {
        return true;
      }
    }
    return false;
  }

  function create(input) {
    ensureLoaded();
    if (!input || typeof input !== 'object') return { error: 'invalid body' };
    const providerR = normToken('provider', input.provider, undefined, MAX_PROVIDER_LEN);
    if (providerR.error) return { error: providerR.error };
    const modelR = normToken('model', input.model, undefined, MAX_MODEL_LEN);
    if (modelR.error) return { error: modelR.error };
    const offsetR = normOffset(input.utcOffset, 0);
    if (offsetR.error) return { error: offsetR.error };
    const noteR = normNote(input.note, '');
    if (noteR.error) return { error: noteR.error };
    const enabledR = normEnabled(input.enabled, true);
    if (enabledR.error) return { error: enabledR.error };
    const weekdaysR = normWeekdays(input.weekdays, ALL_WEEKDAYS);
    if (weekdaysR.error) return { error: weekdaysR.error };
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
      provider: providerR.value,
      model: modelR.value,
      startUtc,
      endUtc,
      utcOffset: offsetR.offset,
      weekdays: weekdaysR.weekdays,
      note: noteR.note,
      enabled: enabledR.enabled,
      createdAt: t,
      updatedAt: t,
    };
    if (duplicateOf(entry, null)) {
      return { error: `an identical window already exists for ${entry.provider}/${entry.model}` };
    }
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
    const providerR = normToken('provider', patch.provider, existing.provider, MAX_PROVIDER_LEN);
    if (providerR.error) return { error: providerR.error };
    const modelR = normToken('model', patch.model, existing.model, MAX_MODEL_LEN);
    if (modelR.error) return { error: modelR.error };
    const offsetR = normOffset(patch.utcOffset, existing.utcOffset);
    if (offsetR.error) return { error: offsetR.error };
    const noteR = normNote(patch.note, existing.note);
    if (noteR.error) return { error: noteR.error };
    const enabledR = normEnabled(patch.enabled, existing.enabled);
    if (enabledR.error) return { error: enabledR.error };
    const weekdaysR = normWeekdays(patch.weekdays, existing.weekdays ?? ALL_WEEKDAYS);
    if (weekdaysR.error) return { error: weekdaysR.error };
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
      provider: providerR.value,
      model: modelR.value,
      startUtc,
      endUtc,
      utcOffset: offsetR.offset,
      weekdays: weekdaysR.weekdays,
      note: noteR.note,
      enabled: enabledR.enabled,
      updatedAt: now(),
    };
    if (duplicateOf(entry, entry.id)) {
      return { error: `an identical window already exists for ${entry.provider}/${entry.model}` };
    }
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
    return sortEntries([...entries.values()]).map(view);
  }

  return {
    create,
    update,
    remove,
    list,
    isPeakAt: (provider, model, at) => isPeakAt([...entries.values()], provider, model, at),
  };
}
