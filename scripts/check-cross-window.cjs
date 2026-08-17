/**
 * Cross-window state isolation checks (pi-agent-studio).
 *
 * Guards the regressions found in the cross-window interference review —
 * the framework reuses ONE component instance for every session shown in
 * a tile, so any per-window state that isn't keyed by session leaks into
 * whichever session the tile shows next:
 *
 *  - T1 tab-switch scroll preservation (be115f6): each session keeps its
 *    own position across A↔B interleaving.
 *  - T2 loadOlder async race (db3cd39): a pagination fetch completing
 *    AFTER a window switch must not re-anchor (and yank) the OTHER
 *    window's scroll — "scrolling one window moves another".
 *  - T3 image attachments + error banner (429acf9): attachments and
 *    session-scoped errors must never appear in a different window.
 *  - T4 image-review overlay (429acf9): an open overlay must not ride
 *    into the window the user switches to.
 *  - T5 split-tile independence: two visible chat windows scroll
 *    independently.
 *
 * Runs its own three-service stack (pi-nest + gateway + vite) on free
 * ports (override with XWIN_NEST_PORT / XWIN_BACKEND_PORT / XWIN_VITE_PORT)
 * and writes synthetic session files under
 * ~/.pi/agent/sessions/--tmp-xwin-check--/ (cleaned up afterwards).
 * The product's live services are never touched — no real messages are
 * ever sent.
 *
 * Usage: npm run check:crosswin
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const SESSIONS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const TEST_DIR_NAME = '--tmp-xwin-check--';
const TEST_SESSIONS_DIR = path.join(SESSIONS_ROOT, TEST_DIR_NAME);
const TEST_CWD = '/tmp/xwin-check';
const IMG_DIR = '/tmp/xwin-check-imgs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Ports ───────────────────────────────────────────────────────────────────

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
  const nest = Number(process.env.XWIN_NEST_PORT) || (await freePort());
  const backend = Number(process.env.XWIN_BACKEND_PORT) || (await freePort());
  const vite = Number(process.env.XWIN_VITE_PORT) || (await freePort());
  return { nest, backend, vite };
}

// ── Synthetic sessions ──────────────────────────────────────────────────────

const PNG1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function writeSessions() {
  fs.rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
  const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
  const sessionFile = (name, turns, { withImage = false } = {}) => {
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
      const ucontent =
        withImage && t === Math.floor(turns / 2)
          ? [
              { type: 'text', text: `${name}: question ${t + 1} — here is an image.` },
              { type: 'image', data: PNG1.toString('base64'), mimeType: 'image/png' },
            ]
          : [{ type: 'text', text: `${name}: question ${t + 1} — ${'padding for a taller row '.repeat(6)}` }];
      lines.push(
        JSON.stringify({
          type: 'message',
          id: umid,
          parentId: prev,
          timestamp: new Date(base + n * 60000).toISOString(),
          message: {
            role: 'user',
            content: ucontent,
            timestamp: base + n * 60000,
          },
        }),
      );
      prev = umid;
      n += 1;
      const amid = `a${n}`;
      const content = [
        { type: 'text', text: `Answer ${t + 1} for ${name} — ${'reply padding text '.repeat(8)}` },
      ];
      lines.push(
        JSON.stringify({
          type: 'message',
          id: amid,
          parentId: umid,
          timestamp: new Date(base + n * 60000 + 1000).toISOString(),
          message: { role: 'assistant', content, timestamp: base + n * 60000 + 1000 },
        }),
      );
      prev = amid;
    }
    const fn = path.join(
      TEST_SESSIONS_DIR,
      `2026-08-10T00-00-00-${String(turns).padStart(3, '0')}Z_${name.toLowerCase().replaceAll(' ', '-')}-${uid()}.jsonl`,
    );
    fs.writeFileSync(fn, `${lines.join('\n')}\n`);
  };
  sessionFile('XWin-A', 55); // 110 messages — deep, hasMore at page size 50
  sessionFile('XWin-B', 30); // 60 messages — scrollable, hasMore
  sessionFile('XWin-C', 10, { withImage: true }); // 20 messages + an image
}

function writeTestImages() {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(IMG_DIR, `img${i}.png`), i % 2 ? PNG1 : PNG2);
}

// ── Stack lifecycle ─────────────────────────────────────────────────────────

function spawnBg(cmd, args, env, log) {
  const child = spawn(cmd, args, {
    cwd: PRODUCT_ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
  });
  return child;
}

function killProc(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
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
    } catch {
      /* retry */
    }
  }
  throw new Error(`${label} did not come up`);
}

// ── Reporter ────────────────────────────────────────────────────────────────

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const { report, isFailed } = makeReporter();
  const procs = [];
  const cleanup = () => {
    for (const p of procs) killProc(p);
    fs.rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
    fs.rmSync(IMG_DIR, { recursive: true, force: true });
  };

  let browser;
  try {
    const ports = await pickPorts();
    console.log(`stack: nest :${ports.nest} backend :${ports.backend} vite :${ports.vite}`);
    writeSessions();
    writeTestImages();

    procs.push(
      spawnBg(
        'node',
        ['src/pi-nest/src/index.mjs'],
        { PI_NEST_PORT: String(ports.nest), PI_NEST_CWD: TEST_CWD },
        '/tmp/xwin-check-nest.log',
      ),
    );
    await delay(1200);
    procs.push(
      spawnBg(
        'node',
        ['src/pi-studio/server/index.mjs'],
        { PI_STUDIO_PORT: String(ports.backend), PI_NEST_PORT: String(ports.nest) },
        '/tmp/xwin-check-backend.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${ports.backend}/api/health`, 'gateway');
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
        '/tmp/xwin-check-vite.log',
      ),
    );
    await waitHttp(`http://127.0.0.1:${ports.vite}/`, 'vite');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${ports.vite}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-list-item', { timeout: 60000 });
    await page.waitForSelector('.chat-list-item:has-text("XWin-A:")', { timeout: 20000 });
    await delay(2000);

    // ── Helpers ──────────────────────────────────────────────────────────

    const openSession = async (marker) => {
      await page.locator(`.chat-list-item:has-text("${marker}")`).first().click({ force: true });
      await page.waitForSelector('.chat-messages', { timeout: 20000 });
      await delay(2500);
      // A fresh window opens in REVIEW mode; a real click on its tab pins it
      // (otherwise the next history click would close it and open the new
      // session where it stood).
      const i = await tabIndex(marker);
      if (i >= 0) {
        await page.locator('.sf-tab-label').nth(i).click({ force: true });
        await delay(800);
      }
    };
    const tabIndex = async (marker) => {
      const tabs = await page.locator('.sf-tab-label').allInnerTexts();
      return tabs.findIndex((t) => t.includes(marker));
    };
    const switchTab = async (marker) => {
      const i = await tabIndex(marker);
      if (i < 0) throw new Error(`tab not found: ${marker}`);
      await page.locator('.sf-tab-label').nth(i).click({ force: true });
      await delay(1600);
    };
    const scrollState = () =>
      page.evaluate(() => {
        const el = document.querySelector('.chat-messages');
        return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
      });
    const setScrollFrac = (frac) =>
      page.evaluate((f) => {
        const el = document.querySelector('.chat-messages');
        el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * f);
      }, frac);
    const ui = () =>
      page.evaluate(() => ({
        chips: document.querySelectorAll('.chat-attach-chip').length,
        banner: !!document.querySelector('.chat-banner--error'),
        overlay: !!document.querySelector('.img-review'),
        messages: document.querySelectorAll('.chat-messages').length,
      }));

    // ── T1: tab-switch scroll preservation ────────────────────────────────

    await openSession('XWin-A:');
    await openSession('XWin-B:');
    const t1 = await (async () => {
      await switchTab('XWin-A');
      await setScrollFrac(0.4);
      await delay(500);
      const A1 = await scrollState();
      await switchTab('XWin-B');
      await setScrollFrac(0.4);
      await delay(500);
      const B1 = await scrollState();
      let ok = true;
      let why = '';
      for (let cycle = 0; cycle < 3; cycle++) {
        await switchTab('XWin-A');
        const a = await scrollState();
        if (Math.abs(a.top - A1.top) > 6) {
          ok = false;
          why = `A cycle${cycle}: ${a.top} vs ${A1.top}`;
          break;
        }
        await switchTab('XWin-B');
        const b = await scrollState();
        if (Math.abs(b.top - B1.top) > 6) {
          ok = false;
          why = `B cycle${cycle}: ${b.top} vs ${B1.top}`;
          break;
        }
      }
      return { ok, why, A1, B1 };
    })();
    report('T1 tab-switch scroll preservation (A/B interleave ×3)', t1.ok, t1.why);

    // ── T2: loadOlder race must not move the other window ─────────────────

    const t2 = await (async () => {
      // B at a mid position (not bottom) so any corruption is detectable.
      await switchTab('XWin-B');
      await setScrollFrac(0.4);
      await delay(600);
      const before = await scrollState();
      // Delay every messages fetch from here on: A's pagination fetch will
      // still be in flight when we switch away.
      await page.route('**/api/sessions/messages*', async (route) => {
        await delay(800);
        await route.continue();
      });
      await switchTab('XWin-A');
      await page.evaluate(() => {
        document.querySelector('.chat-messages').scrollTop = 0; // triggers loadOlder
      });
      await delay(100);
      await switchTab('XWin-B');
      await delay(2600);
      await page.unroute('**/api/sessions/messages*');
      const after = await scrollState();
      return {
        ok: Math.abs(after.top - before.top) <= 6,
        why: `${before.top} → ${after.top}`,
        before,
        after,
      };
    })();
    report('T2 loadOlder race does not re-anchor the other window', t2.ok, t2.why);

    // ── T3: attachments + error banner stay in their window ───────────────

    const t3 = await (async () => {
      await switchTab('XWin-A');
      await page.setInputFiles('input.chat-image-input[type=file]', [
        path.join(IMG_DIR, 'img0.png'),
        path.join(IMG_DIR, 'img1.png'),
        path.join(IMG_DIR, 'img2.png'),
        path.join(IMG_DIR, 'img3.png'),
        path.join(IMG_DIR, 'img4.png'), // 5th → overflow error
      ]);
      await delay(1500);
      const inA = await ui();
      await switchTab('XWin-B');
      const inB = await ui();
      await switchTab('XWin-A');
      const backA = await ui();
      await page.evaluate(() => document.querySelector('.chat-banner--error')?.click());
      await delay(400);
      const dismissed = await ui();
      await switchTab('XWin-B');
      const finalB = await ui();
      const ok =
        inA.chips === 4 &&
        inA.banner &&
        inB.chips === 0 &&
        !inB.banner &&
        backA.chips === 4 &&
        backA.banner &&
        !dismissed.banner &&
        finalB.chips === 0 &&
        !finalB.banner;
      const why = `A{chips:${inA.chips},banner:${inA.banner}} B{chips:${inB.chips},banner:${inB.banner}} backA{chips:${backA.chips},banner:${backA.banner}}`;
      return { ok, why };
    })();
    report('T3 attachments + error banner scoped to their window', t3.ok, t3.why);

    // ── T4: image-review overlay dies with its window ─────────────────────

    const t4 = await (async () => {
      await openSession('XWin-C:');
      await switchTab('XWin-C');
      const imgLink = page.locator('.msg-image-link, .msg-fan-leaf').first();
      if ((await imgLink.count()) === 0) return { ok: false, why: 'no image message rendered in XWin-C' };
      await imgLink.click({ force: true });
      await delay(800);
      const inC = await ui();
      await switchTab('XWin-A');
      const inA = await ui();
      return { ok: inC.overlay && !inA.overlay, why: `C overlay:${inC.overlay} → A overlay:${inA.overlay}` };
    })();
    report('T4 image-review overlay does not ride into the next window', t4.ok, t4.why);

    // ── T5: split-tile windows scroll independently ───────────────────────

    const t5 = await (async () => {
      // Close C's tab (middle-click), then drag B out to a right split.
      const cIdx = await tabIndex('XWin-C');
      await page.locator('.sf-tab-label').nth(cIdx).click({ button: 'middle' });
      await delay(1200);
      const ws = page.locator('.sf-workspace');
      const wb = await ws.boundingBox();
      const bIdx = await tabIndex('XWin-B');
      await page
        .locator('.sf-tab')
        .nth(bIdx)
        .dragTo(ws, { targetPosition: { x: wb.width - 8, y: Math.round(wb.height / 2) } });
      await delay(2000);
      const two = await ui();
      if (two.messages !== 2) return { ok: false, why: `expected 2 chat windows, got ${two.messages}` };
      const res = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.chat-messages'));
        const [l, r] = [els[0], els[1]];
        const info = (el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight });
        const beforeR = info(r);
        l.scrollTop = Math.round((l.scrollHeight - l.clientHeight) * 0.5); // scroll LEFT
        const afterR = info(r);
        return { beforeR, afterR };
      });
      return {
        ok: Math.abs(res.afterR.top - res.beforeR.top) <= 2,
        why: `right window: ${res.beforeR.top} → ${res.afterR.top} after scrolling left`,
      };
    })();
    report('T5 split-tile windows scroll independently', t5.ok, t5.why);

    // ── Summary ────────────────────────────────────────────────────────────

    if (errors.length) console.log(`page errors: ${errors.join(' | ')}`);
    const failed = isFailed() || errors.length > 0;
    console.log(failed ? '\nCROSS-WINDOW CHECKS FAILED' : '\nALL CROSS-WINDOW CHECKS PASSED');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error(`check-cross-window: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    cleanup();
  }
})();
