const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '..', 'package.json'))('playwright');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'new-chat-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STUB_STATE_DIR = path.join(RUN_ROOT, 'stub-state');
const BACKEND_LOG = '/tmp/new-chat-backend.log';
const VITE_LOG = '/tmp/new-chat-vite.log';
const STAMP = `new-chat-suite-${Date.now()}`;

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

async function getJson(port, p) {
  const res = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let raw = '';
      r.on('data', (c) => {
        raw += c;
      });
      r.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
  return res;
}

function writeRelease() {
  fs.writeFileSync(path.join(STUB_STATE_DIR, 'release'), '1');
}

function removeRelease() {
  fs.rmSync(path.join(STUB_STATE_DIR, 'release'), { force: true });
}

async function waitIdle(port, file) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await getJson(port, '/api/agent-states');
      const st = (r?.states ?? []).find((s) => s.agentId === file);
      if (st && st.status === 'idle') return true;
    } catch {}
    await delay(250);
  }
  return false;
}

(async () => {
  assertMemoryHeadroom({ label: 'new-chat' });
  sweepStaleStackProcesses(STAMP, { label: 'new-chat' });
  const { report, isFailed } = makeReporter();
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STAMP, browserRef, label: 'new-chat' });
  let browser;
  try {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
    fs.mkdirSync(path.join(SESSIONS_ROOT, '--workspace-sf--'), { recursive: true });
    fs.mkdirSync(STUB_STATE_DIR, { recursive: true });
    removeRelease();
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort} root ${RUN_ROOT}`);

    procs.push(
      spawnStackProc(spawn, STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_HOST: '127.0.0.1',
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_CWD: RUN_ROOT,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_SPILL_PATH: path.join(RUN_ROOT, 'spill.json'),
          PI_STUDIO_STATES_PATH: path.join(RUN_ROOT, 'states.json'),
          PI_STUDIO_DRAIN_MS: '3000',
          PI_SDK_DIR: STUB_SDK,
          STUB_STATE_DIR,
        },
        stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        STAMP,
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
          stdio: ['ignore', fs.openSync(VITE_LOG, 'a'), fs.openSync(VITE_LOG, 'a')],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-d-cta', { timeout: 60000 });
    await page.click('.welcome-d-cta');
    await page.waitForSelector('.chat-window', { timeout: 20000 });
    report('new chat CTA opens a chat window', true);

    const messageText = `new chat regression ${Date.now()}`;
    await page.locator('.chat-input').fill(messageText);
    await page.locator('.chat-send-btn:not(.chat-send-btn--stop):not(.chat-send-btn--queue)').click();

    const snap = () =>
      page.evaluate(() => {
        const empties = [...document.querySelectorAll('.chat-empty')].map((e) => e.textContent.trim());
        const block = document.querySelector('.chat-composer-block');
        const groups = [...document.querySelectorAll('.chat-group')].map((g) => g.textContent);
        return { empties, block: block ? block.textContent.trim() : null, groups };
      });

    let notFoundFlash = null;
    let composerBlock = null;
    let bubbleLost = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const s = await snap();
      const nf = s.empties.find((t) => t.includes('Session not found'));
      if (nf && notFoundFlash === null) notFoundFlash = nf;
      if (s.block && composerBlock === null) composerBlock = s.block;
      const kept = s.groups.some((t) => t.includes(messageText));
      if (!kept && bubbleLost === null) bubbleLost = 'user bubble vanished';
      if (notFoundFlash && composerBlock && bubbleLost) break;
      await delay(100);
    }
    report('no "Session not found" flash after first send', notFoundFlash === null, notFoundFlash ?? '');
    report('no composer block after first send', composerBlock === null, composerBlock ?? '');
    report('user message stays visible across the session upsert', bubbleLost === null, bubbleLost ?? '');

    let listed = null;
    for (let i = 0; i < 40; i++) {
      const r = await getJson(backendPort, '/api/sessions?limit=50').catch(() => null);
      const hit = (r?.sessions ?? []).find((x) => x.firstMessage.includes(messageText));
      if (hit) {
        listed = hit;
        break;
      }
      await delay(250);
    }
    report('created session reaches the server session list', !!listed, listed ? listed.file : 'not listed');

    const promptsLog = path.join(STUB_STATE_DIR, 'prompts.jsonl');
    let prompted = false;
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(promptsLog) && fs.readFileSync(promptsLog, 'utf8').includes(messageText)) {
        prompted = true;
        break;
      }
      await delay(250);
    }
    report('prompt reached the agent session', prompted);

    writeRelease();
    let file = listed?.file;
    if (!file) {
      for (let i = 0; i < 40 && !file; i++) {
        const r = await getJson(backendPort, '/api/sessions?limit=50').catch(() => null);
        file = (r?.sessions ?? []).find((x) => x.firstMessage.includes(messageText))?.file;
        if (!file) await delay(250);
      }
    }
    const idle = file ? await waitIdle(backendPort, file) : false;
    report('session settles after release', idle, file ?? 'no session file');

    let settledSnap = null;
    for (let i = 0; i < 40; i++) {
      settledSnap = await snap();
      if (
        !settledSnap.empties.some((t) => t.includes('Session not found')) &&
        settledSnap.groups.some((t) => t.includes(messageText))
      )
        break;
      await delay(250);
    }
    report(
      'chat window healthy after settle',
      !settledSnap.empties.some((t) => t.includes('Session not found')) &&
        settledSnap.groups.some((t) => t.includes(messageText)),
    );
    report('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } catch (e) {
    report('suite completed', false, String(e?.message ?? e));
  } finally {
    try {
      await browser?.close();
    } catch {}
    for (const p of procs) {
      if (!p || p.exitCode !== null) continue;
      try {
        p.kill('SIGTERM');
      } catch {}
    }
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(isFailed() ? 1 : 0);
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
