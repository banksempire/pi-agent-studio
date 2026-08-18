import { api } from './store/chat';

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  thinkingLevels: string[];
}

export interface ModelCatalog {
  models: ModelInfo[];
  current: ModelInfo | null;
  currentThinkingLevel: string | null;
}

const CACHE_TTL_MS = 10 * 60_000;

const cache = new Map<string, { at: number; data: ModelCatalog }>();
const inflight = new Map<string, Promise<ModelCatalog | null>>();

export async function getModelInfo(file: string, force = false): Promise<ModelCatalog | null> {
  const hit = cache.get(file);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const pending = inflight.get(file);
  if (pending) return pending;
  const p = (async () => {
    const j = await api<{ ok: boolean; data?: ModelCatalog; error?: string }>('/api/slash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, command: 'model' }),
    });
    if (!j.ok) throw new Error(j.error || 'Failed to load models');
    const data = j.data as ModelCatalog;
    cache.set(file, { at: Date.now(), data });
    return data;
  })();
  inflight.set(file, p);
  try {
    return await p;
  } finally {
    inflight.delete(file);
  }
}

export function setCachedModel(file: string, model: ModelInfo, thinkLevel: string): void {
  const hit = cache.get(file);
  if (hit) {
    hit.data.current = model;
    hit.data.currentThinkingLevel = thinkLevel;
    hit.at = Date.now();
  }
}

export function cachedModelMatches(file: string, statsModel: string | null): boolean {
  const c = cache.get(file)?.data.current;
  if (!c || !statsModel) return false;
  return statsModel === `${c.provider}/${c.id}` || statsModel === c.id || statsModel === c.name;
}
