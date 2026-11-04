import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const MAX_NAME_LEN = 200;
const NOT_FOUND = 'workspace not found';

function validSnapshot(s) {
  return (
    typeof s === 'object' && s !== null && !Array.isArray(s) && s.version === 1 && Array.isArray(s.roots)
  );
}

function summaryOf(snapshot) {
  let tiles = 0;
  let tabs = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'tile') {
      tiles += 1;
      tabs += Array.isArray(node.tabs) ? node.tabs.length : 0;
      return;
    }
    walk(node.children?.[0]);
    walk(node.children?.[1]);
  };
  for (const root of snapshot.roots ?? []) walk(root.node);
  let windows = 0;
  for (const aux of snapshot.auxWindows ?? []) {
    windows += 1;
    for (const root of aux.roots ?? []) walk(root.node);
  }
  return { tiles, tabs, windows };
}

function metaOf(entry) {
  const { snapshot, ...rest } = entry;
  return { ...rest, ...summaryOf(snapshot) };
}

export function createWorkspaceStore({
  persistPath,
  now = () => Date.now(),
  idOf = () => randomUUID().slice(0, 8),
} = {}) {
  if (!persistPath) throw new Error('createWorkspaceStore requires persistPath');
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
    if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.workspaces)) return;
    for (const e of raw.workspaces) {
      if (
        !e ||
        typeof e.id !== 'string' ||
        typeof e.name !== 'string' ||
        typeof e.savedAt !== 'number' ||
        !validSnapshot(e.snapshot)
      ) {
        continue;
      }
      entries.set(e.id, { id: e.id, name: e.name, savedAt: e.savedAt, snapshot: e.snapshot });
    }
  }

  function persist() {
    const sorted = [...entries.values()].sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : 1));
    const shape = { version: STORE_VERSION, workspaces: sorted };
    mkdirSync(path.dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(shape, null, 2)}\n`);
    renameSync(tmp, persistPath);
  }

  function validName(name) {
    return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= MAX_NAME_LEN;
  }

  return {
    list() {
      ensureLoaded();
      return [...entries.values()]
        .sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : 1))
        .map(metaOf);
    },
    get(id) {
      ensureLoaded();
      const e = entries.get(id);
      return e ? { ...metaOf(e), snapshot: e.snapshot } : null;
    },
    create({ name, snapshot }) {
      if (!validName(name)) return { error: 'invalid workspace name' };
      if (!validSnapshot(snapshot)) return { error: 'invalid workspace snapshot' };
      ensureLoaded();
      const entry = { id: idOf(), name: name.trim(), savedAt: now(), snapshot };
      entries.set(entry.id, entry);
      try {
        persist();
      } catch (e) {
        entries.delete(entry.id);
        throw e;
      }
      return { entry: metaOf(entry) };
    },
    update(id, patch = {}) {
      ensureLoaded();
      const prev = entries.get(id);
      if (!prev) return { error: NOT_FOUND };
      const next = { ...prev };
      if (patch.name !== undefined) {
        if (!validName(patch.name)) return { error: 'invalid workspace name' };
        next.name = patch.name.trim();
      }
      if (patch.snapshot !== undefined) {
        if (!validSnapshot(patch.snapshot)) return { error: 'invalid workspace snapshot' };
        next.snapshot = patch.snapshot;
        next.savedAt = now();
      }
      entries.set(id, next);
      try {
        persist();
      } catch (e) {
        entries.set(id, prev);
        throw e;
      }
      return { entry: metaOf(next) };
    },
    remove(id) {
      ensureLoaded();
      const prev = entries.get(id);
      if (!prev) return false;
      entries.delete(id);
      try {
        persist();
      } catch (e) {
        entries.set(id, prev);
        throw e;
      }
      return true;
    },
  };
}
