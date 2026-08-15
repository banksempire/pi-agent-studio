/**
 * SDK bridge: finds the global pi SDK and converts SDK messages/events into
 * the wire display shape. This is the ONLY module that imports the SDK —
 * pi-nest's registry and slash executor go through it, so the rest of the
 * host never touches SDK types directly (and a later SDK swap stays local).
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SESSIONS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
/** Working directory for newly created sessions. */
export const NEW_CHAT_CWD = process.env.PI_NEST_CWD ?? '/workspace/sf';

export function findSdkDir() {
  if (process.env.PI_SDK_DIR && existsSync(process.env.PI_SDK_DIR)) return process.env.PI_SDK_DIR;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(root, '@earendil-works', 'pi-coding-agent');
    if (existsSync(path.join(p, 'dist', 'index.js'))) return p;
  } catch {
    /* fall through */
  }
  return null;
}

const sdkDir = findSdkDir();
if (!sdkDir) {
  console.error('[pi-nest] pi SDK not found (set PI_SDK_DIR)');
  process.exit(1);
}
const sdk = await import(pathToFileURL(path.join(sdkDir, 'dist', 'index.js')).href);
const { BUILTIN_SLASH_COMMANDS } = await import(
  pathToFileURL(path.join(sdkDir, 'dist', 'core', 'slash-commands.js')).href
);

export { BUILTIN_SLASH_COMMANDS, sdk, sdkDir };

/** Stable id for compaction/branch summaries: derived from the text, so the
 *  live SSE copy and the file-parse copy upsert to the same message. */
export function hashId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    let images = 0;
    for (const block of content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'image') images += 1;
      else if (block.type === 'input_text') parts.push(block.text ?? '');
    }
    const base = parts.join('\n');
    return images > 0 ? (base ? `${base}\n[📷 ${images} image]` : `[📷 ${images} image]`) : base;
  }
  return '';
}

export { textOf };

/** Extract image blocks from message content. Handles both the storage
 *  shape ({ type:'image', data, mimeType }) and the prompt shape
 *  ({ type:'image', source:{ type:'base64', mediaType, data } }). */
export function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type !== 'image') continue;
    const data = block.data ?? block.source?.data;
    const mimeType = block.mimeType ?? block.source?.mediaType;
    if (typeof data === 'string' && data && typeof mimeType === 'string') {
      out.push({ data, mimeType });
    }
  }
  return out;
}

/** Text of the text blocks only — no [📷 …] marker (the UI renders the
 *  images themselves). */
function plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block.type === 'text' ? block.text : block.type === 'input_text' ? (block.text ?? '') : '',
      )
      .join('\n');
  }
  return '';
}

/** Convert an SDK AgentMessage into the wire/display shape. */
export function toDisplayMessage(message) {
  const d = { role: message.role, text: '', ts: message.timestamp ?? Date.now() };
  if (message.role === 'assistant') {
    d.text = textOf(message.content);
    d.model = message.model ?? null;
    d.provider = message.provider ?? null;
    d.stopReason = message.stopReason ?? null;
    d.error = message.errorMessage ?? null;
    const thinking = [];
    const toolCalls = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'thinking') thinking.push(block.thinking);
      else if (block.type === 'toolCall') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.arguments === undefined ? '' : JSON.stringify(block.arguments, null, 1),
          result: undefined,
          isError: undefined,
        });
      }
    }
    d.thinking = thinking.length ? thinking.join('\n') : undefined;
    d.toolCalls = toolCalls.length ? toolCalls : undefined;
  } else if (message.role === 'user') {
    // User messages may carry image attachments — the UI renders them
    // directly (no [📷 N image] marker in the text).
    d.text = plainText(message.content);
    const imgs = extractImages(message.content);
    if (imgs.length) d.images = imgs;
  } else if (message.role === 'toolResult') {
    d.text = textOf(message.content);
    d.toolCallId = message.toolCallId ?? null;
    d.toolName = message.toolName ?? null;
    d.isError = !!message.isError;
  } else if (message.role === 'bashExecution') {
    d.role = 'bash';
    d.text = message.output ?? '';
    d.command = message.command ?? '';
    d.exitCode = message.exitCode;
  } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
    d.role = 'summary';
    d.text = message.summary ?? '';
  } else if (message.role === 'custom') {
    d.role = 'custom';
    d.text = textOf(message.content);
    d.customType = message.customType ?? null;
  }
  return d;
}

/** Stable per-message ids for the live stream (file parse uses entry ids). */
export function messageId(message) {
  if (message.role === 'assistant') return `asst-${message.timestamp ?? Date.now()}`;
  if (message.role === 'user') return `user-${message.timestamp ?? Date.now()}`;
  if (message.role === 'toolResult')
    return `toolresult-${message.toolCallId ?? message.timestamp ?? Date.now()}`;
  if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
    return `summary-${hashId(message.summary ?? '')}`;
  }
  return `msg-${message.timestamp ?? Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function extractText(result) {
  if (!result) return '';
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

/** The thinking levels a model actually offers, per its configuration.
 *  Mirrors pi-ai's getSupportedThinkingLevels (reasoning flag + per-level
 *  thinkingLevelMap: null disables a level; xhigh/max require an explicit
 *  mapping). Kept in sync with the SDK so the model menu never shows levels
 *  the model doesn't support (e.g. the full OpenAI list). */
const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ['off'];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** Mirror the SDK's session-file naming so a lazy session lands on its path. */
export function newSessionPath(cwd) {
  const resolved = path.resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const dir = path.join(SESSIONS_ROOT, safe);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${ts}_${randomUUID()}.jsonl`);
}
