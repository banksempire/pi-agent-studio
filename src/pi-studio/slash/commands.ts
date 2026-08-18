import { useChatStore } from '../store/chat';

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  available: boolean;
  naReason?: string;
}

export interface SlashSkillInfo {
  name: string;
  description: string;
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
}

export interface SlashPicker {
  kind: 'picker';
  title: string;
  items: PickerItem[];
  onSelect: (id: string) => void | Promise<SlashResult | void>;
}

export type SlashResult =
  | { kind: 'none' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'clipboard'; text: string }
  | { kind: 'download'; content: string; filename: string; mime: string }
  | SlashPicker;

interface Catalog {
  commands: SlashCommandInfo[];
  skills: SlashSkillInfo[];
}

let catalog: Catalog | null = null;

async function fetchCatalog(): Promise<Catalog> {
  if (catalog) return catalog;
  try {
    const res = await fetch('/api/slash-commands');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = (await res.json()) as Catalog;
  } catch {
    catalog = { commands: [], skills: [] };
  }
  return catalog;
}

export async function allSlashCommands(): Promise<SlashCommandInfo[]> {
  const c = await fetchCatalog();
  return [
    ...c.commands,
    ...c.skills.map((s) => ({
      name: `skill:${s.name}`,
      description: s.description || 'Invoke a skill',
      available: true,
    })),
  ];
}

export interface ParsedSlash {
  command: string;
  args: string;
}

export function parseSlash(text: string): ParsedSlash | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  if (t === '/' || t.startsWith('//')) return null;
  const sp = t.indexOf(' ');
  if (sp < 0) return { command: t.slice(1).trim().toLowerCase(), args: '' };
  return { command: t.slice(1, sp).trim().toLowerCase(), args: t.slice(sp + 1).trim() };
}

interface SlashResponse {
  ok: boolean;
  notice?: string;
  error?: string;
  data?: any;
}

async function postSlash(body: Record<string, unknown>): Promise<SlashResponse> {
  const res = await fetch('/api/slash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j: SlashResponse;
  try {
    j = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  return j;
}

const store = useChatStore();

export async function runSlash(sessionId: string, parsed: ParsedSlash): Promise<SlashResult> {
  const { command, args } = parsed;

  const session = store.findSession(sessionId);
  const file = session?.file;

  if (command === 'new') {
    await store.newChat();
    return { kind: 'none' };
  }
  if (command === 'hotkeys') {
    const sendKey =
      store.prefs.sendKey === 'shiftEnter'
        ? 'Shift+Enter — send message\nEnter — new line'
        : 'Enter — send message\nShift+Enter — new line';
    return {
      kind: 'notice',
      text: [
        'Keyboard shortcuts',
        sendKey,
        'Ctrl+N — new chat',
        'Type / for slash commands, ! for a bash command',
        'Chat window tabs can be dragged between tiles; ✕ closes the view, not the session.',
        '',
        'Right panel: Send with + Markdown switches are global.',
      ].join('\n'),
    };
  }
  if (command === 'resume') {
    return {
      kind: 'picker',
      title: 'Resume a session',
      items: [...store.sessions]
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .map((s) => ({ id: s.id, label: s.title, detail: s.preview || undefined })),
      onSelect: (id) => {
        store.openChat(id);
      },
    };
  }

  const needsSession = [
    'session',
    'name',
    'compact',
    'copy',
    'model',
    'scoped-models',
    'tree',
    'fork',
    'clone',
    'export',
    'reload',
  ];
  if (needsSession.includes(command)) {
    if (!file) {
      return { kind: 'error', text: `/${command} needs an open chat window — open one first.` };
    }
  }

  try {
    const r = await postSlash({ file, command, args, extra: {} });

    if (command === 'compact') {
      if (!r.ok) store.markCompactFailed(sessionId, r.error ?? null);
      return { kind: 'none' };
    }

    if (!r.ok) return { kind: 'error', text: r.error ?? `/${command} failed` };
    if (r.data?.file) {
      const newId = encodeURIComponent(r.data.file);
      await store.refreshList();
      store.openChat(newId);
      return { kind: 'notice', text: r.notice ?? `Session opened (${r.data.file.split('/').pop()})` };
    }
    if (r.data?.text && command === 'copy') {
      return { kind: 'clipboard', text: r.data.text };
    }
    if (r.data?.content && command === 'export') {
      return { kind: 'download', content: r.data.content, filename: r.data.filename, mime: r.data.mime };
    }
    if (r.data?.text && command === 'session') {
      return { kind: 'notice', text: r.data.text };
    }
    if (r.data?.text && command === 'changelog') {
      return { kind: 'notice', text: r.data.text };
    }
    if (r.data?.models) {
      if (command === 'model') {
        return {
          kind: 'picker',
          title: 'Switch model',
          items: r.data.models.map((m: any) => ({
            id: `${m.provider}/${m.id}`,
            label: `${m.id} (${m.provider})`,
            detail: `${m.reasoning ? 'reasoning · ' : ''}${m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : ''}`,
          })),
          onSelect: async (id) => {
            const rr = await postSlash({ file, command: 'model', args: id });
            if (!rr.ok) return { kind: 'error', text: rr.error ?? 'model switch failed' };
            if (rr.notice) store.appendLocalMessage(sessionId, { text: rr.notice });
            return { kind: 'none' };
          },
        };
      }
      if (command === 'scoped-models') {
        const scoped: string[] = r.data.scoped ?? [];
        return {
          kind: 'picker',
          title: 'Scoped models (Ctrl+P cycling) — pick the ones to keep',
          items: r.data.models.map((m: any) => {
            const id = `${m.provider}/${m.id}`;
            return {
              id,
              label: `${scoped.includes(id) ? '✓ ' : ''}${m.id} (${m.provider})`,
              detail: `${m.reasoning ? 'reasoning · ' : ''}${m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : ''}`,
            };
          }),
          onSelect: async (id) => {
            const next = scoped.includes(id) ? scoped.filter((x) => x !== id) : [...scoped, id];
            const rr = await postSlash({ file, command: 'scoped-models', extra: { modelIds: next } });
            if (!rr.ok) return { kind: 'error', text: rr.error ?? 'failed' };
            if (rr.notice) store.appendLocalMessage(sessionId, { text: rr.notice });
            return { kind: 'none' };
          },
        };
      }
    }
    if (r.data?.tree) {
      const leaf = r.data.leafId;
      return {
        kind: 'picker',
        title: 'Session tree — jump to a point',
        items: flattenTree(r.data.tree).map((n: any) => ({
          id: n.id,
          label: `${'  '.repeat(n.depth)}${n.label}`,
          detail: n.type,
        })),
        onSelect: async (id) => {
          const rr = await postSlash({ file, command: 'tree', extra: { entryId: id } });
          if (!rr.ok) return { kind: 'error', text: rr.error ?? 'failed' };
          if (rr.notice) store.appendLocalMessage(sessionId, { text: rr.notice });
          if (leaf !== id) store.refreshList();
          return { kind: 'none' };
        },
      };
    }
    if (r.data?.userMessages) {
      return {
        kind: 'picker',
        title: 'Fork from a user message',
        items: r.data.userMessages.map((m: any, i: number) => ({
          id: m.entryId,
          label: (m.text || '(empty)').replace(/\s+/g, ' ').slice(0, 80),
          detail: `message ${r.data.userMessages.length - i}`,
        })),
        onSelect: async (id) => {
          const rr = await postSlash({ file, command: 'fork', extra: { entryId: id } });
          if (!rr.ok) return { kind: 'error', text: rr.error ?? 'fork failed' };
          if (rr.data?.file) {
            const newId = encodeURIComponent(rr.data.file);
            await store.refreshList();
            store.openChat(newId);
          }
          return { kind: 'none' };
        },
      };
    }
    if (r.notice) return { kind: 'notice', text: r.notice };
    return { kind: 'none' };
  } catch (e) {
    if (command === 'compact') {
      store.markCompactFailed(sessionId, `/${command} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { kind: 'none' };
    }
    return { kind: 'error', text: `/${command} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function flattenTree(nodes: any[], depth = 0, acc: any[] = []): any[] {
  for (const n of nodes ?? []) {
    acc.push({ ...n, depth });
    flattenTree(n.children, depth + 1, acc);
  }
  return acc;
}
