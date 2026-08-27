const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = '/tmp/stream-scroll-check';
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');

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
  fs.closeSync(fd);
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
      cwd: '/tmp/stream-scroll-cwd',
    }),
  ];
  let prev = id;
  let n = 0;
  for (let t = 0; t < 25; t++) {
    n += 1;
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `u${n}`,
        parentId: prev,
        timestamp: new Date(base + n * 60000).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: `question ${n} — ${'padding for a taller row '.repeat(10)}` }],
          timestamp: base + n * 60000,
        },
      }),
    );
    prev = `u${n}`;
    n += 1;
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `a${n}`,
        parentId: prev,
        timestamp: new Date(base + n * 60000 + 1000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Answer ${n} — ${'reply padding text '.repeat(12)}` }],
          timestamp: base + n * 60000 + 1000,
          stopReason: 'stop',
        },
      }),
    );
    prev = `a${n}`;
  }
  const fn = path.join(dir, `2026-08-10T00-00-00-050Z_stream-scroll-${uid()}.jsonl`);
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

const MAX_JUMP_PX = 1;
const MAX_MOVING_RATIO = 0.05;
const MAX_DRIFT_PX = 0.8;
const MOVE_EPS = MAX_JUMP_PX;

async function runPass(browser, baseUrl, file, emit, label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-list-item', { timeout: 60000, state: 'attached' });
  await page.locator('.chat-list-item').first().click({ force: true });
  await page.waitForSelector('.chat-messages .chat-group', { timeout: 20000 });
  await delay(1500);

  const max = await page.evaluate(() => {
    const e = document.querySelector('.chat-messages');
    return e.scrollHeight - e.clientHeight;
  });
  if (!(max > 100)) throw new Error(`${label}: session list does not overflow (max=${max})`);
  await page.evaluate((m) => {
    document.querySelector('.chat-messages').scrollTop = -Math.round(m * 0.5);
  }, max);
  await delay(400);

  await page.evaluate(() => {
    window.__frames = [];
    window.__sampling = true;
    const step = () => {
      const e = document.querySelector('.chat-messages');
      if (!e || !window.__sampling) return;
      const elTop = e.getBoundingClientRect().top;
      const rows = [...e.querySelectorAll('.chat-group')];
      window.__frames.push({
        sh: e.scrollHeight,
        tops: rows.map((r) => Math.round((r.getBoundingClientRect().top - elTop) * 1000) / 1000),
      });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  emit('session_status', file, { status: 'running' });
  let text = '';
  for (let i = 1; i <= 30; i++) {
    text += `chunk ${i} — some flowing generated prose that wraps around a couple of lines.\n\n`;
    emit('message', file, { id: `live-${label}`, role: 'assistant', text, ts: Date.now() });
    await delay(80);
  }
  emit('message', file, { id: `live-${label}`, role: 'assistant', text, ts: Date.now(), stopReason: 'stop' });
  emit('session_status', file, { status: 'idle' });
  await delay(700);
  await page.evaluate(() => {
    window.__sampling = false;
  });

  const frames = await page.evaluate(() => window.__frames);
  await page.close();

  const firstGrowth = frames.findIndex((f, i) => i > 0 && f.sh > frames[i - 1].sh);
  let pairs = 0;
  let moved = 0;
  let worst = 0;
  for (let i = firstGrowth + 2; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (b.sh === a.sh || !a.tops.length || !b.tops.length) continue;
    pairs += 1;
    const n = Math.min(a.tops.length, b.tops.length);
    let frameMoved = false;
    for (let k = 0; k < n; k++) {
      const d = Math.abs(b.tops[k] - a.tops[k]);
      if (d > MOVE_EPS) frameMoved = true;
      if (d > worst) worst = d;
    }
    if (frameMoved) moved += 1;
  }
  const movingRatio = pairs ? moved / pairs : 1;
  if (process.env.STREAM_SCROLL_DEBUG) {
    const amps = [];
    for (let i = firstGrowth + 2; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (b.sh === a.sh || !a.tops.length || !b.tops.length) continue;
      const n = Math.min(a.tops.length, b.tops.length);
      let worstF = 0;
      for (let k = 0; k < n; k++) worstF = Math.max(worstF, Math.abs(b.tops[k] - a.tops[k]));
      amps.push(Math.round(worstF * 1000) / 1000);
    }
    console.log(`    [debug ${label}] amps:`, amps.join(' '));
  }
  const alive = frames.filter((f) => f.tops.length);
  const first = alive[firstGrowth]?.tops ?? [];
  const last = alive[alive.length - 1]?.tops ?? [];
  let drift = 0;
  const n = Math.min(first.length, last.length);
  for (let k = 0; k < n; k++) drift = Math.max(drift, Math.abs(last[k] - first[k]));
  return { movingRatio, pairs, moved, worst, drift, frames: frames.length, errors };
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
  let browserA = null;
  let browserB = null;
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
        '/tmp/stream-scroll-backend.log',
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
        '/tmp/stream-scroll-vite.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');
    const baseUrl = `http://127.0.0.1:${vitePort}`;

    browserA = await chromium.launch({ args: ['--force-device-scale-factor=1.25'] });
    const r1 = await runPass(browserA, baseUrl, file, stub.emit, 'dsf125');
    report(
      'T1 streamed appends hold reading position at 125% scale (no gross jumps)',
      r1.movingRatio <= MAX_MOVING_RATIO && r1.errors.length === 0,
      `frames over ${MOVE_EPS}px: ${r1.moved}/${r1.pairs} (limit ${MAX_MOVING_RATIO}) errs=${r1.errors.length}`,
    );
    report(
      'T2 no cumulative drift over a 30-chunk stream at 125% scale',
      r1.drift < MAX_DRIFT_PX,
      `drift=${Math.round(r1.drift * 1000) / 1000}px limit=${MAX_DRIFT_PX}`,
    );

    browserB = await chromium.launch({ args: ['--force-device-scale-factor=1.1'] });
    const r2 = await runPass(browserB, baseUrl, file, stub.emit, 'dsf110');
    report(
      'T3 streamed appends hold reading position at 110% scale',
      r2.movingRatio <= MAX_MOVING_RATIO && r2.drift < MAX_DRIFT_PX && r2.errors.length === 0,
      `frames over ${MOVE_EPS}px: ${r2.moved}/${r2.pairs} drift=${Math.round(r2.drift * 1000) / 1000}px`,
    );
  } catch (e) {
    report('suite completed', false, e.message);
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
    for (const p of procs) killProc(p);
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
