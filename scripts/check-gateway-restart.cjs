const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-restart-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const BACKEND_LOG = '/tmp/gw-restart-check-backend.log';
const VITE_LOG = '/tmp/gw-restart-check-vite.log';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', reject);
  });
}

function makeSessionFile() {
  const dir = path.join(SESSIONS_ROOT, '--restart-check--');
  fs.mkdirSync(dir, { recursive: true });
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const file = path.join(dir, 'restart-chat.jsonl');
  const base = Date.now() - 60_000;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date(base).toISOString(),
      cwd: RUN_ROOT,
    }),
    JSON.stringify({
      type: 'message',
      id: 'seedu0',
      parentId: id,
      timestamp: new Date(base).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'seed q0' }], timestamp: base },
    }),
    JSON.stringify({
      type: 'message',
      id: 'seeda0',
      parentId: 'seedu0',
      timestamp: new Date(base + 500).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'seed a0' }],
        timestamp: base + 500,
        stopReason: 'stop',
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.utimesSync(file, new Date(base), new Date(base));
  return file;
}

function writeStubClient(sessFile) {
  const stub = `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const SESS_FILE = ${JSON.stringify(sessFile)};
const bus = new EventEmitter();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
try {
  const lines = fs.readFileSync(SESS_FILE, 'utf8').split('\\n').filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (typeof e.id === 'string' && e.id.startsWith('stub-a')) n += 1;
    } catch {}
  }
} catch {}
let chain = Promise.resolve();

const lastId = () => {
  try {
    const lines = fs.readFileSync(SESS_FILE, 'utf8').split('\\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.id) return e.id;
      } catch {}
    }
  } catch {}
  return 'seeda0';
};

const append = (entry) => fs.appendFileSync(SESS_FILE, \`\${JSON.stringify(entry)}\\n\`);
const emit = (type, file, payload) => bus.emit('agent-event', { type, file, json: JSON.stringify(payload ?? {}) });

async function runPrompt(agentId, text) {
  const file = agentId;
  emit('ack', file, { reqId: '', kind: 'message' });
  n += 1;
  const ts = Date.now();
  emit('message', file, { id: \`pending-\${ts}\`, role: 'user', text, ts });
  append({
    type: 'message',
    id: \`stub-u\${n}\`,
    parentId: lastId(),
    timestamp: new Date(ts).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts },
  });
  emit('session_status', file, { status: 'running', runningSince: ts });
  emit('message', file, { id: \`user-\${ts}\`, role: 'user', text, ts });
  emit('refresh', file, {});
  await delay(60);
  const ats = ts + 500;
  const reply = \`REPLY-\${n}-MARKER: \${'stub answer text '.repeat(6)}\`;
  emit('message', file, { id: \`asst-\${ats}\`, role: 'assistant', text: reply.slice(0, 20), ts: ats });
  await delay(60);
  append({
    type: 'message',
    id: \`stub-a\${n}\`,
    parentId: \`stub-u\${n}\`,
    timestamp: new Date(ats).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: ats, stopReason: 'stop' },
  });
  emit('message', file, { id: \`asst-\${ats}\`, role: 'assistant', text: reply, ts: ats, stopReason: 'stop' });
  emit('refresh', file, {});
  emit('session_status', file, { status: 'idle' });
  emit('refresh', file, {});
}

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
    async prompt({ agentId, message }) {
      chain = chain.then(() => runPrompt(agentId, message), () => runPrompt(agentId, message));
      await chain;
      return { ok: true };
    },
    async abort() {
      return { ok: true };
    },
    async slash() {
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
      return { states: [] };
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
  const file = path.join(RUN_ROOT, 'stub-client.mjs');
  fs.writeFileSync(file, stub);
  return file;
}

const spawnBackend = (port, stubPath) =>
  spawn('node', ['src/pi-studio/server/index.mjs'], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_PORT: String(port),
      PI_STUDIO_CLIENT_MODULE: stubPath,
      PI_STUDIO_SESSIONS: SESSIONS_ROOT,
      PI_STUDIO_STATES_PATH: STATES_PATH,
      PI_STUDIO_CWD: RUN_ROOT,
    },
    stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
    detached: true,
  });

(async () => {
  const { report, isFailed } = makeReporter();
  const backendPort = await freePort();
  const vitePort = await freePort();
  console.log(`stack: stub-client backend :${backendPort} vite :${vitePort}`);
  const sessFile = makeSessionFile();
  const stubPath = writeStubClient(sessFile);
  let backend = spawnBackend(backendPort, stubPath);
  let vite = null;
  let browser = null;

  const cleanup = async () => {
    try {
      if (browser) await browser.close();
    } catch {}
    for (const child of [backend, vite]) {
      try {
        if (child) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    setTimeout(() => fs.rmSync(RUN_ROOT, { recursive: true, force: true }), 1000).unref();
  };

  try {
    for (let i = 0; i < 60; i++) {
      try {
        if (await getJson(backendPort, '/api/health')) break;
      } catch {}
      await delay(500);
    }
    vite = spawn(
      'node',
      [
        'node_modules/.bin/vite',
        '--config',
        'vite.config.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(vitePort),
      ],
      {
        cwd: PRODUCT_ROOT,
        env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${backendPort}` },
        stdio: ['ignore', fs.openSync(VITE_LOG, 'w'), fs.openSync(VITE_LOG, 'w')],
        detached: true,
      },
    );
    for (let i = 0; i < 60; i++) {
      try {
        const r = await new Promise((resolve, reject) => {
          http
            .get(`http://127.0.0.1:${vitePort}/`, (res) => {
              res.resume();
              resolve(res.statusCode);
            })
            .on('error', reject);
        });
        if (r === 200) break;
      } catch {}
      await delay(500);
    }

    browser = await chromium.launch();
    const netLog = [];
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    for (const [tag, p] of [
      ['A', pageA],
      ['B', pageB],
    ]) {
      p.on('pageerror', (e) => console.log(`page${tag} pageerror: ${e.message}`));
      p.on('console', (m) => {
        if (m.type() === 'error') console.log(`page${tag} console: ${m.text().slice(0, 160)}`);
      });
      p.on('response', (r) => {
        const u = r.url();
        if (u.includes('/api/chat')) console.log(`page${tag} POST /api/chat → ${r.status()}`);
        else if (u.includes('/api/events/heartbeat')) netLog.push(`${tag} hb ${r.status()}`);
        else if (u.includes('/api/events') && u.includes('open'))
          netLog.push(`${tag} open-views ${r.status()}`);
        else if (u.includes('/api/sessions/messages'))
          netLog.push(`${tag} msgs ${r.status()} ${u.slice(u.indexOf('?') + 1, u.indexOf('?') + 60)}`);
      });
      await p.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForSelector('.chat-list-item', { timeout: 60000 });
      await p.locator('.chat-list-item').first().click({ force: true, timeout: 15000 });
      await p.waitForSelector('.chat-messages', { timeout: 30000 });
    }
    await delay(3000);

    const hasMarker = async (p, marker) =>
      (await p.locator('.chat-messages', { timeout: 10000 }).getByText(marker, { exact: false }).count()) > 0;
    const health = () => getJson(backendPort, '/api/health');
    const sendFrom = async (p, n) => {
      await p.bringToFront();
      await p.fill('.chat-input', `msg ${n}`);
      await p.press('.chat-input', 'Enter');
    };

    await sendFrom(pageA, 1);
    for (let i = 0; i < 20; i++) {
      await delay(500);
      if (await hasMarker(pageA, 'REPLY-1-MARKER')) break;
    }
    report(
      'T1 baseline: send before outage reaches both pages',
      (await hasMarker(pageA, 'REPLY-1-MARKER')) && (await hasMarker(pageB, 'REPLY-1-MARKER')),
    );

    process.kill(-backend.pid, 'SIGKILL');
    await delay(5000);
    backend = spawnBackend(backendPort, stubPath);
    for (let i = 0; i < 60; i++) {
      try {
        if (await getJson(backendPort, '/api/health')) break;
      } catch {}
      await delay(500);
    }
    await delay(3000);

    await sendFrom(pageA, 2);
    await sendFrom(pageA, 3);
    await sendFrom(pageB, 4);
    for (let i = 0; i < 30; i++) {
      await delay(500);
      if (
        (await hasMarker(pageA, 'REPLY-4-MARKER')) &&
        (await hasMarker(pageB, 'REPLY-4-MARKER')) &&
        (await hasMarker(pageA, 'REPLY-2-MARKER')) &&
        (await hasMarker(pageB, 'REPLY-2-MARKER'))
      )
        break;
    }

    const h = await health();
    let views = h.sseViews;
    for (let i = 0; i < 60 && !(h.sseClients === 2 && views === 2); i++) {
      await delay(500);
      const again = await health();
      views = again.sseViews;
      h.sseClients = again.sseClients;
    }
    const missing = [];
    for (const m of ['A', 'B']) {
      for (const n of [2, 3, 4]) {
        if (!(await hasMarker(m === 'A' ? pageA : pageB, `REPLY-${n}-MARKER`))) missing.push(`${m}:${n}`);
      }
    }
    report(
      'T2 after backend restart: both pages keep receiving new turns (replies 2-4 visible)',
      missing.length === 0,
      missing.length ? `missing ${missing.join(' ')}` : '',
    );
    fs.writeFileSync('/tmp/gw-restart-net.log', netLog.join('\n'));
    const tailCheck = await getJson(
      backendPort,
      `/api/sessions/messages?file=${encodeURIComponent(sessFile)}&after=seeda0`,
    );
    console.log(`server tail after seeda0: ${(tailCheck.messages ?? []).map((m) => m.id).join(',')}`);
    const rawIds = fs
      .readFileSync(sessFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const e = JSON.parse(l);
          return `${e.id}<-${e.parentId}`;
        } catch {
          return 'PARSE-ERR';
        }
      });
    console.log(`file entries: ${rawIds.join(' ')}`);
    report(
      'T3 both SSE connections re-established with views after restart',
      h.sseClients === 2 && h.sseViews === 2,
      `clients=${h.sseClients} views=${h.sseViews}`,
    );

    await sendFrom(pageB, 5);
    for (let i = 0; i < 20; i++) {
      await delay(500);
      if (await hasMarker(pageA, 'REPLY-5-MARKER')) break;
    }
    report(
      'T4 cross-page after recovery: A sees the turn sent from B',
      await hasMarker(pageA, 'REPLY-5-MARKER'),
    );
  } catch (e) {
    report('suite crashed', false, String(e?.stack ? e.stack : e));
  }

  await cleanup();
  console.log(isFailed() ? 'backend-restart check: FAILED' : 'backend-restart check: all passed');
  process.exit(isFailed() ? 1 : 0);
})();
