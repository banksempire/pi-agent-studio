const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { writeStubClient } = require('./lib/stub-backend.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'send-stop-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const ABORT_LOG = path.join(RUN_ROOT, 'aborts.jsonl');

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

function killProc(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
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
  const dir = path.join(SESSIONS_ROOT, '--tmp-send-stop--');
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
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  return file;
}

(async () => {
  const { report, isFailed } = makeReporter();
  const procs = [];
  let browser;
  try {
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    const F = writeSessionFile('send-stop-check');
    fs.rmSync(ABORT_LOG, { force: true });

    procs.push(
      spawn('node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          STUB_ABORT_LOG: ABORT_LOG,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/send-stop-backend.log', 'a'),
          fs.openSync('/tmp/send-stop-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawn(
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
            fs.openSync('/tmp/send-stop-vite.log', 'a'),
            fs.openSync('/tmp/send-stop-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-list-item:has-text("send-stop-check")', { timeout: 60000 });
    await page.locator('.chat-list-item:has-text("send-stop-check")').first().click({ force: true });
    await page.waitForSelector('.chat-window', { timeout: 20000 });
    await delay(1500);

    const stopBtn = page.locator('.chat-send-btn--stop');
    const sendBtn = page.locator('.chat-send-btn:not(.chat-send-btn--stop)');

    const t1 = await (async () => {
      const idleEmptyDisabled = await sendBtn.isDisabled();
      return { ok: idleEmptyDisabled, why: `idle-empty-send-disabled:${idleEmptyDisabled}` };
    })();
    report('idle + empty input → Send disabled, no Stop', t1.ok, t1.why);

    const t2 = await (async () => {
      stub.emit('session_status', F, { status: 'running' });
      for (let i = 0; i < 40; i++) {
        if ((await stopBtn.count()) === 1) break;
        await delay(250);
      }
      const visible = (await stopBtn.count()) === 1;
      const label = visible ? ((await stopBtn.innerText()) || '').trim() : '';
      const enabled = visible ? !(await stopBtn.isDisabled()) : false;
      const sendGone = (await sendBtn.count()) === 0;
      return {
        ok: visible && /Stop/.test(label) && enabled && sendGone,
        why: `visible:${visible} label:"${label}" enabled:${enabled} send-hidden:${sendGone}`,
      };
    })();
    report('running + empty input → Send becomes enabled Stop', t2.ok, t2.why);

    const t3 = await (async () => {
      await page.locator('.chat-input').fill('queued message while running');
      await delay(400);
      const stopGone = (await stopBtn.count()) === 0;
      const sendBack = (await sendBtn.count()) === 1 && !(await sendBtn.isDisabled());
      return { ok: stopGone && sendBack, why: `stop-hidden:${stopGone} send-back-enabled:${sendBack}` };
    })();
    report('running + typed text → Send returns (queueing)', t3.ok, t3.why);

    const t4 = await (async () => {
      await page.locator('.chat-input').fill('');
      for (let i = 0; i < 40; i++) {
        if ((await stopBtn.count()) === 1) break;
        await delay(250);
      }
      const back = (await stopBtn.count()) === 1;
      if (!back) return { ok: false, why: 'stop did not come back after clearing input' };
      await stopBtn.click();
      let logged = null;
      for (let i = 0; i < 40; i++) {
        try {
          const lines = fs.readFileSync(ABORT_LOG, 'utf8').split('\n').filter(Boolean);
          logged = lines.map((l) => JSON.parse(l)).find((e) => e.agentId === F);
        } catch {}
        if (logged) break;
        await delay(250);
      }
      return { ok: !!logged, why: `abort-logged:${!!logged}` };
    })();
    report('clicking Stop interrupts generation (abort reaches agent)', t4.ok, t4.why);

    const t5 = await (async () => {
      stub.emit('session_status', F, { status: 'idle' });
      for (let i = 0; i < 40; i++) {
        if ((await stopBtn.count()) === 0) break;
        await delay(250);
      }
      const stopGone = (await stopBtn.count()) === 0;
      const sendBack = (await sendBtn.count()) === 1 && (await sendBtn.isDisabled());
      return { ok: stopGone && sendBack, why: `stop-gone:${stopGone} send-disabled-again:${sendBack}` };
    })();
    report('back to idle → Stop reverts to disabled Send', t5.ok, t5.why);

    report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    report('suite crashed', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) killProc(p);
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(isFailed() ? 1 : 0);
})();
