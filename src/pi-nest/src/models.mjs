import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NEW_CHAT_CWD,
  SESSIONS_ROOT,
  sdk,
  settingsManagerMod,
  settingsSdk,
  supportedThinkingLevels,
} from './sdk-bridge.mjs';

const CATALOG_TTL_MS = 30 * 1000;
const CATALOG_MAX_ENTRIES = 8;
const REFRESH_TIMEOUT_MS = 15 * 1000;
const VALID_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LATEST_CHAT_SCAN_FILES = 8;
const LATEST_CHAT_TAIL_BYTES = 64 * 1024;

export function serializeModel(m) {
  if (!m) return null;
  return {
    id: m.id,
    provider: m.provider,
    name: m.name,
    api: m.api ?? null,
    baseUrl: m.baseUrl ?? null,
    reasoning: !!m.reasoning,
    input: Array.isArray(m.input) ? m.input : [],
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    cost: m.cost
      ? {
          input: m.cost.input ?? 0,
          output: m.cost.output ?? 0,
          cacheRead: m.cost.cacheRead ?? 0,
          cacheWrite: m.cost.cacheWrite ?? 0,
        }
      : undefined,
    thinkingLevels: supportedThinkingLevels(m),
  };
}

export function findModel(models, term) {
  const t = String(term ?? '').toLowerCase();
  return models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === t);
}

const catalogs = new Map();
const inflight = new Map();

function evictCatalogs() {
  while (catalogs.size > CATALOG_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of catalogs) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    catalogs.delete(oldestKey);
  }
}

async function fetchCatalog(cwd) {
  const sm = sdk.SessionManager.inMemory(cwd);
  const { session } = await sdk.createAgentSession({ sessionManager: sm });
  try {
    const models = await session.modelRuntime.getAvailable().catch(() => []);
    return {
      models,
      defaultModel: session.model,
      defaultLevel: session.thinkingLevel ?? null,
    };
  } finally {
    try {
      session.dispose();
    } catch {}
  }
}

function catalogEntryOf(data) {
  return {
    at: Date.now(),
    ...data,
    serialized: data.models.map(serializeModel),
    serializedDefault: serializeModel(data.defaultModel),
  };
}

async function catalogFor(cwd) {
  const key = cwd ?? NEW_CHAT_CWD;
  const hit = catalogs.get(key);
  if (hit && Date.now() - hit.at <= CATALOG_TTL_MS) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const data = await fetchCatalog(key);
    const entry = catalogEntryOf(data);
    catalogs.set(key, entry);
    evictCatalogs();
    return entry;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

function agentSettings() {
  try {
    const Ctor = settingsSdk?.SettingsManager;
    if (!Ctor?.create) return null;
    const sm = Ctor.create(NEW_CHAT_CWD);
    return sm && typeof sm.getDefaultModel === 'function' ? sm : null;
  } catch {
    return null;
  }
}

export function explicitDefault() {
  const sm = agentSettings();
  if (!sm) return null;
  try {
    const provider = sm.getDefaultProvider();
    const model = sm.getDefaultModel();
    if (!provider || !model) return null;
    let level = null;
    try {
      level = sm.getDefaultThinkingLevel() ?? null;
    } catch {}
    return { provider: String(provider), model: String(model), level };
  } catch {
    return null;
  }
}

function listSessionFiles(root) {
  const out = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) out.push(path.join(dir, name));
    }
  }
  out.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return out;
}

export function latestChatModel() {
  try {
    for (const file of listSessionFiles(SESSIONS_ROOT).slice(0, LATEST_CHAT_SCAN_FILES)) {
      const hit = lastAssistantModelIn(file);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

function lastAssistantModelIn(file) {
  let fd = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - LATEST_CHAT_TAIL_BYTES);
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let hit = null;
    for (const line of buf.toString('utf8').split('\n')) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const m = e?.type === 'message' ? e.message : null;
      if (m?.role === 'assistant' && m.provider && m.model) {
        hit = { provider: String(m.provider), model: String(m.model) };
      }
    }
    return hit;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function effectiveDefault(cat) {
  const explicit = explicitDefault();
  let model = cat.defaultModel ?? null;
  let source = 'fallback';
  if (explicit) {
    const hit =
      findModel(cat.models, `${explicit.provider}/${explicit.model}`) ??
      findModel(cat.models, explicit.model);
    if (hit) {
      model = hit;
      source = 'settings';
    }
  }
  if (source !== 'settings') {
    const latest = latestChatModel();
    if (latest) {
      const hit = findModel(cat.models, `${latest.provider}/${latest.model}`);
      if (hit) {
        model = hit;
        source = 'latest-chat';
      }
    }
  }
  return { model, source, level: explicit?.level ?? null };
}

function defaultView(cat) {
  const eff = effectiveDefault(cat);
  return {
    default: serializeModel(eff.model) ?? cat.serializedDefault ?? null,
    defaultSource: eff.source,
    defaultThinkingLevel: eff.level,
  };
}

export async function applyImplicitNewChatDefault(registry, file) {
  try {
    const p = registry.pendingInfo(file);
    if (!p || p.model) return;
    if (explicitDefault()) return;
    const latest = latestChatModel();
    if (!latest) return;
    const cat = await catalogFor(p.cwd);
    const hit = findModel(cat.models, `${latest.provider}/${latest.model}`);
    if (hit) registry.setPendingModel(file, hit, null);
  } catch {}
}

export async function getModelsData(registry, file) {
  if (!file) {
    const cat = await catalogFor(NEW_CHAT_CWD);
    return {
      models: cat.serialized,
      ...defaultView(cat),
      current: null,
      currentThinkingLevel: cat.defaultLevel,
    };
  }
  const pending = registry.pendingInfo(file);
  if (pending) {
    const cat = await catalogFor(pending.cwd);
    return {
      models: cat.serialized,
      ...defaultView(cat),
      current: serializeModel(pending.model) ?? cat.serializedDefault,
      currentThinkingLevel: pending.thinkLevel ?? cat.defaultLevel,
    };
  }
  const live = await registry.open(file);
  const models = await live.session.modelRuntime.getAvailable().catch(() => []);
  return {
    models: models.map(serializeModel),
    default: null,
    current: serializeModel(live.session.model),
    currentThinkingLevel: live.session.thinkingLevel ?? null,
  };
}

export async function refreshCatalog() {
  const sm = sdk.SessionManager.inMemory(NEW_CHAT_CWD);
  const { session } = await sdk.createAgentSession({ sessionManager: sm });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let result;
    try {
      result = await session.modelRuntime.refresh({ force: true, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const errors = [...(result?.errors?.keys() ?? [])];
    const entry = catalogEntryOf({
      models: session.modelRuntime.getAvailableSnapshot(),
      defaultModel: session.model,
      defaultLevel: session.thinkingLevel ?? null,
    });
    catalogs.clear();
    catalogs.set(NEW_CHAT_CWD, entry);
    return {
      errors,
      models: entry.serialized,
      ...defaultView(entry),
      current: null,
      currentThinkingLevel: entry.defaultLevel,
    };
  } finally {
    try {
      session.dispose();
    } catch {}
  }
}

export async function setDefaultModel({ model, thinkLevel }) {
  const level =
    thinkLevel === undefined || thinkLevel === null || thinkLevel === '' ? null : String(thinkLevel);
  if (level && !VALID_LEVELS.includes(level)) throw new Error(`Unknown thinking level "${level}"`);
  if (model === null || model === undefined || model === '') {
    clearExplicitDefault();
  } else {
    const t = String(model).toLowerCase();
    if (!t.includes('/')) throw new Error('Pass the model as provider/id');
    const sep = t.indexOf('/');
    const provider = t.slice(0, sep);
    const modelId = t.slice(sep + 1);
    if (!provider || !modelId) throw new Error('Pass the model as provider/id');
    const sm = agentSettings();
    if (!sm) throw new Error('Settings unavailable');
    sm.setDefaultModelAndProvider(provider, modelId);
    if (level) {
      try {
        sm.setDefaultThinkingLevel(level);
      } catch {
        throw new Error(`Unknown thinking level "${level}"`);
      }
    }
    await sm.flush();
    const errs = sm.drainErrors();
    if (errs.length) throw new Error(errs.map((e) => e?.message ?? String(e)).join('; '));
  }
  catalogs.delete(NEW_CHAT_CWD);
  const entry = await catalogFor(NEW_CHAT_CWD);
  return {
    errors: [],
    models: entry.serialized,
    ...defaultView(entry),
    current: null,
    currentThinkingLevel: entry.defaultLevel,
  };
}

function clearExplicitDefault() {
  const Mod = settingsManagerMod;
  const Storage = Mod?.FileSettingsStorage;
  if (!Storage) throw new Error('Settings unavailable');
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  const storage = new Storage(NEW_CHAT_CWD, agentDir);
  storage.withLock('global', (current) => {
    let s;
    try {
      s = JSON.parse(current || '{}');
    } catch {
      s = {};
    }
    let changed = false;
    for (const key of ['defaultModel', 'defaultProvider']) {
      if (key in s) {
        delete s[key];
        changed = true;
      }
    }
    return changed ? `${JSON.stringify(s, null, 2)}\n` : undefined;
  });
}

export async function setSessionModel(registry, { file, model, thinkLevel }) {
  if (!file) throw new Error('setModel requires a session file');
  const level = thinkLevel || null;

  const pending = registry.pendingInfo(file);
  if (pending) {
    const cat = await catalogFor(pending.cwd);
    if (model) {
      const hit = findModel(cat.models, model);
      if (!hit) throw new Error(`No model matches "${model}"`);
      const wanted = level ?? pending.thinkLevel;
      const levels = supportedThinkingLevels(hit);
      if (wanted && !levels.includes(wanted)) {
        throw new Error(
          `"${wanted}" is not a supported thinking level for ${hit.provider}/${hit.id} (offers: ${levels.join(', ')}).`,
        );
      }
      registry.setPendingModel(file, hit, wanted);
      registry.broadcast('refresh', file, {});
      return `Model: ${hit.provider}/${hit.id}${wanted ? ` · Thinking: ${wanted}` : ''} (applies when the chat starts)`;
    }
    const current = pending.model ?? cat.defaultModel;
    if (!current) throw new Error('No model is set for this chat yet — pick a model first.');
    if (level) {
      const levels = supportedThinkingLevels(current);
      if (!levels.includes(level)) {
        throw new Error(
          `"${level}" is not a supported thinking level for ${current.provider}/${current.id} (offers: ${levels.join(', ')}).`,
        );
      }
      registry.setPendingModel(file, current, level);
      registry.broadcast('refresh', file, {});
      return `Thinking: ${level} (applies when the chat starts)`;
    }
    throw new Error('Nothing to set — pass a model or a thinking level.');
  }

  const live = await registry.open(file);
  const current = live.session.model;
  let target = current;
  if (model) {
    const models = await live.session.modelRuntime.getAvailable().catch(() => []);
    const hit = findModel(models, model);
    if (!hit) throw new Error(`No model matches "${model}"`);
    await live.session.setModel(hit);
    target = hit;
    registry.broadcast('refresh', file, {});
  }
  if (!target) throw new Error('No model is set for this chat yet — pick a model first.');
  if (level) {
    const levels = supportedThinkingLevels(target);
    if (!levels.includes(level)) {
      throw new Error(
        `"${level}" is not a supported thinking level for ${target.provider}/${target.id} (offers: ${levels.join(', ')}).`,
      );
    }
    live.session.setThinkingLevel(level);
    registry.broadcast('refresh', file, {});
  }
  if (!model && !level) throw new Error('Nothing to set — pass a model or a thinking level.');
  const bits = [];
  if (model) bits.push(`Model: ${target.provider}/${target.id}`);
  if (level) bits.push(`Thinking: ${level}`);
  return bits.join(' · ');
}
