const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ISOLATED_ROOT = '/tmp/drafts-check-sessions';
const TEST_STATES_PATH = '/tmp/drafts-check-states.json';
const TEST_CWD = '/tmp/drafts-check';

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

function spawnBg(cmd, args, env, logFile) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  child.stderr?.pipe(fs.createWriteStream(logFile));
  return child;
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

function writeSession() {
  fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  const dir = path.join(ISOLATED_ROOT, '--drafts-check--');
  fs.mkdirSync(dir, { recursive: true });
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const base = 1786342000000;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date(base).toISOString(),
      cwd: TEST_CWD,
    }),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: id,
      timestamp: new Date(base + 60000).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Drafts-A: question' }],
        timestamp: base + 60000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: new Date(base + 61000).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Drafts-A: answer' }],
        timestamp: base + 61000,
        stopReason: 'stop',
      },
    }),
  ];
  const file = `2026-08-10T00-00-00-001Z_drafts-a-${id}.jsonl`;
  fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
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
    const backend = await freePort();
    const vite = await freePort();
    console.log(`stack: backend :${backend} vite :${vite}`);
    writeSession();
    fs.rmSync(TEST_STATES_PATH, { force: true });

    procs.push(
      spawnBg(
        'node',
        ['src/pi-studio/server/index.mjs'],
        {
          PI_STUDIO_PORT: String(backend),
          PI_STUDIO_SESSIONS: ISOLATED_ROOT,
          PI_STUDIO_STATES_PATH: TEST_STATES_PATH,
          PI_STUDIO_CWD: TEST_CWD,
        },
        '/tmp/drafts-check-backend.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${backend}/api/health`, 'backend');
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
          String(vite),
        ],
        { PI_API_PROXY: `http://127.0.0.1:${backend}` },
        '/tmp/drafts-check-vite.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${vite}/`, 'vite');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${vite}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-list-item', { timeout: 60000 });
    await delay(1500);

    await page.locator('.chat-list-item').first().click({ force: true });
    await page.waitForSelector('.chat-input', { timeout: 20000 });
    await delay(1500);

    const DRAFT_A = 'draft alpha xyzzy';
    const DRAFT_B = 'draft beta quux';
    const wsName = `Drafts WS ${Date.now()}`;

    await page.fill('.chat-input', DRAFT_A);
    await delay(800);

    const storedA = await page.evaluate(() => {
      const dedicated = JSON.parse(localStorage.getItem('sf-chat:drafts') || 'null');
      const ui = JSON.parse(localStorage.getItem('sf.ui.state') || '{}').values ?? {};
      return { dedicated, uiHasDrafts: 'app.chat.drafts' in ui, uiValues: ui };
    });
    report(
      'draft is stored in the dedicated sf-chat:drafts key',
      storedA.dedicated !== null && Object.values(storedA.dedicated).includes(DRAFT_A),
    );
    report('ui store has no drafts key', !storedA.uiHasDrafts);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-input', { timeout: 20000 });
    await delay(2000);
    const afterReload = await page.inputValue('.chat-input');
    report('draft survives a page refresh', afterReload === DRAFT_A, `"${afterReload}"`);

    const wsPanelVisible = async () => {
      const el = await page.$('.sf-ws-panel');
      return el !== null && (await el.isVisible());
    };
    while (!(await wsPanelVisible())) {
      await page.click('.sf-docker-app[title="Workspace"]');
      await delay(400);
    }
    await page.fill('.sf-ws-save .sf-ws-input', wsName);
    await page.click('.sf-ws-save .sf-ws-btn--primary');
    await delay(500);

    const snapshotCheck = await page.evaluate(
      ({ name, draftA }) => {
        const list = JSON.parse(localStorage.getItem('sf.workspaces') || '[]');
        const item = list.find((w) => w.name === name);
        const raw = JSON.stringify(item ?? null);
        const liveUi = JSON.parse(localStorage.getItem('sf.ui.state') || '{}').values ?? {};
        return {
          found: !!item,
          uiHasDrafts: !!item && 'app.chat.drafts' in (item.snapshot?.ui ?? {}),
          rawContainsDraftA: raw.includes(draftA),
          liveUiHasDrafts: 'app.chat.drafts' in liveUi,
        };
      },
      { name: wsName, draftA: DRAFT_A },
    );
    report('saved workspace exists', snapshotCheck.found);
    report(
      'mandatory rule: snapshot ui block has no drafts key',
      snapshotCheck.uiHasDrafts === false && snapshotCheck.liveUiHasDrafts === false,
    );
    report(
      'draft text appears nowhere in the saved workspace json',
      snapshotCheck.rawContainsDraftA === false,
    );

    const backToComposer = async () => {
      for (let i = 0; i < 6; i++) {
        const el = await page.$('.chat-input');
        if (el && (await el.isVisible())) return;
        await page.keyboard.press('Escape');
        await page
          .locator('.sf-docker-app[title="Chat"]')
          .click()
          .catch(() => {});
        await delay(500);
      }
    };
    await backToComposer();
    await page.fill('.chat-input', DRAFT_B);
    await delay(800);

    while (!(await wsPanelVisible())) {
      await page.click('.sf-docker-app[title="Workspace"]');
      await delay(400);
    }
    await page
      .locator('.sf-ws-item', { hasText: wsName })
      .locator('.sf-ws-btn[title="Load this workspace"]')
      .click();
    await delay(800);
    await backToComposer();
    const afterLoad = await page.inputValue('.chat-input');
    report('loading a workspace leaves the current draft untouched', afterLoad === DRAFT_B, `"${afterLoad}"`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-input', { timeout: 20000 });
    await delay(2000);
    const afterLoadReload = await page.inputValue('.chat-input');
    report(
      'draft still survives refresh after a workspace load',
      afterLoadReload === DRAFT_B,
      `"${afterLoadReload}"`,
    );

    report('no console/page errors', errors.length === 0, errors.join('; ').slice(0, 300));
  } finally {
    if (browser) await browser.close();
    cleanup();
  }

  if (isFailed()) {
    console.log('\nDRAFTS CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL DRAFTS CHECKS PASSED');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
