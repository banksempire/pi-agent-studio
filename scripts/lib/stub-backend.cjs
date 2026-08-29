const fs = require('node:fs');
const path = require('node:path');

const STUB_TEMPLATE = `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const CONTROL = process.env.STUB_CONTROL_FILE;
const bus = new EventEmitter();
let liveStates = [];
let offset = 0;
try {
  offset = fs.statSync(CONTROL).size;
} catch {}

setInterval(() => {
  let st;
  try {
    st = fs.statSync(CONTROL);
  } catch {
    return;
  }
  if (st.size <= offset) {
    if (st.size < offset) offset = 0;
    return;
  }
  const fd = fs.openSync(CONTROL, 'r');
  const buf = Buffer.alloc(st.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset += buf.length;
  for (const line of buf.toString('utf8').split('\\n')) {
    const t = line.trim();
    if (!t) continue;
    let cmd;
    try {
      cmd = JSON.parse(t);
    } catch {
      continue;
    }
    if (cmd.op === 'event') {
      bus.emit('agent-event', { type: cmd.type, file: cmd.file, json: JSON.stringify(cmd.payload ?? {}) });
    } else if (cmd.op === 'states') {
      liveStates = cmd.states ?? [];
    }
  }
}, 40);

export async function createClient() {
  return {
    async ping() {
      return { ok: true };
    },
    async createSession() {
      return { file: '/unused' };
    },
    async openAgent() {
      return { ok: true, state: null };
    },
    async closeAgent() {
      return { ok: true };
    },
    async prompt(evt) {
      if (process.env.STUB_PROMPT_LOG) {
        fs.appendFileSync(
          process.env.STUB_PROMPT_LOG,
          JSON.stringify({ agentId: evt && evt.agentId, message: evt && evt.message, interrupt: evt && evt.interrupt }) + '\\n',
        );
      }
      return { ok: true };
    },
    async abort(evt) {
      if (process.env.STUB_ABORT_LOG) {
        fs.appendFileSync(process.env.STUB_ABORT_LOG, JSON.stringify({ agentId: evt && evt.agentId }) + '\\n');
      }
      return { ok: true };
    },
    async slash({ agentId, command }) {
      if (command === 'delete') {
        try {
          fs.rmSync(agentId, { force: true });
        } catch {}
        return { ok: true, notice: 'Session deleted.', dataJson: '' };
      }
      return { ok: true, notice: '' };
    },
    async getModels() {
      return { ok: true, models: [], default: null, current: null, currentThinkingLevel: null };
    },
    async setModel() {
      return { ok: true, notice: '' };
    },
    async refreshCatalog() {
      return { ok: true, models: [], default: null, current: null, currentThinkingLevel: null, errors: [] };
    },
    async setDefault() {
      return { ok: true, models: [], default: null, current: null, currentThinkingLevel: null, errors: [] };
    },
    async listStates() {
      return { states: liveStates };
    },
    async getAgentState() {
      return { state: null };
    },
    subscribe() {
      const stream = new EventEmitter();
      bus.on('agent-event', (ev) => stream.emit('data', ev));
      return stream;
    },
    close() {},
  };
}
`;

function writeStubClient(runRoot) {
  const stubPath = path.join(runRoot, 'stub-client.mjs');
  const controlPath = path.join(runRoot, 'stub-control.jsonl');
  fs.writeFileSync(stubPath, STUB_TEMPLATE);
  fs.writeFileSync(controlPath, '');
  const emit = (type, file, payload) => {
    fs.appendFileSync(controlPath, `${JSON.stringify({ op: 'event', type, file, payload })}\n`);
  };
  const setStates = (states) => {
    fs.appendFileSync(controlPath, `${JSON.stringify({ op: 'states', states })}\n`);
  };
  return { stubPath, controlPath, emit, setStates };
}

module.exports = { writeStubClient };
