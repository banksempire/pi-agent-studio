import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeModel } from './models.mjs';
import { NEW_CHAT_CWD, SESSIONS_ROOT, sdk, sdkDir } from './sdk-bridge.mjs';

function treeToJson(nodes) {
  return (nodes ?? []).map((n) => ({
    id: n.entry?.id,
    type: n.entry?.type,
    label: n.label ?? n.entry?.id,
    children: treeToJson(n.children),
  }));
}

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

export async function execSlash(registry, { agentId, command, args, extra = {} }) {
  const name = String(command ?? '')
    .replace(/^\/+/, '')
    .trim();
  if (!name) return { ok: false, error: 'empty slash command' };
  const file = agentId || undefined;

  switch (name) {
    case 'new': {
      const cwd = args?.trim() || NEW_CHAT_CWD;
      const { file: f } = registry.createSession(cwd);
      await registry.open(f);
      return { ok: true, data: { file: f } };
    }

    case 'session': {
      const live = await registry.open(file);
      const stats = live.session.getSessionStats();
      const sm = live.session.sessionManager;
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
      const st = registry.state(file);
      if (st?.status === 'running') {
        return { ok: false, error: 'The session is generating a response — stop it first.' };
      }
      if (st?.status === 'pending' && !registry.pendingInfo(file)) {
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
