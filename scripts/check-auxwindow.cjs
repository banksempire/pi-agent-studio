const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const ISOLATED_ROOT = '/tmp/aux-check-sessions';
const TEST_SESSIONS_DIR = path.join(ISOLATED_ROOT, '--tmp-aux-check--');
const TEST_STATES_PATH = '/tmp/aux-check-states.json';
const TEST_CWD = '/tmp/aux-check';
const IMG_DIR = '/tmp/aux-check-imgs';
const BACKEND_LOG = '/tmp/aux-check-backend.log';
const VITE_LOG = '/tmp/aux-check-vite.log';

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
  const backend = await freePort();
  const vite = await freePort();
  return { backend, vite };
}

function writeSessions() {
  fs.rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
  const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
  const sessionFile = (name, turns) => {
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
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `u${n}`,
          parentId: prev,
          timestamp: new Date(base + n * 60000).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `${name}: question ${t + 1}` }],
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
          timestamp: new Date(base + n * 60000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `${name}: answer ${t + 1}` }],
            timestamp: base + n * 60000,
          },
        }),
      );
      prev = `a${n}`;
    }
    fs.writeFileSync(path.join(TEST_SESSIONS_DIR, `${id}.jsonl`), lines.join('\n') + '\n');
  };
  sessionFile('AuxWin-A:', 3);
  sessionFile('AuxWin-B:', 2);
}

function writeTestImages() {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.mkdirSync(TEST_CWD, { recursive: true });
  fs.writeFileSync(TEST_STATES_PATH, JSON.stringify({}));
}

const procs = [];

function spawnBg(cmd, args, env, log) {
  const child = spawn(cmd, args, {
    cwd: PRODUCT_ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
  });
  procs.push(child);
  return child;
}

async function waitHttp(url, label) {
  for (let i = 0; i < 60; i++) {
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
      if (code < 500) return;
      return;
    } catch {}
  }
  throw new Error(`${label} never came up`);
}

(async () => {
  const backend = await freePort();
  const vite = await freePort();
  writeSessions();
  writeTestImages();
  procs.push(
    spawnBg(
      'node',
      ['src/pi-studio/server/index.mjs'],
      {
        PI_STUDIO_PORT: String(backend),
        PI_STUDIO_SESSIONS: ISOLATED_ROOT,
        PI_STUDIO_DB_PATH: path.join(ISOLATED_ROOT, 'studio.db'),
        PI_STUDIO_STATES_PATH: TEST_STATES_PATH,
        PI_STUDIO_CWD: TEST_CWD,
      },
      BACKEND_LOG,
    ),
  );
  await waitHttp(`http://127.0.0.1:${backend}/api/health`, 'backend');
  procs.push(
    spawnBg(
      'node',
      ['node_modules/.bin/vite', '--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(vite)],
      { PI_API_PROXY: `http://127.0.0.1:${backend}` },
      VITE_LOG,
    ),
  );
  await waitHttp(`http://127.0.0.1:${vite}/`, 'vite');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const wire = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
  };
  wire(page);
  page.context().on('page', wire);

  let pass = 0;
  const fails = [];
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) fails.push(name);
    else pass += 1;
  };

  try {
    await page.goto(`http://127.0.0.1:${vite}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-pl-item', { timeout: 60000 });
    await page.waitForSelector('.sf-pl-item:has-text("AuxWin-A:")', { state: 'attached', timeout: 20000 });
    await delay(2000);

    await page.locator('.sf-pl-item:has-text("AuxWin-A:")').first().click({ force: true });
    await page.waitForSelector('.chat-messages', { timeout: 20000 });
    await delay(1500);
    const rows = await page.evaluate(
      () => document.querySelector('.chat-messages')?.querySelectorAll('.chat-msg').length ?? 0,
    );
    report('session tab opens in the main window with messages', rows > 0, `rows=${rows}`);

    const popupPromise = page.context().waitForEvent('page');
    const dragged = await page.evaluate(() => {
      const tab = document.querySelector('.sf-tab');
      if (!tab) return false;
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, screenX: 1000, screenY: 300 }));
      return true;
    });
    report('drag dispatch found the chat tab', dragged === true);
    const aux = await popupPromise;
    await aux.waitForSelector('[data-test="aux-content"] .chat-messages', { timeout: 8000 });
    report('popup hosts the chat tab inside the full shell', true);
    report(
      'popup shell: menu bar, docker, panels, no status bar',
      (await aux.locator('.sf-menu-bar').count()) === 1 &&
        (await aux.locator('.sf-docker').count()) === 1 &&
        (await aux.locator('.sf-status-bar').count()) === 0,
    );

    await aux.evaluate(() => {
      window.__auxChatPosts = 0;
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, init) => {
        if (typeof url === 'string' && url.includes('/api/chat')) {
          window.__auxChatPosts += 1;
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        return realFetch(url, init);
      };
    });
    const input = aux.locator('.chat-input').first();
    await input.click({ force: true });
    await input.fill('hello from the popup window');
    await input.press('Enter');
    await delay(1200);
    const popupText = await aux.evaluate(() => document.querySelector('.chat-messages')?.textContent ?? '');
    report(
      'composer works inside the popup (message echo)',
      popupText.includes('hello from the popup window'),
    );

    await aux.evaluate(() => {
      const tab = document.querySelector('.sf-tab');
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
    });
    const mainBox = await page.locator('.sf-tile').first().boundingBox();
    await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const dt = new DataTransfer();
        el.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, clientX: x, clientY: y, dataTransfer: dt }),
        );
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: x, clientY: y, dataTransfer: dt }));
      },
      { x: Math.round(mainBox.x + mainBox.width / 2), y: Math.round(mainBox.y + mainBox.height / 2) },
    );
    await page.waitForSelector('.sf-tile .chat-messages', { timeout: 5000 });
    await delay(800);
    const chatBack = await page.evaluate(() => {
      const tile = document.querySelector('.sf-tile');
      return tile ? tile.querySelectorAll('.chat-msg').length : -1;
    });
    report(
      'dropping the popup tab onto the main workspace reattaches the chat',
      chatBack > 0,
      `rows=${chatBack}`,
    );

    if (errors.length > 0) report('no page errors on any window', false, errors.join(' | ').slice(0, 300));
    else report('no page errors on any window', true);
  } catch (e) {
    report('suite completed', false, String(e).slice(0, 300));
  } finally {
    await browser.close().catch(() => {});
    for (const child of procs) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
    console.log(
      `${fails.length === 0 ? 'ALL PAS PAS-AUXWINDOW CHECKS PASSED' : 'PAS AUX-WINDOW CHECKS FAILED'} (${pass} passed)`,
    );
    if (fails.length > 0) {
      console.log('FAILED:', fails.join(' | '));
      process.exit(1);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
