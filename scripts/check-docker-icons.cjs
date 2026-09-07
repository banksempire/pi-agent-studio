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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-icons-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
const STATES_PATH = path.join(RUN_ROOT, 'states.json');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-docker-icons' });
  sweepStaleStackProcesses('check-docker-icons:stack');
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: 'check-docker-icons:stack', browserRef, label: 'check-docker-icons' });
  let browser;
  try {
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);

    procs.push(
      spawnStackProc(spawn, 'check-docker-icons:stack', 'node', ['src/pi-studio/server/index.mjs'], {
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
          fs.openSync('/tmp/docker-icons-backend.log', 'a'),
          fs.openSync('/tmp/docker-icons-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        'check-docker-icons:stack',
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
            fs.openSync('/tmp/docker-icons-vite.log', 'a'),
            fs.openSync('/tmp/docker-icons-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const errors = [];

    for (const vp of [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });
      await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(vp.width < 500 ? '.sf-root--mobile .sf-docker--bottom' : '.sf-docker', {
        timeout: 60000,
      });
      await delay(500);
      const tag = `[${vp.name}]`;

      const apps = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.sf-docker-app')).map((app) => {
          const icon = app.querySelector('.sf-docker-app-icon');
          const isSvg = !!icon && icon.classList.contains('sf-icon--svg');
          const r = isSvg ? icon.getBoundingClientRect() : null;
          return {
            title: app.title,
            svg: isSvg,
            textFallback: !!icon && !isSvg,
            w: r ? +r.width.toFixed(1) : 0,
            h: r ? +r.height.toFixed(1) : 0,
          };
        }),
      );
      report(`${tag} docker renders all 2 apps`, apps.length === 2, apps.map((a) => a.title).join(','));
      report(
        `${tag} every docker app icon renders an SVG (no emoji-text fallback)`,
        apps.length > 0 && apps.every((a) => a.svg && !a.textFallback),
        apps.map((a) => `${a.title}:svg=${a.svg}fallback=${a.textFallback}`).join(' '),
      );
      const sizes = new Set(apps.filter((a) => a.svg).map((a) => `${a.w}x${a.h}`));
      report(
        `${tag} all docker icons render at the same size`,
        apps.length > 0 && apps.every((a) => a.svg) && sizes.size === 1,
        [...sizes].join(' '),
      );

      if (vp.name === 'desktop') {
        report(
          'the scheduler app is gone from the docker',
          !apps.some((a) => a.title === 'Scheduler'),
          apps.map((a) => a.title).join(','),
        );
      }

      await page.close();
    }

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
