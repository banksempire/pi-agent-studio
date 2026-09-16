const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = '/tmp/bubble-anchor-check';
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const MOVE_EPS = 1;

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

const STUB_TEMPLATE = `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
const CONTROL = process.env.STUB_CONTROL_FILE;
const bus = new EventEmitter();
let liveStates = [];
let offset = 0;
try { offset = fs.statSync(CONTROL).size; } catch {}
setInterval(() => {
  let st;
  try { st = fs.statSync(CONTROL); } catch { return; }
  if (st.size <= offset) { if (st.size < offset) offset = 0; return; }
  const fd = fs.openSync(CONTROL, 'r');
  const buf = Buffer.alloc(st.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd, 0, buf.length);
  offset += buf.length;
  for (const line of buf.toString('utf8').split('\\n')) {
    const t = line.trim();
    if (!t) continue;
    let cmd;
    try { cmd = JSON.parse(t); } catch { continue; }
    if (cmd.op === 'event') bus.emit('agent-event', { type: cmd.type, file: cmd.file, json: JSON.stringify(cmd.payload ?? {}) });
    else if (cmd.op === 'states') liveStates = cmd.states ?? [];
  }
}, 15);
export async function createClient() {
  return {
    async ping() { return { ok: true }; },
    async createSession() { return { file: '/unused' }; },
    async openAgent() { return { ok: true, state: null }; },
    async closeAgent() { return { ok: true }; },
    async prompt() { return { ok: true }; },
    async abort() { return { ok: true }; },
    async slash() { return { ok: true, notice: '' }; },
    async getModels() { return { ok: true, models: [], default: null, current: null, currentThinkingLevel: null }; },
    async setModel() { return { ok: true, notice: '' }; },
    async refreshCatalog() { return { ok: true, models: [], default: null, current: null, currentThinkingLevel: null, errors: [] }; },
    async setDefault() { return { ok: true, models: [], default: null, current: null, currentThinkingLevel: null, errors: [] }; },
    async listStates() { return { states: liveStates }; },
    async getAgentState() { return { state: null }; },
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
  return { stubPath, controlPath, emit };
}

function seedSession() {
  fs.rmSync(SESSIONS_ROOT, { recursive: true, force: true });
  const dir = path.join(SESSIONS_ROOT, '2026-08-10');
  fs.mkdirSync(dir, { recursive: true });
  const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
  const id = uid();
  const base = 1786342000000;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date(base).toISOString(),
      cwd: '/tmp/bubble-anchor-cwd',
    }),
  ];
  let prev = id;
  let ts = base;
  let n = 0;
  const step = (mins) => {
    ts += mins * 60000;
    return ts;
  };
  for (let t = 1; t <= 25; t++) {
    n += 1;
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `u${n}`,
        parentId: prev,
        timestamp: new Date(step(1)).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: `question ${n} — ${'padding for a taller row '.repeat(10)}` }],
          timestamp: ts,
        },
      }),
    );
    prev = `u${n}`;
    const assistant = {
      role: 'assistant',
      content: [{ type: 'text', text: `Answer ${n} — ${'reply padding text '.repeat(12)}` }],
      timestamp: step(0.5),
      stopReason: 'stop',
    };
    if (t === 4 || t === 8 || t === 12) {
      assistant.content = [
        { type: 'thinking', thinking: `deliberation ${n} — ${'weighing the options carefully '.repeat(8)}` },
        { type: 'toolCall', id: `call-${n}a`, name: 'read', arguments: { path: `/tmp/file-${n}.ts` } },
        { type: 'toolCall', id: `call-${n}b`, name: 'grep', arguments: { pattern: 'needle', path: '/tmp' } },
        { type: 'text', text: `Answer ${n} — ${'reply padding text '.repeat(12)}` },
      ];
    }
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `a${n}`,
        parentId: prev,
        timestamp: new Date(ts).toISOString(),
        message: assistant,
      }),
    );
    prev = `a${n}`;
  }
  const fn = path.join(dir, `2026-08-10T00-00-00-050Z_bubble-anchor-${uid()}.jsonl`);
  fs.writeFileSync(fn, `${lines.join('\n')}\n`);
  return fn;
}

function spawnBg(cmd, args, env, log) {
  return spawn(cmd, args, {
    cwd: PRODUCT_ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
  });
}

function killProc(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

async function waitHttp(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await delay(500);
    try {
      const code = await new Promise((resolve, reject) => {
        const req = http.get(url, (r) => {
          r.resume();
          resolve(r.statusCode);
        });
        req.on('error', reject);
        req.setTimeout(1500, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      if (code === 200) return;
    } catch {}
  }
  throw new Error(`${label} did not come up`);
}

async function openSession(page, baseUrl) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sf-pl-item', { timeout: 60000, state: 'attached' });
  await page.locator('.sf-pl-item').first().click({ force: true });
  await page.waitForSelector('.chat-messages .chat-work-head', { timeout: 20000 });
  await delay(1200);
  return errors;
}

const headTop = (page, nth) =>
  page.evaluate((i) => {
    const e = document.querySelectorAll('.chat-messages .chat-work-head')[i];
    return e ? e.getBoundingClientRect().top : null;
  }, nth);

const headCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.chat-messages .chat-work-head').length);

async function streamChunks(emit, file, chunks, streamId) {
  emit('session_status', file, { status: 'running' });
  let text = '';
  for (let i = 1; i <= chunks; i++) {
    text += `chunk ${i} — some flowing generated prose that wraps around a couple of lines.\n\n`;
    emit('message', file, {
      id: streamId,
      role: 'assistant',
      text,
      ts: Date.now(),
    });
    await delay(90);
  }
  emit('message', file, {
    id: streamId,
    role: 'assistant',
    text,
    toolCalls: [{ id: `live-call-${streamId}`, name: 'read', args: '{ "path": "/tmp/live.ts" }' }],
    ts: Date.now(),
    stopReason: 'stop',
  });
  emit('session_status', file, { status: 'idle' });
  await delay(500);
}

async function runPass(browser, baseUrl, file, emit, label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await openSession(page, baseUrl);

  const heads0 = await headCount(page);
  if (heads0 < 3) throw new Error(`${label}: expected seeded work heads, found ${heads0}`);

  await page.evaluate(() => {
    const e = document.querySelector('.chat-messages');
    const head = document.querySelectorAll('.chat-messages .chat-work-head')[1];
    e.scrollTop = head.getBoundingClientRect().top - e.getBoundingClientRect().top - 160;
  });
  await delay(300);

  const before1 = await headTop(page, 1);
  await page.locator('.chat-messages .chat-work-head').nth(1).click({ force: true });
  await delay(300);
  const after1 = await headTop(page, 1);
  const expandShift = Math.abs(after1 - before1);

  const before2 = after1;
  await streamChunks(emit, file, 18, 'live-a');
  const after2 = await headTop(page, 1);
  const streamDrift = Math.abs(after2 - before2);

  await page.locator('.chat-messages .chat-work-head').nth(1).click({ force: true });
  await delay(300);
  const after3 = await headTop(page, 1);
  const collapseShift = Math.abs(after3 - after2);
  const bodyGone = await page.evaluate(() => {
    const head = document.querySelectorAll('.chat-messages .chat-work-head')[1];
    const group = head.closest('.chat-work');
    return !group.querySelector('.chat-work-body');
  });

  await page.evaluate(() => {
    const e = document.querySelector('.chat-messages');
    e.scrollTop = e.scrollHeight;
  });
  await delay(400);
  const lastIdx = (await headCount(page)) - 1;
  const before4 = await headTop(page, lastIdx);
  await page.locator('.chat-messages .chat-work-head').nth(lastIdx).click({ force: true });
  await delay(300);
  const after4 = await headTop(page, lastIdx);
  const bottomExpandShift = Math.abs(after4 - before4);

  await streamChunks(emit, file, 10, 'live-b');
  const after5 = await headTop(page, lastIdx);
  const bottomStreamDrift = Math.abs(after5 - after4);
  await page.close();

  return {
    expandShift,
    streamDrift,
    collapseShift,
    bodyGone,
    bottomExpandShift,
    bottomStreamDrift,
    errors,
  };
}

(async () => {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };

  fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const stub = writeStubClient(RUN_ROOT);
  const file = seedSession();
  const backendPort = await freePort();
  const vitePort = await freePort();
  console.log(`stack: backend :${backendPort} vite :${vitePort}`);

  const procs = [];
  let browser = null;
  try {
    procs.push(
      spawnBg(
        'node',
        ['src/pi-studio/server/index.mjs'],
        {
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        '/tmp/bubble-anchor-backend.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnBg(
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
        { PI_API_PROXY: `http://127.0.0.1:${backendPort}` },
        '/tmp/bubble-anchor-vite.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch({ args: ['--force-device-scale-factor=1.25'] });
    const r = await runPass(browser, `http://127.0.0.1:${vitePort}`, file, stub.emit, 'dsf125');
    report(
      'T1 expanding a mid-history bubble holds the header in place',
      r.expandShift <= MOVE_EPS,
      `shift=${Math.round(r.expandShift * 1000) / 1000}px (limit ${MOVE_EPS}px)`,
    );
    report(
      'T2 live streaming does not yank an expanded bubble',
      r.streamDrift <= MOVE_EPS,
      `drift=${Math.round(r.streamDrift * 1000) / 1000}px (limit ${MOVE_EPS}px)`,
    );
    report(
      'T3 collapsing holds position and removes the body',
      r.collapseShift <= MOVE_EPS && r.bodyGone,
      `shift=${Math.round(r.collapseShift * 1000) / 1000}px bodyGone=${r.bodyGone}`,
    );
    report(
      'T4 expanding the bottom bubble at sticky view holds it in place',
      r.bottomExpandShift <= MOVE_EPS,
      `shift=${Math.round(r.bottomExpandShift * 1000) / 1000}px`,
    );
    report(
      'T5 streaming while bottom bubble is expanded does not yank it',
      r.bottomStreamDrift <= MOVE_EPS,
      `drift=${Math.round(r.bottomStreamDrift * 1000) / 1000}px`,
    );
    report('T6 no page errors', r.errors.length === 0, r.errors.join(' | ').slice(0, 200));
  } catch (e) {
    report('suite completed', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) killProc(p);
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
