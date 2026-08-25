const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const ISOLATED_ROOT = '/tmp/mobopen-check-sessions';
const TEST_DIR_NAME = '--tmp-mobopen-check--';
const TEST_SESSIONS_DIR = path.join(ISOLATED_ROOT, TEST_DIR_NAME);
const TEST_STATES_PATH = '/tmp/mobopen-check-states.json';
const TEST_CWD = '/tmp/mobopen-check';

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

async function pickPorts() {
  const backend = Number(process.env.MOBOPEN_BACKEND_PORT) || (await freePort());
  const vite = Number(process.env.MOBOPEN_VITE_PORT) || (await freePort());
  return { backend, vite };
}

function writeSessions() {
  fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
  const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
  const sessionFile = (name, turns, ageMs) => {
    const lines = [];
    const id = uid();
    const base = 1786342000000;
    lines.push(
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        parentId: null,
        timestamp: new Date(base).toISOString(),
        cwd: TEST_CWD,
      }),
    );
    let prev = id;
    let n = 0;
    for (let t = 0; t < turns; t++) {
      n += 1;
      const umid = `u${n}`;
      lines.push(
        JSON.stringify({
          type: 'message',
          id: umid,
          parentId: prev,
          timestamp: new Date(base + n * 60000).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `${name}: question ${t + 1}` }],
            timestamp: base + n * 60000,
          },
        }),
      );
      prev = umid;
      n += 1;
      const amid = `a${n}`;
      lines.push(
        JSON.stringify({
          type: 'message',
          id: amid,
          parentId: umid,
          timestamp: new Date(base + n * 60000 + 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Answer ${t + 1} for ${name}` }],
            timestamp: base + n * 60000 + 1000,
            ...(t === turns - 1 ? { stopReason: 'stop' } : {}),
          },
        }),
      );
      prev = amid;
    }
    const fn = path.join(
      TEST_SESSIONS_DIR,
      `2026-08-10T00-00-00-${String(turns).padStart(3, '0')}Z_${name.toLowerCase()}-${uid()}.jsonl`,
    );
    fs.writeFileSync(fn, `${lines.join('\n')}\n`);
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(fn, old, old);
  };
  sessionFile('Mob-A', 3, 10_000);
  sessionFile('Mob-B', 2, 120_000);
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

async function waitHttp(url, label, tries = 40) {
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
}

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

(async () => {
  const { report, isFailed } = makeReporter();
  const procs = [];
  const cleanup = () => {
    for (const p of procs) killProc(p);
    fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
    fs.rmSync(TEST_STATES_PATH, { force: true });
  };

  let browser;
  try {
    const ports = await pickPorts();
    console.log(`stack: backend :${ports.backend} vite :${ports.vite}`);
    writeSessions();
    fs.rmSync(TEST_STATES_PATH, { force: true });

    procs.push(
      spawnBg(
        'node',
        ['src/pi-studio/server/index.mjs'],
        {
          PI_STUDIO_PORT: String(ports.backend),
          PI_STUDIO_SESSIONS: ISOLATED_ROOT,
          PI_STUDIO_DB_PATH: path.join(ISOLATED_ROOT, 'studio.db'),
          PI_STUDIO_STATES_PATH: TEST_STATES_PATH,
          PI_STUDIO_CWD: TEST_CWD,
        },
        '/tmp/mobopen-check-backend.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${ports.backend}/api/health`, 'backend');
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
          String(ports.vite),
        ],
        { PI_API_PROXY: `http://127.0.0.1:${ports.backend}` },
        '/tmp/mobopen-check-vite.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${ports.vite}/`, 'vite');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${ports.vite}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-root--mobile', { timeout: 60000 });

    const mobilePanel = page.locator('.sf-mobile-panel');
    const historyItems = page.locator('[data-sub-body="history"] .chat-list-item');
    const mobileBarLabel = () => page.locator('.sf-mobile-tab-label').textContent();

    report(
      'mobile mode: menu bar hidden, bottom docker shown',
      (await page.locator('.sf-menu-bar').count()) === 0 &&
        (await page.locator('.sf-docker--bottom').count()) === 1,
    );

    await page.locator('.sf-docker-app[title="Chat"]').click();
    await page.waitForSelector('[data-sub-body="history"] .chat-list-item', { timeout: 60000 });
    report(
      'chat panel opens fullscreen with the history list',
      (await mobilePanel.isVisible()) && (await historyItems.count()) >= 2,
    );

    await historyItems.first().click();
    await page.waitForSelector('.sf-root .chat-messages', { timeout: 30000 });
    await delay(500);
    report(
      'tapping a chat history item opens the chat window',
      (await page.locator('.chat-messages').count()) === 1,
    );
    report('…and the panel closes at once', (await mobilePanel.count()) === 0);
    const label1 = String(await mobileBarLabel());
    report('…and the opened chat becomes the active tab', label1.includes('Mob-A'), `label=${label1}`);

    await page.locator('.sf-docker-app[title="Chat"]').click();
    await page.waitForSelector('[data-sub-body="history"] .chat-list-item', { timeout: 30000 });
    await page.locator('.sf-subsection-util[title="New Chat (Ctrl+N)"]').click();
    await page.waitForSelector('.sf-root .chat-messages', { timeout: 30000 });
    await delay(500);
    report('tapping New Chat creates a chat window', String(await mobileBarLabel()).includes('New Chat'));
    report('…and the panel closes at once', (await mobilePanel.count()) === 0);

    await page.setViewportSize({ width: 1440, height: 844 });
    await page.waitForSelector('.sf-menu-bar', { timeout: 15000 });
    await delay(400);
    const desktopItem = page.locator('[data-sub-body="history"] .chat-list-item:has-text("Mob-B")');
    await desktopItem.first().click();
    await delay(600);
    report(
      'desktop: tapping a history item opens it but keeps the left panel open',
      (await page.locator('.sf-left-group').isVisible()) &&
        (await page.locator('[data-sub-body="history"]').isVisible()),
    );

    report('no console/page errors', errors.length === 0, errors.join('; '));

    if (isFailed()) process.exitCode = 1;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    cleanup();
  }
})();
