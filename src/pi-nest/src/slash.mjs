/**
 * Slash command execution. Ported from the old app backend: every command
 * that touches a live agent runs HERE (pi-nest owns the agents), so a
 * front-end restart can't orphan an in-flight /compact, /fork, /reload, ...
 *
 * Returns { ok, notice?, error?, data? } with data always JSON-serializable
 * (the gRPC layer stringifies it as data_json).
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILTIN_SLASH_COMMANDS,
  NEW_CHAT_CWD,
  SESSIONS_ROOT,
  sdk,
  sdkDir,
  supportedThinkingLevels,
} from './sdk-bridge.mjs';

/** Builtin commands that only make sense in the pi TUI — answered with a reason. */
const NA_COMMANDS = {
  settings: 'Settings are configured in the pi TUI (/settings there).',
  login: 'Provider authentication requires the pi TUI (opens OAuth in the terminal).',
  logout: 'Provider logout requires the pi TUI.',
  trust: 'Project trust decisions are made in the pi TUI.',
  share: 'Gist sharing requires GitHub auth in the pi TUI.',
  quit: 'Nothing to quit in a browser tab — close the tab instead.',
};

function serializeModel(m) {
  if (!m) return null;
  return {
    id: m.id,
    provider: m.provider,
    name: m.name,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow ?? 0,
    // Per-1M-token price list (cache-waste fallback in the gateway's
    // session-stats derivation needs the cacheRead rate).
    cost: m.cost
      ? {
          input: m.cost.input ?? 0,
          output: m.cost.output ?? 0,
          cacheRead: m.cost.cacheRead ?? 0,
          cacheWrite: m.cost.cacheWrite ?? 0,
        }
      : undefined,
    // Per-model thinking levels from the model configuration — a model that
    // doesn't support reasoning offers only ['off'] (the UI shows "(None)").
    thinkingLevels: supportedThinkingLevels(m),
  };
}

function treeToJson(nodes) {
  return (nodes ?? []).map((n) => ({
    id: n.entry?.id,
    type: n.entry?.type,
    label: n.label ?? n.entry?.id,
    children: treeToJson(n.children),
  }));
}

/** Create a new session file branched from `targetLeafId` and open it. */
async function forkSession(registry, live, targetLeafId) {
  const sm = live.session.sessionManager;
  const file = live.session.sessionFile;
  if (!file || !existsSync(file)) {
    throw new Error('This session has not been saved yet — send a message first.');
  }
  const forkedPath = sm.createBranchedSession(targetLeafId);
  if (!forkedPath) throw new Error('Failed to create forked session');
  const { session } = await sdk.createAgentSession({ sessionManager: sdk.SessionManager.open(forkedPath) });
  registry.attach(forkedPath, session);
  return forkedPath;
}

/**
 * Read the model catalog through a throwaway in-memory session. Lazy new
 * chats must not be materialized by a catalog read (a real agent would burn
 * the virtual reservation), so the catalog + environment default come from
 * a temp session that is disposed right after. Same call shape as the real
 * materialization, so the models/current are exactly what the chat will get.
 */
async function catalogOf(cwd) {
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
    } catch {
      /* ignore */
    }
  }
}

// A throwaway SDK session is expensive (~100-500ms) and the catalog only
// changes with models.json/provider configs — cache briefly so repeated
// picker opens (mount, file flips, model changes) reuse the same read.
let catalogCache = null;
let catalogCachedAt = 0;
const CATALOG_TTL_MS = 30 * 1000;

async function pendingCatalog(pending) {
  if (!catalogCache || Date.now() - catalogCachedAt > CATALOG_TTL_MS) {
    catalogCache = await catalogOf(pending.cwd);
    catalogCachedAt = Date.now();
  }
  return {
    models: catalogCache.models,
    current: pending.model ?? catalogCache.defaultModel,
    currentLevel: pending.thinkLevel ?? catalogCache.defaultLevel,
  };
}

function findModel(models, term) {
  // Only the fully-qualified form is accepted — several providers ship the
  // same model ids (opencode vs opencode-go vs volcengine-plan …), so a
  // bare id or display name is ambiguous and must not silently pick one.
  const t = term.toLowerCase();
  return models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === t);
}

/**
 * Execute one slash command. `registry` is the AgentRegistry; `extra` is the
 * parsed extra_json from the request (entryId, modelIds, ...).
 */
export async function execSlash(registry, { agentId, command, args, extra = {} }) {
  const name = String(command ?? '')
    .replace(/^\/+/, '')
    .trim();
  if (!name) return { ok: false, error: 'empty slash command' };
  if (NA_COMMANDS[name]) return { ok: true, notice: NA_COMMANDS[name] };
  const file = agentId || undefined;

  switch (name) {
    case '_models': {
      // Internal (absent from the user-facing catalog): the model catalog
      // alone, no agent involvement — the gateway resolves model context
      // windows through this. Never materializes a session (catalog comes
      // from the same cached throwaway read as the lazy-chat picker).
      const { models, defaultModel } = await pendingCatalog({
        cwd: NEW_CHAT_CWD,
        model: null,
        thinkLevel: null,
      });
      return {
        ok: true,
        data: { models: models.map(serializeModel), default: serializeModel(defaultModel) },
      };
    }

    case 'new': {
      // Same as the ➕ New Chat flow: fresh session (frontend opens the window).
      const cwd = args?.trim() || NEW_CHAT_CWD;
      const { file: f } = registry.createSession(cwd);
      await registry.open(f); // materialize now (matches old behavior)
      return { ok: true, data: { file: f } };
    }

    case 'session': {
      const live = await registry.open(file);
      const stats = live.session.getSessionStats();
      const sm = live.session.sessionManager;
      // Sessions without usage entries report no token stats — guard like the
      // old backend (previously crashed with "reading 'input' of undefined").
      const t = stats.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const lines = [
        'Session Info',
        ...(sm.getSessionName() ? [`Name: ${sm.getSessionName()}`] : []),
        `File: ${stats.sessionFile ?? 'In-memory'}`,
        `ID: ${stats.sessionId}`,
        '',
        'Messages',
        `Total: ${stats.totalMessages}`,
        `User: ${stats.userMessages}`,
        `Assistant: ${stats.assistantMessages}`,
        `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
        '',
        'Tokens',
        `Input: ${(t.input + t.cacheRead + t.cacheWrite).toLocaleString()}`,
        `Output: ${t.output.toLocaleString()}`,
        `Cache: ${t.cacheRead.toLocaleString()} read, ${t.cacheWrite.toLocaleString()} written`,
        `Total: ${t.total.toLocaleString()}`,
        `Cost: $${(stats.cost ?? 0).toFixed(4)}`,
      ];
      const model = live.session.model;
      if (model) lines.push('', `Model: ${model.provider}/${model.id}`);
      lines.push('', 'The right panel shows live session stats at all times.');
      return { ok: true, data: { text: lines.join('\n') } };
    }

    case 'name': {
      const live = await registry.open(file);
      const requested = args?.trim() ?? '';
      if (!requested) {
        const current = live.session.sessionManager.getSessionName();
        return { ok: true, notice: current ? `Session name: ${current}` : 'Usage: /name <name>' };
      }
      live.session.setSessionName(requested);
      const normalized = live.session.sessionManager.getSessionName();
      registry.broadcast('refresh', file, {});
      return {
        ok: true,
        notice: normalized ? `Session name set: ${normalized}` : `Session name set: ${requested}`,
      };
    }

    case 'compact': {
      const live = await registry.open(file);
      if (live.status === 'running') {
        return { ok: false, error: 'Wait for the current response to finish before compacting.' };
      }
      try {
        await live.session.compact(args?.trim() || undefined);
        return { ok: true, notice: 'Compaction complete — the conversation was summarized.' };
      } catch (e) {
        // The SDK throws "Already compacted" when the last entry is already a
        // compaction. That's a fine outcome — the summary is in the chat, and
        // compaction_end was mapped to the done box, so the user can audit it.
        if (e instanceof Error && /already compacted/i.test(e.message)) {
          return {
            ok: true,
            notice: 'The conversation is already compacted — the latest summary is in the chat.',
          };
        }
        throw e;
      }
    }

    case 'copy': {
      const live = await registry.open(file);
      const text = live.session.getLastAssistantText();
      if (!text) return { ok: true, notice: 'No agent messages to copy yet.' };
      return { ok: true, data: { text } };
    }

    case 'model': {
      const requested = args?.trim() ?? '';
      const wantedLevel = extra?.thinkLevel ?? null;

      // A lazy new chat has no agent yet — changing its model must NOT
      // materialize it: the preference is stored on the reservation and
      // applied when the first message turns it real. The catalog/current
      // come from a throwaway in-memory session (same defaults the chat
      // would get), so the menu works exactly like on a real session.
      const pending = registry.pendingInfo(file);
      if (pending) {
        const { models, current, currentLevel } = await pendingCatalog(pending);
        if (requested) {
          const hit = findModel(models, requested);
          if (!hit) return { ok: false, error: `No model matches "${requested}"` };
          const level = wantedLevel ?? pending.thinkLevel;
          const levels = supportedThinkingLevels(hit);
          if (level && !levels.includes(level)) {
            return {
              ok: false,
              error: `"${level}" is not a supported thinking level for ${hit.provider}/${hit.id} (offers: ${levels.join(', ')}).`,
            };
          }
          registry.setPendingModel(file, hit, level);
          registry.broadcast('refresh', file, {});
          return {
            ok: true,
            notice: `Model: ${hit.provider}/${hit.id}${level ? ` · Thinking: ${level}` : ''} (applies when the chat starts)`,
          };
        }
        if (wantedLevel) {
          const levels = supportedThinkingLevels(current);
          if (!levels.includes(wantedLevel)) {
            return {
              ok: false,
              error: `"${wantedLevel}" is not a supported thinking level for ${current.provider}/${current.id} (offers: ${levels.join(', ')}).`,
            };
          }
          registry.setPendingModel(file, current, wantedLevel);
          registry.broadcast('refresh', file, {});
          return {
            ok: true,
            notice: `Thinking: ${wantedLevel} (applies when the chat starts)`,
          };
        }
        return {
          ok: true,
          data: {
            models: models.map(serializeModel),
            current: serializeModel(current),
            currentThinkingLevel: currentLevel,
          },
        };
      }

      const live = await registry.open(file);
      const rt = live.session.modelRuntime;
      const current = live.session.model;
      let target = current;
      if (requested) {
        const models = await rt.getAvailable().catch(() => []);
        const hit = findModel(models, requested);
        if (!hit) return { ok: false, error: `No model matches "${requested}"` };
        await live.session.setModel(hit);
        target = hit;
        registry.broadcast('refresh', file, {});
      }
      if (wantedLevel) {
        const levels = supportedThinkingLevels(target);
        if (!levels.includes(wantedLevel)) {
          return {
            ok: false,
            error: `"${wantedLevel}" is not a supported thinking level for ${target.provider}/${target.id} (offers: ${levels.join(', ')}).`,
          };
        }
        live.session.setThinkingLevel(wantedLevel);
      }
      if (!requested && !wantedLevel) {
        const models = await rt.getAvailable().catch(() => []);
        return {
          ok: true,
          data: {
            models: models.map(serializeModel),
            current: serializeModel(current),
            currentThinkingLevel: live.session.thinkingLevel ?? null,
          },
        };
      }
      const bits = [];
      if (requested) bits.push(`Model: ${target.provider}/${target.id}`);
      if (wantedLevel) bits.push(`Thinking: ${wantedLevel}`);
      return { ok: true, notice: bits.join(' · ') };
    }

    case 'scoped-models': {
      const live = await registry.open(file);
      const rt = live.session.modelRuntime;
      const models = await rt.getAvailable().catch(() => []);
      const scoped = live.session.scopedModels;
      if (extra.modelIds) {
        const ids = new Set(extra.modelIds);
        const picked = models.filter((m) => ids.has(`${m.provider}/${m.id}`));
        live.session.setScopedModels(picked.map((m) => ({ model: m })));
        return {
          ok: true,
          notice:
            picked.length > 0
              ? `Scoped models: ${picked.map((m) => m.id).join(', ')}`
              : 'Scoped models cleared (all models available)',
        };
      }
      return {
        ok: true,
        data: {
          models: models.map(serializeModel),
          scoped: scoped.map((s) => `${s.model.provider}/${s.model.id}`),
        },
      };
    }

    case 'tree': {
      const live = await registry.open(file);
      const sm = live.session.sessionManager;
      if (extra.entryId) {
        const target = sm.getEntry(extra.entryId);
        if (!target) return { ok: false, error: 'Entry not found in this session.' };
        await live.session.navigateTree(extra.entryId);
        registry.broadcast('refresh', file, {});
        return {
          ok: true,
          notice: `Switched to ${target.type === 'message' ? (target.message?.role ?? 'entry') : target.type} at ${extra.entryId.slice(0, 8)}…`,
        };
      }
      return {
        ok: true,
        data: {
          tree: treeToJson(sm.getTree()),
          leafId: sm.getLeafId(),
          currentLabel: sm.getLeafEntry()?.id,
        },
      };
    }

    case 'fork': {
      const live = await registry.open(file);
      if (extra.entryId) {
        const entry = live.session.sessionManager.getEntry(extra.entryId);
        if (entry?.type !== 'message' || entry.message?.role !== 'user') {
          return { ok: false, error: 'Pick a user message to fork from.' };
        }
        if (!entry.parentId) return { ok: false, error: 'Cannot fork from the first message.' };
        const forked = await forkSession(registry, live, entry.parentId);
        return { ok: true, data: { file: forked } };
      }
      return { ok: true, data: { userMessages: live.session.getUserMessagesForForking() } };
    }

    case 'clone': {
      const live = await registry.open(file);
      const leafId = live.session.sessionManager.getLeafId();
      if (!leafId) return { ok: false, error: 'Nothing to clone yet.' };
      const forked = await forkSession(registry, live, leafId);
      return { ok: true, data: { file: forked } };
    }

    case 'export': {
      const live = await registry.open(file);
      const outPath = args?.trim() || undefined;
      let filePath, mime, filename;
      if (outPath?.endsWith('.jsonl')) {
        filePath = live.session.exportToJsonl(outPath);
        mime = 'application/x-ndjson';
      } else {
        filePath = await live.session.exportToHtml(outPath);
        mime = 'text/html';
      }
      filename = path.basename(filePath);
      const content = await readFile(filePath, 'utf8');
      return { ok: true, data: { content, filename, mime, path: filePath } };
    }

    case 'import': {
      const inputPath = args?.trim();
      if (!inputPath) return { ok: false, error: 'Usage: /import <path.jsonl>' };
      const abs = path.resolve(inputPath);
      const raw = await readFile(abs, 'utf8').catch(() => null);
      if (raw === null) return { ok: false, error: `Cannot read ${abs}` };
      const entries = sdk.parseSessionEntries(raw);
      if (!entries.some((e) => e.type === 'session')) {
        return { ok: false, error: `${abs} is not a valid pi session file` };
      }
      const header = entries.find((e) => e.type === 'session');
      const cwd = header?.cwd || NEW_CHAT_CWD;
      const dir = path.join(SESSIONS_ROOT, `--${cwd.replace(/^\//, '').replaceAll('/', '-')}--`);
      const id = header?.id ?? `imported-${Date.now().toString(36)}`;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(dir, `${ts}_${id}.jsonl`);
      await mkdir(dir, { recursive: true });
      await writeFile(dest, raw, 'utf8');
      registry.broadcast('refresh', dest, {});
      return { ok: true, data: { file: dest } };
    }

    case 'reload': {
      const live = await registry.open(file);
      await live.session.reload().catch(() => {});
      registry.broadcast('refresh', file, {});
      return { ok: true, notice: 'Reloaded resources (skills, prompts, context files).' };
    }

    case 'changelog': {
      const changelogPath = path.join(sdkDir, 'CHANGELOG.md');
      const text = readFileSync(changelogPath, 'utf8');
      return { ok: true, data: { text: text.slice(0, 12000) } };
    }

    case 'delete': {
      // Remove a session. The agent must be idle — a running turn or queued
      // messages must not be killed by a UI delete. The agent is then closed
      // (dispose the SDK session so it can't re-append to the file) and the
      // EXACT path is unlinked — never a glob.
      const st = registry.state(file);
      if (st?.status === 'running') {
        return { ok: false, error: 'The session is generating a response — stop it first.' };
      }
      if (st?.status === 'pending') {
        return { ok: false, error: 'The session has queued messages — wait for them to finish.' };
      }
      const root = path.resolve(SESSIONS_ROOT);
      const target = path.resolve(file);
      if (!target.startsWith(root + path.sep) || !target.endsWith('.jsonl')) {
        return { ok: false, error: 'Refusing to delete outside the sessions directory.' };
      }
      await registry.close(file);
      await unlink(target).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      registry.broadcast('refresh', file, {});
      return { ok: true, notice: 'Session deleted.' };
    }

    default:
      return { ok: false, error: `Unknown slash command /${name}` };
  }
}

export { BUILTIN_SLASH_COMMANDS, NA_COMMANDS };

/** Builtin command catalog + skill list for the app's autocomplete. */
export function slashCatalog() {
  return BUILTIN_SLASH_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.argumentHint,
    available: !NA_COMMANDS[c.name],
    naReason: NA_COMMANDS[c.name],
  }));
}

// loadSkills scans the filesystem (agentDir + cwd + skill paths) — the slash
// catalog endpoint hits this on every composer open, so cache briefly.
let skillsCache = null;
let skillsCachedAt = 0;
const SKILLS_TTL_MS = 60 * 1000;

export function listSkills() {
  if (skillsCache && Date.now() - skillsCachedAt < SKILLS_TTL_MS) return skillsCache;
  try {
    const result = sdk.loadSkills({
      cwd: NEW_CHAT_CWD,
      agentDir: sdk.getAgentDir(),
      skillPaths: [],
      includeDefaults: true,
    });
    skillsCache = (result.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? '' }));
    skillsCachedAt = Date.now();
    return skillsCache;
  } catch {
    return []; // skills unavailable — autocomplete just omits them
  }
}
