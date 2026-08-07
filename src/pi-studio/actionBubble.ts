/**
 * ActionBubble (ab) — one unit of "special" agent output (thinking blocks,
 * tool calls, bash steps, session compaction) that happens between a user
 * message and the agent's final text reply. Consecutive bubbles stack into an
 * ActionGroup.
 *
 * Display format:
 *   in motion   →  [action name|ani|content|time elapsed]
 *   completed   →  [action name|time elapsed]
 *   group done  →  [n actions done|total time elapsed]
 *
 * Bubbles are collapsed by default: a click on a single bubble (or group)
 * reveals the details; a click on a stacked group reveals its sub-bubbles,
 * and a click on a sub-bubble reveals its detail.
 */

export type ActionKind = 'thinking' | 'tool' | 'bash' | 'compaction';
export type ActionStatus = 'pending' | 'ok' | 'fail';

/** Human-readable action name (spec examples: "Thinking", "Bash tooling"). */
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
  /** Full content the agent emitted during the action (thinking text, tool
   *  result, bash output…). Grows while streaming. */
  detail = '';
  /** Tool-call arguments (shown in the expanded detail). */
  args?: string;
  /** Timestamp the action started. */
  startTs = 0;
  /** Static duration once completed (0 while live). */
  durMs = 0;
  /** Trailing bubble of a WIP group: its elapsed runs against the live clock. */
  live = false;

  constructor(kind: ActionKind, key: string, name: string, startTs: number) {
    this.kind = kind;
    this.key = key;
    this.name = name;
    this.startTs = startTs;
  }

  /**
   * Header content preview: the first few words of the latest line of the
   * streamed content, if any. Because it derives from `detail`, it updates
   * automatically when the agent starts a new line while streaming. Only the
   * last line is split (a huge streamed detail is not re-tokenized per tick).
   */
  preview(maxWords = 10): string {
    const d = this.detail;
    if (!d) return '';
    const line = d.slice(d.lastIndexOf('\n') + 1).trim();
    const words = line.split(/\s+/);
    return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '');
  }
}

/** A stack of consecutive action bubbles (one work run between user/replies). */
export class ActionGroup {
  readonly id: string;
  readonly bubbles: ActionBubble[] = [];
  /** The run is still in progress — the header shows the latest bubble. */
  wip = false;
  startTs = 0;
  /** Total elapsed once the whole group completed. */
  durMs = 0;

  constructor(id: string, startTs: number) {
    this.id = id;
    this.startTs = startTs;
  }

  /** The most recent bubble — what a WIP group header shows. */
  get latest(): ActionBubble | undefined {
    return this.bubbles[this.bubbles.length - 1];
  }
}
