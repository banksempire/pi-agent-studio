import fs from 'node:fs';
import path from 'node:path';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const stateDir = process.env.STUB_STATE_DIR ?? '/tmp/stub-sdk-state';
fs.mkdirSync(stateDir, { recursive: true });
const promptsLog = path.join(stateDir, 'prompts.jsonl');
const releaseFile = path.join(stateDir, 'release');

export const BUILTIN_SLASH_COMMANDS = [];

export function getAgentDir() {
  return stateDir;
}

export function loadSkills() {
  return { skills: [] };
}

export function parseSessionEntries(raw) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {}
  }
  return out;
}

export class SessionManager {
  constructor(cwd, dir, file) {
    this.cwd = cwd;
    this.dir = dir;
    this.file = file;
  }

  static open(file) {
    return new SessionManager('/', path.dirname(String(file)), String(file));
  }
}

export async function createAgentSession({ sessionManager }) {
  const file = sessionManager.file;
  let listener = () => {};
  let aborted = false;
  const session = {
    get thinkingLevel() {
      return 'off';
    },
    get sessionFile() {
      return file;
    },
    subscribe(cb) {
      listener = cb;
    },
    async prompt(message) {
      const ts = Date.now();
      fs.appendFileSync(
        file,
        `${JSON.stringify({
          type: 'message',
          id: `stub-u-${ts}`,
          parentId: null,
          timestamp: new Date(ts).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: message }], timestamp: ts },
        })}\n`,
      );
      fs.appendFileSync(promptsLog, `${JSON.stringify({ file, message, ts })}\n`);
      listener({ type: 'agent_start' });
      while (!aborted && !fs.existsSync(releaseFile)) await delay(25);
      listener({ type: 'agent_settled' });
    },
    async abort() {
      aborted = true;
    },
    async setModel() {},
    setThinkingLevel() {},
    async compact() {
      return { ok: true };
    },
    async dispose() {},
    getLastAssistantText() {
      return undefined;
    },
  };
  return { session };
}
