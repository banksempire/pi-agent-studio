const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-card-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

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

const T0 = Date.parse('2026-09-21T06:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();

function seedSession(fileName, userText) {
  const dir = path.join(SESSIONS_ROOT, '2026-09-21');
  fs.mkdirSync(dir, { recursive: true });
  const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
  const id = uid();
  const entry = (n, extra) =>
    JSON.stringify({
      id: `${fileName}${n}`,
      parentId: n > 1 ? `${fileName}${n - 1}` : null,
      timestamp: ts(n),
      ...extra,
    });
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: ts(0), cwd: RUN_ROOT }),
    entry(1, {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: userText }], timestamp: T0 + 1000 },
    }),
    entry(2, {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Spawning the builder sub-agent now.' },
          { type: 'thinking', thinking: 'design contract ready' },
          { type: 'toolCall', id: `call-${fileName}`, name: 'subagent', arguments: { task: 'build it' } },
        ],
        timestamp: T0 + 2000,
        stopReason: 'toolUse',
      },
    }),
    entry(3, {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: `call-${fileName}`,
        toolName: 'subagent',
        isError: false,
        content: [{ type: 'text', text: 'earlier build finished' }],
        timestamp: T0 + 3000,
      },
    }),
  ];
  const file = path.join(dir, `${fileName}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function spawnBg(cmd, args, env, log) {
  return spawn(cmd, args, {
    cwd: PRODUCT_ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
  });
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

const partInfo = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.chat-messages .chat-agent-part'))
      .filter((el) => el.offsetHeight > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-part-id'), top: r.top, bottom: r.bottom };
      }),
  );

const groupHead = (page, gid) =>
  page.evaluate((id) => {
    const part = document.querySelector(`[data-part-id="${id}"]`);
    if (!part) return null;
    const head = part.querySelector('.chat-work-head');
    if (!head) return null;
    return {
      wip: !!head.querySelector('.chat-ab-dots'),
      text: head.textContent ?? '',
    };
  }, gid);

const cardState = (page, gid, idx) =>
  page.evaluate(
    ([id, i]) => {
      const part = document.querySelector(`[data-part-id="${id}"]`);
      if (!part) return null;
      const card = part.querySelectorAll('.chat-ab-sub')[i];
      if (!card) return null;
      return {
        ok: card.classList.contains('chat-ab-sub--ok'),
        fail: card.classList.contains('chat-ab-sub--fail'),
        name: card.querySelector('.chat-ab-sub-name')?.textContent ?? '',
        detail: card.querySelector('.chat-ab-result-body')?.textContent ?? '',
      };
    },
    [gid, idx],
  );

async function openCard(page, gid, idx) {
  await page.locator(`[data-part-id="${gid}"] .chat-work-head`).click({ force: true });
  await delay(200);
  await page.locator(`[data-part-id="${gid}"] .chat-ab-sub-head`).nth(idx).click({ force: true });
  await delay(200);
}

(async () => {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };

  assertMemoryHeadroom({ label: 'check-subagent-card' });
  sweepStaleStackProcesses('check-subagent-card:stack');
  const procs = [];
  installStackCleanup({
    procs,
    stamp: 'check-subagent-card:stack',
    browserRef: { current: null },
    label: 'check-subagent-card',
  });
  let browser = null;
  try {
    const stub = writeStubClient(RUN_ROOT);
    const liveFile = seedSession('live', 'kick off the build');
    seedSession('order', 'reload order probe');
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);

    procs.push(
      spawnStackProc(spawn, 'check-subagent-card:stack', 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/check-subagent-card-backend.log', 'a'),
          fs.openSync('/tmp/check-subagent-card-backend.log', 'a'),
        ],
      }),
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
        '/tmp/check-subagent-card-vite.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch({ args: ['--force-device-scale-factor=1.25'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-pl-item', { timeout: 60000, state: 'attached' });
    await page.locator('.sf-pl-item', { hasText: 'kick off the build' }).first().click({ force: true });
    await page.waitForSelector('.chat-messages .chat-work-head', { timeout: 20000 });
    await delay(800);

    stub.emit('session_status', liveFile, { status: 'running' });
    stub.emit('message', liveFile, {
      id: 'asst-live-1',
      role: 'assistant',
      text: 'Model name typo — retrying with the session default:',
      thinking: 'handing the full contract to the child',
      thinkings: ['handing the full contract to the child'],
      toolCalls: [{ id: 'call-live-1', name: 'subagent', args: '{\n "task": "build it"\n}' }],
      blocks: [
        { t: 'text', text: 'Model name typo — retrying with the session default:' },
        { t: 'think', i: 0 },
        { t: 'tool', i: 0 },
      ],
      ts: Date.now(),
      stopReason: 'toolUse',
    });
    stub.emit('tool_start', liveFile, {
      toolCallId: 'call-live-1',
      toolName: 'subagent',
      args: { task: 'build it' },
    });
    stub.emit('tool_partial', liveFile, { toolCallId: 'call-live-1', text: '[task-1] queued' });
    await delay(150);
    stub.emit('tool_partial', liveFile, {
      toolCallId: 'call-live-1',
      text: '[task-1] queued\n[task-1] running\nthinking: shaping the patch',
    });
    await page.waitForFunction(() => !!document.querySelector('[data-part-id="work-asst-live-1"]'), null, {
      timeout: 20000,
    });
    await delay(400);
    await openCard(page, 'work-asst-live-1', 1);

    const runningCard = await cardState(page, 'work-asst-live-1', 1);
    report(
      'L1 running sub-agent card is not styled done while the tool streams',
      !!runningCard && runningCard.name === 'subagent' && !runningCard.ok && !runningCard.fail,
      JSON.stringify(runningCard),
    );
    const runningHead = await groupHead(page, 'work-asst-live-1');
    report(
      'L2 group header stays in running mode (dots, not "actions done")',
      !!runningHead && runningHead.wip && !runningHead.text.includes('actions done'),
      JSON.stringify(runningHead),
    );
    const partsA = await partInfo(page);
    const textPart = partsA.find((p) => p.id === 'asst-live-1:0');
    const groupPart = partsA.find((p) => p.id === 'work-asst-live-1');
    report(
      'L3 reply text renders above the sub-agent card (stream order)',
      !!textPart && !!groupPart && textPart.top < groupPart.top,
      JSON.stringify(partsA.map((p) => p.id)),
    );
    const maxBottom = Math.max(...partsA.map((p) => p.bottom));
    report(
      'L4 running sub-agent card is the last line of the transcript',
      !!groupPart && Math.abs(groupPart.bottom - maxBottom) < 2,
      JSON.stringify(partsA.map((p) => p.id)),
    );
    const feedCard = await cardState(page, 'work-asst-live-1', 1);
    report(
      'L5 live feed streams into the card while pending',
      !!feedCard &&
        feedCard.detail.includes('[task-1] running') &&
        feedCard.detail.includes('thinking: shaping the patch'),
      JSON.stringify(feedCard?.detail),
    );

    stub.emit('tool_result', liveFile, {
      toolCallId: 'call-live-1',
      toolName: 'subagent',
      text: 'stub sub-agent result: build it',
      isError: false,
    });
    await page.waitForFunction(
      () => {
        const part = document.querySelector('[data-part-id="work-asst-live-1"]');
        const card = part?.querySelectorAll('.chat-ab-sub')[1];
        return !!card && card.classList.contains('chat-ab-sub--ok');
      },
      null,
      { timeout: 20000 },
    );
    const doneHead = await groupHead(page, 'work-asst-live-1');
    report(
      'L6 finished tool card turns ok and the group closes as done',
      !!doneHead && !doneHead.wip && doneHead.text.includes('2 actions done'),
      JSON.stringify(doneHead),
    );

    stub.emit('message', liveFile, {
      id: 'asst-live-2',
      role: 'assistant',
      text: 'Build complete.',
      ts: Date.now(),
      stopReason: 'stop',
    });
    stub.emit('session_status', liveFile, { status: 'idle' });
    await delay(400);

    await page.locator('.sf-pl-item', { hasText: 'reload order probe' }).first().click({ force: true });
    await page.waitForFunction(() => !!document.querySelector('[data-part-id="work-order2"]'), null, {
      timeout: 20000,
    });
    await delay(600);
    await openCard(page, 'work-order2', 1);
    const partsB = await partInfo(page);
    const rText = partsB.find((p) => p.id === 'order2:0');
    const rGroup = partsB.find((p) => p.id === 'work-order2');
    report(
      'R1 persisted text-first assistant reloads with text above the tool card',
      !!rText && !!rGroup && rText.top < rGroup.top,
      JSON.stringify(partsB.map((p) => p.id)),
    );
    const rCard = await cardState(page, 'work-order2', 1);
    report(
      'R2 finished persisted sub-agent card renders done',
      !!rCard && rCard.ok && !rCard.fail,
      JSON.stringify(rCard),
    );
    report('F1 no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    const where = browser ? '' : ' (before browser launch)';
    report('suite completed', false, `${e instanceof Error ? e.message : String(e)}${where}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await delay(500);
    for (const p of procs) {
      try {
        if (p.exitCode === null) p.kill('SIGKILL');
      } catch {}
    }
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
