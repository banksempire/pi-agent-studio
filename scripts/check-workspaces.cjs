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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'workspaces-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const TEST_CWD = RUN_ROOT;
const STACK_STAMP = 'check-workspaces:stack';
const DB_PATH = path.join(RUN_ROOT, 'studio.db');
const PANEL = '[data-sub-body="ws-list"]';
const SAVE_BTN = '.sf-subsection-util[title="Save the current layout as a workspace"]';

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

function collectPageErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().startsWith('Failed to load resource')) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (r.url().endsWith('/api/events/heartbeat')) return;
    if (expectBackendOutage && r.status() >= 500 && r.url().includes('/api/')) return;
    errors.push(`http ${r.status()}: ${r.url()}`);
  });
}

let expectBackendOutage = false;

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

async function waitDown(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const up = await new Promise((resolve) => {
      const req = http.get(url, (r) => {
        r.resume();
        resolve(r.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (!up) return true;
    await delay(500);
  }
  return false;
}

function httpJson(base, path_, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: new URL(base).port,
        path: path_,
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    const mark = ok ? '✓' : '✗';
    if (!ok) failed = true;
    console.log(`${mark} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  };
  return {
    report,
    isFailed: () => failed,
  };
}

function killProc(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {}
}

async function openWsPanel(page) {
  for (let i = 0; i < 4; i++) {
    const el = await page.$(PANEL);
    if (el && (await el.isVisible())) return;
    await page.click('.sf-docker-app[title="Workspace"]');
    await delay(400);
  }
  throw new Error('workspace panel did not open');
}

async function itemMenu(page, name, option) {
  await page.locator(`${PANEL} .sf-pl-item`, { hasText: name }).first().click({ button: 'right' });
  await page.waitForSelector('.sf-sm-menu', { timeout: 5000 });
  await page.locator('.sf-sm-menu-row', { hasText: option }).first().click();
  await delay(400);
}

async function confirmDialog(page, action, mustInclude) {
  await page.waitForSelector('.sf-dialog', { timeout: 5000 });
  const text = (await page.locator('.sf-dialog').textContent()) ?? '';
  for (const needle of mustInclude) {
    if (!text.includes(needle)) {
      throw new Error(`confirm dialog does not mention "${needle}": ${text.slice(0, 200)}`);
    }
  }
  await page.locator('.sf-dialog-foot button', { hasText: action }).click();
  await delay(400);
}

const tileLabels = (page, i) => page.locator('.sf-tile').nth(i).locator('.sf-tab-label').allTextContents();

const tileTabsOf = (node, acc) => {
  if (!node) return acc;
  if (node.kind === 'tile') {
    acc.push(node.tabs);
    return acc;
  }
  tileTabsOf(node.children?.[0], acc);
  tileTabsOf(node.children?.[1], acc);
  return acc;
};

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-workspaces' });
  sweepStaleStackProcesses(STACK_STAMP);
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STACK_STAMP, browserRef, label: 'check-workspaces' });

  let browser;
  let backend;
  try {
    const backendPort = await freePort();
    const vite = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vite}`);
    const backendUrl = `http://127.0.0.1:${backendPort}`;
    const backendEnv = {
      ...process.env,
      PI_STUDIO_PORT: String(backendPort),
      PI_STUDIO_SESSIONS: SESSIONS_ROOT,
      PI_STUDIO_DB_PATH: DB_PATH,
      PI_STUDIO_STATES_PATH: path.join(RUN_ROOT, 'states.json'),
      PI_STUDIO_CWD: TEST_CWD,
      PI_SDK_DIR: STUB_SDK,
      STUB_STATE_DIR: path.join(RUN_ROOT, 'stub-state'),
    };

    const spawnBackend = () =>
      spawnStackProc(spawn, STACK_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: backendEnv,
        stdio: [
          'ignore',
          fs.openSync('/tmp/workspaces-check-backend.log', 'a'),
          fs.openSync('/tmp/workspaces-check-backend.log', 'a'),
        ],
      });

    backend = spawnBackend();
    procs.push(backend);
    await waitHttp(`${backendUrl}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        STACK_STAMP,
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
        {
          cwd: PRODUCT_ROOT,
          env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${backendPort}` },
          stdio: [
            fs.openSync('/tmp/workspaces-check-vite.log', 'a'),
            fs.openSync('/tmp/workspaces-check-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vite}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await contextA.addInitScript(() => {
      if (!sessionStorage.getItem('ws-mgmt-seen')) {
        sessionStorage.setItem('ws-mgmt-seen', '1');
        localStorage.clear();
      }
    });
    const page = await contextA.newPage();
    const errors = [];
    collectPageErrors(page, errors);
    await page.goto(`http://127.0.0.1:${vite}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker-app', { timeout: 60000 });
    await delay(1500);

    for (const label of ['Scheduled Jobs…', 'Model Catalog…']) {
      await page.locator('.sf-menu-item', { hasText: 'Chat' }).click();
      await page.locator('.sf-menu-row', { hasText: label }).waitFor({ timeout: 5000 });
      await page.locator('.sf-menu-row', { hasText: label }).click();
      await delay(1000);
    }
    const wsBox = await page.locator('.sf-workspace').boundingBox();
    await page.locator('.sf-tab:has-text("Scheduler")').dragTo(page.locator('.sf-workspace'), {
      targetPosition: { x: wsBox.width - 10, y: wsBox.height / 2 },
    });
    await delay(600);
    report(
      'arranged layout: two tiles (catalog + scheduler)',
      (await page.locator('.sf-tile').count()) === 2 &&
        (await tileLabels(page, 0)).length === 1 &&
        (await tileLabels(page, 1)).length === 1,
    );

    await openWsPanel(page);
    await page.click(SAVE_BTN);
    await page.waitForTimeout(600);
    report(
      'saving appends an auto-named workspace',
      (await page.locator(`${PANEL} .sf-pl-item`).count()) === 1,
    );
    const firstLabel = ((await page.locator(`${PANEL} .sf-pl-item .sf-pl-label`).textContent()) ?? '').trim();
    report('auto name follows the Workspace N scheme', /^Workspace \d+$/.test(firstLabel), firstLabel);
    const firstMeta = ((await page.locator(`${PANEL} .sf-pl-item .sf-pl-meta`).textContent()) ?? '').trim();
    report('workspace row carries a relative time meta', /ago|just now/.test(firstMeta), firstMeta);
    const firstDetail = (
      (await page.locator(`${PANEL} .sf-pl-item .sf-pl-detail`).textContent()) ?? ''
    ).trim();
    report(
      'workspace row summarizes tabs and tiles',
      /\d+ tabs? · \d+ tiles?/.test(firstDetail),
      firstDetail,
    );

    await itemMenu(page, firstLabel, 'Rename');
    await page.fill('#sf-ws-rename-input', 'Shared WS');
    await page.locator('.sf-dialog-foot button', { hasText: 'Save' }).click();
    await page.waitForTimeout(400);
    report(
      'rename via row menu applies',
      (await page.locator(`${PANEL} .sf-pl-item`, { hasText: 'Shared WS' }).count()) === 1,
    );

    const stored = await httpJson(backendUrl, '/api/workspaces');
    const entry = (stored.json?.workspaces ?? []).find((w) => w.name === 'Shared WS');
    report('W1 saved workspace is on the backend', !!entry, JSON.stringify(stored.json)?.slice(0, 200));

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      itemMenu(page, 'Shared WS', 'Export to file'),
    ]);
    const exportPath = path.join(RUN_ROOT, 'shared-ws-profile.json');
    await download.saveAs(exportPath);
    const envelope = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    report(
      'W1b exported profile carries the app identity and the saved snapshot',
      envelope.format === 'sf.workspace-profile' &&
        envelope.profileVersion === 1 &&
        envelope.app === 'pi-agent-studio' &&
        envelope.name === 'Shared WS' &&
        envelope.snapshot?.version === 1 &&
        Array.isArray(envelope.snapshot?.roots),
      JSON.stringify({ format: envelope.format, app: envelope.app }),
    );
    report(
      'W1 backend entry counts tiles and tabs',
      entry?.tiles === 2 && entry?.tabs === 2 && entry?.windows === 0,
      JSON.stringify(entry),
    );
    const full = entry ? await httpJson(backendUrl, `/api/workspaces/${encodeURIComponent(entry.id)}`) : null;
    const snap = full?.json?.workspace?.snapshot;
    report(
      'W2 stored snapshot is a refresh-shaped workspace snapshot',
      snap?.version === 1 && Array.isArray(snap?.roots) && snap?.roots?.length === 2,
    );
    const storedTabSets = [];
    for (const r of snap?.roots ?? []) tileTabsOf(r.node, storedTabSets);
    report(
      'W2 stored snapshot keeps both tab ids',
      storedTabSets.length === 2 && storedTabSets.every((t) => t.length === 1),
      JSON.stringify(storedTabSets),
    );

    const badCreate = await httpJson(backendUrl, '/api/workspaces', {
      method: 'POST',
      body: { name: 'Broken', snapshot: { version: 2, roots: [] } },
    });
    report('W3 backend rejects an invalid snapshot', badCreate.status === 400, `status=${badCreate.status}`);
    const badRename = entry
      ? await httpJson(backendUrl, `/api/workspaces/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          body: { name: '   ' },
        })
      : null;
    report('W4 backend rejects a blank rename', badRename?.status === 400, `status=${badRename?.status}`);

    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await contextB.addInitScript(() => {
      if (!sessionStorage.getItem('ws-mgmt-seen')) {
        sessionStorage.setItem('ws-mgmt-seen', '1');
        localStorage.clear();
      }
    });
    const pageB = await contextB.newPage();
    collectPageErrors(pageB, errors);
    await pageB.goto(`http://127.0.0.1:${vite}`, { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('.sf-docker-app', { timeout: 60000 });
    await delay(1200);
    await openWsPanel(pageB);
    const seenByB = await pageB.locator(`${PANEL} .sf-pl-item`, { hasText: 'Shared WS' }).count();
    report('W5 a second browser sees the saved workspace (backend-side state)', seenByB === 1);

    await pageB.locator(`${PANEL} .sf-pl-item`, { hasText: 'Shared WS' }).click();
    await delay(1000);
    report(
      'W6 loading in the second browser restores the two-tile layout',
      (await pageB.locator('.sf-tile').count()) === 2 &&
        (await tileLabels(pageB, 0)).length === 1 &&
        (await tileLabels(pageB, 1)).length === 1,
    );

    const autoB = await pageB.evaluate(() =>
      JSON.parse(localStorage.getItem('sf.workspace.layout') || 'null'),
    );
    const liveTabsB = [];
    for (const r of autoB?.roots ?? []) tileTabsOf(r.node, liveTabsB);
    report(
      'W7 state after load equals the saved snapshot (tab ids per tile — same capture code as refresh)',
      JSON.stringify(liveTabsB) === JSON.stringify(storedTabSets),
      `live=${JSON.stringify(liveTabsB)} stored=${JSON.stringify(storedTabSets)}`,
    );

    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await delay(1800);
    report(
      'W7b the loaded layout survives a refresh of the second browser',
      (await pageB.locator('.sf-tile').count()) === 2 &&
        (await tileLabels(pageB, 0)).length === 1 &&
        (await tileLabels(pageB, 1)).length === 1,
    );

    await pageB.locator('.sf-tile').nth(1).locator('.sf-tab').first().locator('.sf-tab-close').click();
    await delay(600);
    report(
      'layout changed in browser B: merged back to one tile',
      (await pageB.locator('.sf-tile').count()) === 1,
    );

    const savedAtBefore = entry.savedAt;
    await openWsPanel(pageB);
    await itemMenu(pageB, 'Shared WS', 'Overwrite with current');
    await confirmDialog(pageB, 'Cancel', ['Shared WS', 'Overwrite']);
    const beforeConfirm = await httpJson(backendUrl, '/api/workspaces');
    const beforeEntry = (beforeConfirm.json?.workspaces ?? []).find((w) => w.name === 'Shared WS');
    report(
      'W7c cancelled overwrite leaves the backend snapshot untouched',
      beforeEntry?.savedAt === savedAtBefore && beforeEntry?.tiles === 2,
      JSON.stringify(beforeEntry),
    );
    await itemMenu(pageB, 'Shared WS', 'Overwrite with current');
    await confirmDialog(pageB, 'Overwrite', ['Shared WS', 'Overwrite']);
    const afterOverwrite = await httpJson(backendUrl, '/api/workspaces');
    const entry2 = (afterOverwrite.json?.workspaces ?? []).find((w) => w.name === 'Shared WS');
    report(
      'W8 overwrite pushes the current layout to the backend',
      entry2?.tiles === 1 && entry2?.tabs === 1 && entry2?.savedAt >= savedAtBefore,
      JSON.stringify(entry2),
    );

    await pageB.locator(`${PANEL} .sf-pl-item`, { hasText: 'Shared WS' }).click();
    await delay(800);
    report(
      'W9 re-loading the overwritten workspace collapses to one tile',
      (await pageB.locator('.sf-tile').count()) === 1,
    );
    await pageB.close();

    expectBackendOutage = true;
    killProc(backend);
    procs.length = 0;
    if (!(await waitDown(`${backendUrl}/api/health`))) throw new Error('backend did not stop');
    backend = spawnBackend();
    procs.push(backend);
    await waitHttp(`${backendUrl}/api/health`, 'backend after restart');
    expectBackendOutage = false;
    await delay(1200);
    const afterRestart = await httpJson(backendUrl, '/api/workspaces');
    report(
      'W10 workspaces survive a backend restart (file-backed store)',
      (afterRestart.json?.workspaces ?? []).some((w) => w.name === 'Shared WS' && w.tiles === 1),
    );

    await openWsPanel(page);
    await itemMenu(page, 'Shared WS', 'Delete');
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    report(
      'W11 pre delete confirm keeps the workspace',
      (await page.locator(`${PANEL} .sf-pl-item`).count()) === 1 &&
        ((await page.locator('.sf-dialog').textContent()) ?? '').includes('Shared WS'),
    );
    await confirmDialog(page, 'Delete', ['Shared WS', 'cannot be undone']);
    await delay(200);
    const afterDelete = await httpJson(backendUrl, '/api/workspaces');
    report(
      'W11 delete removes the workspace from the list and the backend',
      (await page.locator(`${PANEL} .sf-pl-item`).count()) === 0 &&
        !(afterDelete.json?.workspaces ?? []).some((w) => w.name === 'Shared WS'),
    );
    const gone = entry2
      ? await httpJson(backendUrl, `/api/workspaces/${encodeURIComponent(entry2.id)}`)
      : null;
    report('W11b deleted workspace id returns 404', gone?.status === 404, `status=${gone?.status}`);

    report('no console/page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) killProc(p);
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(isFailed() || process.exitCode === 1 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
