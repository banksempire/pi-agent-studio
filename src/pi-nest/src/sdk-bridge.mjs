import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SESSIONS_ROOT =
  process.env.PI_NEST_SESSIONS ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
export const NEW_CHAT_CWD = process.env.PI_NEST_CWD ?? '/workspace/sf';

export function findSdkDir() {
  if (process.env.PI_SDK_DIR && existsSync(process.env.PI_SDK_DIR)) return process.env.PI_SDK_DIR;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(root, '@earendil-works', 'pi-coding-agent');
    if (existsSync(path.join(p, 'dist', 'index.js'))) return p;
  } catch {}
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

function plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block.type === 'text' ? block.text : block.type === 'input_text' ? (block.text ?? '') : '',
      )
      .join('\n')
      .trim();
  }
  return '';
}

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

export function newSessionPath(cwd) {
  const resolved = path.resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const dir = path.join(SESSIONS_ROOT, safe);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${ts}_${randomUUID()}.jsonl`);
}
