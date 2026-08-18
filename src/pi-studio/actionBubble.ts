export type ActionKind = 'thinking' | 'tool' | 'bash' | 'compaction';
export type ActionStatus = 'pending' | 'ok' | 'fail';

export function actionName(kind: ActionKind, tool?: string): string {
  if (kind === 'thinking') return 'Thinking';
  if (kind === 'compaction') return 'Compaction';
  if (kind === 'bash' || tool === 'bash') return 'Bash tooling';
  return tool ?? 'Tool';
}

export class ActionBubble {
  readonly key: string;
  readonly kind: ActionKind;
  name: string;
  status: ActionStatus = 'pending';
  isError = false;
  detail = '';
  args?: string;
  startTs = 0;
  durMs = 0;
  live = false;

  constructor(kind: ActionKind, key: string, name: string, startTs: number) {
    this.kind = kind;
    this.key = key;
    this.name = name;
    this.startTs = startTs;
  }

  preview(maxWords = 10): string {
    const d = this.detail;
    if (!d) return '';
    const line = d.slice(d.lastIndexOf('\n') + 1).trim();
    const words = line.split(/\s+/);
    return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '');
  }
}

export class ActionGroup {
  readonly id: string;
  readonly bubbles: ActionBubble[] = [];
  wip = false;
  startTs = 0;
  durMs = 0;

  constructor(id: string, startTs: number) {
    this.id = id;
    this.startTs = startTs;
  }

  get latest(): ActionBubble | undefined {
    return this.bubbles[this.bubbles.length - 1];
  }
}
