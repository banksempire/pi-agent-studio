const fs = require('node:fs');
const { spawn } = require('node:child_process');
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

const SUITE_STAMP = 'reload-check-stack';

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-ctx-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const SLASH_LOG = path.join(RUN_ROOT, 'slash.jsonl');

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

function writeSessionFile(name) {
  const dir = path.join(SESSIONS_ROOT, '--tmp-reload-check--');
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
        content: [{ type: 'text', text: `${name} a0` }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }),
  ];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function readSlashCalls() {
  try {
    return fs
      .readFileSync(SLASH_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

(async () => {
  const { report, isFailed } = makeReporter();
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: SUITE_STAMP, browserRef, label: 'reload-ctx' });
  let browser;
  try {
    assertMemoryHeadroom({ label: 'reload-ctx' });
    sweepStaleStackProcesses(SUITE_STAMP, { label: 'reload-ctx' });
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    const F = writeSessionFile('reload-check');
    fs.rmSync(SLASH_LOG, { force: true });

    procs.push(
      spawnStackProc(spawn, SUITE_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        detached: true,
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          STUB_SLASH_LOG: SLASH_LOG,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_SPILL_PATH: path.join(RUN_ROOT, 'backend-spill.json'),
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/reload-ctx-backend.log', 'a'),
          fs.openSync('/tmp/reload-ctx-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        SUITE_STAMP,
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
          detached: true,
          cwd: PRODUCT_ROOT,
          env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${backendPort}` },
          stdio: [
            'ignore',
            fs.openSync('/tmp/reload-ctx-vite.log', 'a'),
            fs.openSync('/tmp/reload-ctx-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-pl-item:has-text("reload-check")', { timeout: 60000 });
    await delay(2000);
    await page.locator('.sf-pl-item:has-text("reload-check")').first().click({ force: true });
    await page.waitForSelector('.chat-window', { timeout: 20000 });
    await delay(1500);

    const reloadBtn = page.locator('.chat-reload-btn');

    const t1 = await (async () => {
      const count = await reloadBtn.count();
      const visible = count === 1 ? await reloadBtn.isVisible() : false;
      const pos = count
        ? await page.evaluate(() => {
            const rl = document.querySelector('.chat-reload-btn').getBoundingClientRect();
            const sc = document.querySelector('.chat-scroll-btn').getBoundingClientRect();
            return { reloadLeft: rl.left, scrollLeft: sc.left, sameRow: Math.abs(rl.top - sc.top) < 5 };
          })
        : null;
      return {
        ok: count === 1 && visible && !!pos && pos.reloadLeft < pos.scrollLeft && pos.sameRow,
        why: JSON.stringify(pos),
      };
    })();
    report('composer has a reload button left of the scroll button', t1.ok, t1.why);

    const t2 = await (async () => {
      await reloadBtn.click();
      let call = null;
      for (let k = 0; k < 40; k++) {
        call = readSlashCalls().find((c) => c.agentId === F && c.command === 'reload');
        if (call) break;
        await delay(250);
      }
      return { ok: !!call, why: JSON.stringify(call || null) };
    })();
    report('clicking it posts slash command "reload" for this session to the backend', t2.ok, t2.why);

    const t3 = await (async () => {
      let flashed = false;
      for (let k = 0; k < 20; k++) {
        if ((await reloadBtn.evaluate((el) => el.classList.contains('chat-reload-btn--ok'))) === true) {
          flashed = true;
          break;
        }
        await delay(200);
      }
      let reverted = false;
      for (let k = 0; k < 20; k++) {
        if (!(await reloadBtn.evaluate((el) => el.classList.contains('chat-reload-btn--ok')))) {
          reverted = true;
          break;
        }
        await delay(250);
      }
      const reenabled = !(await reloadBtn.isDisabled());
      return {
        ok: flashed && reverted && reenabled,
        why: `flashed:${flashed} reverted:${reverted} reenabled:${reenabled}`,
      };
    })();
    report('successful reload flashes the button and returns it to the idle state', t3.ok, t3.why);

    const t4 = await (async () => {
      stub.emit('session_status', F, { status: 'running' });
      let disabled = false;
      for (let k = 0; k < 40; k++) {
        if (await reloadBtn.isDisabled()) {
          disabled = true;
          break;
        }
        await delay(250);
      }
      stub.emit('session_status', F, { status: 'idle' });
      let reenabled = false;
      for (let k = 0; k < 40; k++) {
        if (!(await reloadBtn.isDisabled())) {
          reenabled = true;
          break;
        }
        await delay(250);
      }
      return {
        ok: disabled && reenabled,
        why: `disabled-while-running:${disabled} reenabled-after-idle:${reenabled}`,
      };
    })();
    report('reload is disabled while the session is running and returns when idle', t4.ok, t4.why);

    stub.emit('session_status', F, { status: 'running' });
    let runningAgain = false;
    for (let k = 0; k < 40; k++) {
      if (await reloadBtn.isDisabled()) {
        runningAgain = true;
        break;
      }
      await delay(250);
    }

    const t5 = await (async () => {
      const callsBefore = readSlashCalls().filter((c) => c.command === 'reload').length;
      await reloadBtn.click({ force: true });
      await delay(1200);
      const callsAfter = readSlashCalls().filter((c) => c.command === 'reload').length;
      return {
        ok: runningAgain && callsAfter === callsBefore,
        why: `running:${runningAgain} calls before:${callsBefore} after:${callsAfter}`,
      };
    })();
    report('clicking the disabled reload button sends nothing', t5.ok, t5.why);

    stub.emit('session_status', F, { status: 'idle' });

    report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    report('suite crashed', false, e.stack || e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }

  if (isFailed()) {
    console.log('\nRELOAD-CONTEXT CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL RELOAD-CONTEXT CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
