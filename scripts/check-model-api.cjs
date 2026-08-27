const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '..', 'package.json'))('playwright');
const { writeStubClient } = require('./lib/stub-backend.cjs');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-api-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

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

function waitHttp(url, label, tries = 40) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      await delay(500);
      try {
        const res = await new Promise((resolve, reject) => {
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
        if (res === 200) return true;
      } catch {}
    }
    throw new Error(`${label} did not come up`);
  })();
}

function writeSessionFile(name) {
  const dir = path.join(SESSIONS_ROOT, '--tmp-model-api--');
  fs.mkdirSync(dir, { recursive: true });
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      cwd: RUN_ROOT,
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-u0`,
      parentId: id,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `${name} q0` }], timestamp: Date.now() },
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-a0`,
      parentId: `${name}-u0`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${name} answer text` }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }),
  ];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const STUB_MODELS = [
  {
    id: 'stub-pro',
    provider: 'stub',
    name: 'Stub Pro',
    reasoning: true,
    contextWindow: 200000,
    thinkingLevels: ['off', 'low', 'high'],
  },
  {
    id: 'stub-mini',
    provider: 'stub',
    name: 'Stub Mini',
    reasoning: false,
    contextWindow: 100000,
    thinkingLevels: ['off'],
  },
];

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-model-api' });
  sweepStaleStackProcesses('check-model-api:stack');
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: 'check-model-api:stack', browserRef, label: 'check-model-api' });
  let browser;
  try {
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    const sessionFile = writeSessionFile('model-api-check');

    procs.push(
      spawnStackProc(spawn, 'check-model-api:stack', 'node', ['src/pi-studio/server/index.mjs'], {
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
          fs.openSync('/tmp/model-api-check-backend.log', 'a'),
          fs.openSync('/tmp/model-api-check-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        'check-model-api:stack',
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
          stdio: [
            'ignore',
            fs.openSync('/tmp/model-api-check-vite.log', 'a'),
            fs.openSync('/tmp/model-api-check-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('503')) errors.push(`console: ${m.text()}`);
    });

    const state = {
      currentId: 'stub-mini',
      currentName: 'Stub Mini',
      currentLevel: 'off',
      posts: [],
      gets: [],
    };
    await page.route('**/api/models*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        state.posts.push(body);
        if (body.model === 'stub/stub-pro' && body.thinkLevel === 'high') {
          state.currentId = 'stub-pro';
          state.currentName = 'Stub Pro';
          state.currentLevel = 'high';
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, notice: 'Model: stub/Stub Pro · Thinking: high' }),
        });
        return;
      }
      const file = url.searchParams.get('file');
      state.gets.push(file || '');
      const current = file ? (STUB_MODELS.find((m) => m.id === state.currentId) ?? null) : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: STUB_MODELS,
          default: STUB_MODELS[1],
          current,
          currentThinkingLevel: file ? state.currentLevel : null,
        }),
      });
    });

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker', { timeout: 60000 });

    const itemSel = '.chat-list-item:has-text("model-api-check")';
    await page.waitForSelector(itemSel, { timeout: 60000 });
    await delay(1000);
    await page.locator(itemSel).first().click({ force: true });
    await page.waitForSelector('.chat-msg', { timeout: 20000 });
    report('chat window opens with message content', true);

    await page.waitForSelector('.model-menu', { timeout: 10000 });
    const modelRow = (key) => page.locator(`.model-menu .kv-row:has(.kv-key:text-is("${key}")) .kv-value`);
    await modelRow('Model').waitFor({ timeout: 10000 });
    const beforeProvider = await modelRow('Provider').textContent();
    const beforeModel = await modelRow('Model').textContent();
    const beforeThinking = await modelRow('Thinking').textContent();
    report(
      'session model view loads from GET /api/models?file=',
      beforeProvider === 'stub' && beforeModel === 'Stub Mini' && beforeThinking === '(None)',
      `${beforeProvider}/${beforeModel}/${beforeThinking}`,
    );

    await page.locator('.model-menu-btn').click();
    await page.waitForSelector('.sf-menu-pop', { timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'stub' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'Stub Pro' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Stub Pro' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'high' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'high' }).click();
    await delay(500);

    const post = state.posts[state.posts.length - 1];
    report(
      'switching model POSTs provider/id + thinkLevel to /api/models',
      !!post && post.file === sessionFile && post.model === 'stub/stub-pro' && post.thinkLevel === 'high',
      post ? JSON.stringify({ model: post.model, thinkLevel: post.thinkLevel }) : 'no POST seen',
    );

    await modelRow('Model').filter({ hasText: 'Stub Pro' }).waitFor({ timeout: 10000 });
    const afterModel = await modelRow('Model').textContent();
    const afterThinking = await modelRow('Thinking').textContent();
    report(
      'picker reflects the applied model after POST',
      afterModel === 'Stub Pro' && afterThinking === 'high',
      `${afterModel}/${afterThinking}`,
    );

    const input = page.locator('.chat-input');
    await input.click();
    await input.fill('/');
    await delay(600);
    const completions = await page.locator('.chat-completions').count();
    const pickerOverlay = await page.locator('.chat-picker').count();
    report('typing / no longer opens a slash completion popup', completions === 0 && pickerOverlay === 0);

    await input.fill('/model stub/stub-pro');
    await input.press('Enter');
    await delay(800);
    const postsAfterSlash = state.posts.length;
    report(
      'slash text is sent as a plain message, not executed',
      postsAfterSlash === 1,
      `posts=${postsAfterSlash}`,
    );

    report('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (e) {
    console.error('check-model-api crashed:', e);
    process.exitCode = 1;
  } finally {
    if (browserRef.current) await browserRef.current.close().catch(() => {});
    for (const p of procs) {
      try {
        if (p.exitCode === null) process.kill(-p.pid, 'SIGTERM');
      } catch {}
    }
    await delay(500);
  }
  if (isFailed() || process.exitCode) process.exitCode = 1;
})();
