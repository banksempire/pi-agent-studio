import type { MenuNodeDef } from '@sf/types/layout';
import { api } from './store/chat';

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  cost?: ModelCost;
  thinkingLevels: string[];
  api?: string | null;
  baseUrl?: string | null;
  input?: string[];
  maxTokens?: number;
}

export interface ModelCatalogView {
  models: ModelInfo[];
  default: ModelInfo | null;
  current: ModelInfo | null;
  currentThinkingLevel: string | null;
}

export const LEVEL_DESCRIPTIONS: Record<string, string> = {
  off: 'No reasoning',
  minimal: 'Very brief reasoning (~1k tokens)',
  low: 'Light reasoning (~2k tokens)',
  medium: 'Moderate reasoning (~8k tokens)',
  high: 'Deep reasoning (~16k tokens)',
  xhigh: 'Extra-high reasoning (~32k tokens)',
  max: 'Maximum reasoning',
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const SESSION_CACHE_MAX = 32;

const globalCache: { at: number; data: ModelCatalogView | null } = { at: 0, data: null };
let globalInflight: Promise<ModelCatalogView> | null = null;

const sessionCache = new Map<string, { at: number; data: ModelCatalogView }>();
const sessionInflight = new Map<string, Promise<ModelCatalogView>>();

export async function loadModelCatalog(force = false): Promise<ModelCatalogView> {
  if (!force && globalCache.data && Date.now() - globalCache.at < CACHE_TTL_MS) {
    return globalCache.data;
  }
  if (globalInflight) return globalInflight;
  const p = (async () => {
    const data = await api<ModelCatalogView>('/api/models');
    globalCache.data = data;
    globalCache.at = Date.now();
    return data;
  })();
  globalInflight = p;
  try {
    return await p;
  } finally {
    globalInflight = null;
  }
}

export async function loadSessionModels(file: string, force = false): Promise<ModelCatalogView> {
  const hit = sessionCache.get(file);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const pending = sessionInflight.get(file);
  if (pending) return pending;
  const p = (async () => {
    const data = await api<ModelCatalogView>(`/api/models?file=${encodeURIComponent(file)}`);
    const entry = { at: Date.now(), data };
    sessionCache.set(file, entry);
    if (sessionCache.size > SESSION_CACHE_MAX) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, e] of sessionCache) {
        if (e.at < oldestAt) {
          oldestAt = e.at;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) sessionCache.delete(oldestKey);
    }
    return data;
  })();
  sessionInflight.set(file, p);
  try {
    return await p;
  } finally {
    sessionInflight.delete(file);
  }
}

export async function refreshModelCatalog(): Promise<ModelCatalogView & { errors: string[] }> {
  const data = await api<ModelCatalogView & { errors?: string[] }>('/api/models/refresh', {
    method: 'POST',
  });
  const normalized = { ...data, errors: data.errors ?? [] };
  globalCache.data = normalized;
  globalCache.at = Date.now();
  sessionCache.clear();
  return normalized;
}

export async function setDefaultModel(model: string): Promise<ModelCatalogView & { errors: string[] }> {
  const data = await api<ModelCatalogView & { errors?: string[] }>('/api/models/default', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const normalized = { ...data, errors: data.errors ?? [] };
  globalCache.data = normalized;
  globalCache.at = Date.now();
  return normalized;
}

export async function setSessionModel(file: string, model: string, thinkLevel: string): Promise<string> {
  const j = await api<{ ok: boolean; notice?: string; error?: string }>('/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, model, thinkLevel }),
  });
  if (!j.ok) throw new Error(j.error || 'Failed to apply model');
  return j.notice ?? '';
}

export function setCachedModel(file: string, model: ModelInfo, thinkLevel: string): void {
  const hit = sessionCache.get(file);
  if (hit) {
    hit.data.current = model;
    hit.data.currentThinkingLevel = thinkLevel;
    hit.at = Date.now();
  }
}

export function cachedModelMatches(file: string, statsModel: string | null): boolean {
  const c = sessionCache.get(file)?.data.current;
  if (!c || !statsModel) return false;
  return statsModel === `${c.provider}/${c.id}` || statsModel === c.id || statsModel === c.name;
}

export function modelMenuItems(models: ModelInfo[]): MenuNodeDef[] {
  const providers: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!seen.has(m.provider)) {
      seen.add(m.provider);
      providers.push(m.provider);
    }
  }
  return providers.map((p) => ({
    id: p,
    label: p,
    items: models
      .filter((m) => m.provider === p)
      .map((m) => ({
        id: m.id,
        label: m.name || m.id,
        detail: m.reasoning ? 'thinking' : 'plain',
        items: m.thinkingLevels.map((l) => ({
          id: l,
          label: l === 'off' ? '(None)' : l,
          detail: LEVEL_DESCRIPTIONS[l] ?? '',
          data: { model: m, level: l },
        })),
      })),
  }));
}
