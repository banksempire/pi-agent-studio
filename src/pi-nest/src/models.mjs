import { NEW_CHAT_CWD, sdk, supportedThinkingLevels } from './sdk-bridge.mjs';

const CATALOG_TTL_MS = 30 * 1000;

export function serializeModel(m) {
  if (!m) return null;
  return {
    id: m.id,
    provider: m.provider,
    name: m.name,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow ?? 0,
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

async function catalogFor(cwd) {
  const key = cwd ?? NEW_CHAT_CWD;
  const hit = catalogs.get(key);
  if (hit && Date.now() - hit.at <= CATALOG_TTL_MS) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const data = await fetchCatalog(key);
    const entry = { at: Date.now(), ...data };
    catalogs.set(key, entry);
    return entry;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

export async function getModelsData(registry, file) {
  if (!file) {
    const cat = await catalogFor(NEW_CHAT_CWD);
    return {
      models: cat.models.map(serializeModel),
      default: serializeModel(cat.defaultModel),
      current: null,
      currentThinkingLevel: cat.defaultLevel,
    };
  }
  const pending = registry.pendingInfo(file);
  if (pending) {
    const cat = await catalogFor(pending.cwd);
    return {
      models: cat.models.map(serializeModel),
      default: serializeModel(cat.defaultModel),
      current: serializeModel(pending.model ?? cat.defaultModel),
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
