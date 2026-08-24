const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const TMP_BASE = process.env.XWIN_CHECK_TMP || '';
const ISOLATED_ROOT = TMP_BASE ? path.join(TMP_BASE, 'sessions') : '/tmp/xwin-check-sessions';
const TEST_DIR_NAME = '--tmp-xwin-check--';
const TEST_SESSIONS_DIR = path.join(ISOLATED_ROOT, TEST_DIR_NAME);
const TEST_STATES_PATH = TMP_BASE ? path.join(TMP_BASE, 'states.json') : '/tmp/xwin-check-states.json';
const TEST_CWD = TMP_BASE ? path.join(TMP_BASE, 'cwd') : '/tmp/xwin-check';
const IMG_DIR = TMP_BASE ? path.join(TMP_BASE, 'imgs') : '/tmp/xwin-check-imgs';
const BACKEND_LOG = TMP_BASE ? path.join(TMP_BASE, 'backend.log') : '/tmp/xwin-check-backend.log';
const VITE_LOG = TMP_BASE ? path.join(TMP_BASE, 'vite.log') : '/tmp/xwin-check-vite.log';

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
  const backend = Number(process.env.XWIN_BACKEND_PORT) || (await freePort());
  const vite = Number(process.env.XWIN_VITE_PORT) || (await freePort());
  return { backend, vite };
}

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
  const sessionFile = (name, turns, { withImage = false, withTool = false } = {}) => {
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
      const content =
        withTool && t === 0
          ? [
              {
                type: 'toolCall',
                id: `${name.toLowerCase().replaceAll('-', '')}-tc1`,
                name: 'probe',
                arguments: { query: name },
              },
              { type: 'text', text: `Answer ${t + 1} for ${name} — ${'reply padding text '.repeat(8)}` },
            ]
          : [{ type: 'text', text: `Answer ${t + 1} for ${name} — ${'reply padding text '.repeat(8)}` }];
      lines.push(
        JSON.stringify({
          type: 'message',
          id: amid,
          parentId: umid,
          timestamp: new Date(base + n * 60000 + 1000).toISOString(),
          message: {
            role: 'assistant',
            content,
            timestamp: base + n * 60000 + 1000,
            ...(t === turns - 1 ? { stopReason: 'stop' } : {}),
          },
        }),
      );
      prev = amid;
    }
    const fn = path.join(
      TEST_SESSIONS_DIR,
      `2026-08-10T00-00-00-${String(turns).padStart(3, '0')}Z_${name.toLowerCase().replaceAll(' ', '-')}-${uid()}.jsonl`,
    );
    fs.writeFileSync(fn, `${lines.join('\n')}\n`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(fn, old, old);
  };
  sessionFile('XWin-A', 55);
  sessionFile('XWin-B', 30);
  sessionFile('XWin-C', 10, { withImage: true });
  sessionFile('XWin-D', 20, { withTool: true });
  sessionFile('XWin-E', 20, { withTool: true });
}

function writeTestImages() {
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(IMG_DIR, `img${i}.png`), i % 2 ? PNG1 : PNG2);
}

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
    fs.rmSync(IMG_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_STATES_PATH, { force: true });
  };

  let browser;
  try {
    const ports = await pickPorts();
    console.log(`stack: backend :${ports.backend} vite :${ports.vite}`);
    writeSessions();
    writeTestImages();
    fs.rmSync(TEST_STATES_PATH, { force: true });

    procs.push(
      spawnBg(
        'node',
        ['src/pi-studio/server/index.mjs'],
        {
          PI_STUDIO_PORT: String(ports.backend),
          PI_STUDIO_SESSIONS: ISOLATED_ROOT,
          PI_STUDIO_STATES_PATH: TEST_STATES_PATH,
          PI_STUDIO_CWD: TEST_CWD,
        },
        BACKEND_LOG,
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
        VITE_LOG,
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

    const openSession = async (marker) => {
      await page.locator(`.chat-list-item:has-text("${marker}")`).first().click({ force: true });
      await page.waitForSelector('.chat-messages', { timeout: 20000 });
      await delay(2500);
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
        const max = el.scrollHeight - el.clientHeight;
        return { top: el.scrollTop, max, distFromTop: el.scrollTop + max };
      });
    const setScrollFrac = (frac) =>
      page.evaluate((f) => {
        const el = document.querySelector('.chat-messages');
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * f);
      }, frac);
    const ui = () =>
      page.evaluate(() => ({
        chips: document.querySelectorAll('.chat-attach-chip').length,
        banner: !!document.querySelector('.chat-banner--error'),
        overlay: !!document.querySelector('.img-review'),
        messages: document.querySelectorAll('.chat-messages').length,
      }));

    const t16 = await (async () => {
      const sessionsList = () => page.locator('[data-sub-body="sessions"]');
      const bootCount = await sessionsList().locator('.chat-list-item').count();
      await openSession('XWin-C:');
      const cItem = sessionsList().locator('.chat-list-item:has-text("XWin-C:")');
      const shown = (await cItem.count()) === 1;
      const badge = (await cItem.locator('.chat-list-badge').textContent())?.trim();
      const sessionsSub = page.locator('.sf-subsection:has([data-sub-body="sessions"])');
      await sessionsSub.locator('.sf-subsection-header').hover();
      await delay(100);
      await sessionsSub.locator('.sf-subsection-util[title="Filter sessions by status"]').click();
      await delay(300);
      const openRow = page.locator('.sf-menu-pop .sf-menu-row:has-text("open")');
      await openRow.click();
      await delay(400);
      const hiddenCount = await sessionsList().locator('.chat-list-item').count();
      await openRow.click();
      await delay(400);
      const backCount = await sessionsList().locator('.chat-list-item').count();
      await page.keyboard.press('Escape');
      await delay(200);
      const cIdx = await tabIndex('XWin-C:');
      await page.locator('.sf-tab-label').nth(cIdx).click({ button: 'middle' });
      let gone = false;
      for (let i = 0; i < 20; i++) {
        await delay(300);
        if ((await cItem.count()) === 0) {
          gone = true;
          break;
        }
      }
      return {
        ok: bootCount >= 1 && shown && badge === 'open' && hiddenCount === 0 && backCount >= 1 && gone,
        why: `boot:${bootCount} shown:${shown} badge:${badge} filtered:${hiddenCount} restored:${backCount} gone-after-close:${gone}`,
      };
    })();
    report(
      'T16 sessions sub-section shows synced open state + status filter menu + refcount close',
      t16.ok,
      t16.why,
    );

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

    const t2 = await (async () => {
      await switchTab('XWin-B');
      await setScrollFrac(0.4);
      await delay(600);
      const before = await scrollState();
      await page.route('**/api/sessions/messages*', async (route) => {
        await delay(800);
        await route.continue();
      });
      await switchTab('XWin-A');
      await page.evaluate(() => {
        const el = document.querySelector('.chat-messages');
        el.scrollTop = -(el.scrollHeight - el.clientHeight);
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

    const t9 = await (async () => {
      await openSession('XWin-D:');
      await openSession('XWin-E:');
      await switchTab('XWin-D');
      await delay(600);
      const dHead = await page.locator('.chat-work-head').first();
      const dCountBefore = await page.locator('.chat-work-head').count();
      await dHead.click({ force: true });
      await delay(600);
      const dOpen = await page.locator('.chat-work-body').count();
      await switchTab('XWin-E');
      const eOpen = await page.locator('.chat-work-body').count();
      const eHeadCount = await page.locator('.chat-work-head').count();
      await switchTab('XWin-D');
      const dOpenAfter = await page.locator('.chat-work-body').count();
      return {
        ok: dCountBefore >= 1 && dOpen >= 1 && eOpen === 0 && eHeadCount >= 1 && dOpenAfter >= 1,
        why: `D heads:${dCountBefore} D open:${dOpen} E open:${eOpen} E heads:${eHeadCount} D back:${dOpenAfter}`,
      };
    })();
    report('T9 expanded box does not ride into the next window', t9.ok, t9.why);

    const t3 = await (async () => {
      await switchTab('XWin-A');
      await page.setInputFiles('input.chat-image-input[type=file]', [
        path.join(IMG_DIR, 'img0.png'),
        path.join(IMG_DIR, 'img1.png'),
        path.join(IMG_DIR, 'img2.png'),
        path.join(IMG_DIR, 'img3.png'),
        path.join(IMG_DIR, 'img4.png'),
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

    const t4 = await (async () => {
      await openSession('XWin-C:');
      await switchTab('XWin-C');
      const imgLink = page.locator('.msg-image-link, .msg-fan-leaf').first();
      if ((await imgLink.count()) === 0) return { ok: false, why: 'no image message rendered in XWin-C' };
      await imgLink.evaluate((el) => {
        const list = el.closest('.chat-messages');
        if (!list) return;
        const lr = list.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        list.scrollTop = list.scrollTop + (er.top - lr.top);
      });
      await imgLink.click({ force: true });
      await delay(800);
      const inC = await ui();
      await switchTab('XWin-A');
      const inA = await ui();
      return { ok: inC.overlay && !inA.overlay, why: `C overlay:${inC.overlay} → A overlay:${inA.overlay}` };
    })();
    report('T4 image-review overlay does not ride into the next window', t4.ok, t4.why);

    const t6 = await (async () => {
      const handle = page.locator('.chat-composer-handle');
      if ((await handle.count()) === 0) return { ok: false, why: 'no composer handle' };
      const drag = async (dy) => {
        const bb = await handle.boundingBox();
        const x = bb.x + bb.width / 2;
        const y = bb.y + 4;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + dy, { steps: 12 });
        await page.mouse.up();
        await delay(600);
      };
      await switchTab('XWin-A');
      await page.evaluate(() => {
        const el = document.querySelector('.chat-messages');
        el.scrollTop = 0;
      });
      await delay(600);
      const bottomBefore = await scrollState();
      await drag(-130);
      const bottomAfter = await scrollState();
      const pinnedBottom = bottomAfter.distFromTop >= bottomAfter.max - 3;
      await setScrollFrac(0.4);
      await delay(600);
      const mid = await scrollState();
      await drag(260);
      const midAfter = await scrollState();
      const linePinned = Math.abs(midAfter.top - mid.top) <= 3;
      const bb = await handle.boundingBox();
      await page.mouse.dblclick(bb.x + bb.width / 2, bb.y + 4);
      await delay(500);
      return {
        ok: pinnedBottom && linePinned,
        why: `bottom ${bottomBefore.top}/${bottomBefore.max} → ${bottomAfter.top}/${bottomAfter.max} (pinned:${pinnedBottom}); mid ${mid.top} → ${midAfter.top} (first line pinned:${linePinned})`,
      };
    })();
    report('T6 resize pins bottom when sticky, first line otherwise', t6.ok, t6.why);

    const t7 = await (async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
      await page.waitForSelector('.chat-messages', { timeout: 30000 });
      await delay(3500);
      const atBottom = async () => {
        await delay(500);
        const s = await scrollState();
        return { ok: s.distFromTop >= s.max - 3, s };
      };
      const why = [];
      const first = await atBottom();
      why.push(`active:${first.s.top}/${first.s.max}`);
      const results = [first.ok];
      for (const m of ['XWin-B:', 'XWin-A:', 'XWin-C:', 'XWin-B:']) {
        await switchTab(m);
        const r = await atBottom();
        results.push(r.ok);
        why.push(`${m.trim()} ${r.s.top}/${r.s.max}`);
      }
      return { ok: results.every(Boolean), why: why.join('; ') };
    })();
    report('T7 reload restores every window pinned to the bottom', t7.ok, t7.why);

    const t8 = await (async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
      await page.waitForSelector('.chat-messages', { timeout: 30000 });
      await delay(3500);
      await switchTab('XWin-B');
      const ws = page.locator('.sf-workspace');
      const wb = await ws.boundingBox();
      const bIdx = await tabIndex('XWin-B');
      await page
        .locator('.sf-tab')
        .nth(bIdx)
        .dragTo(ws, { targetPosition: { x: wb.width - 8, y: Math.round(wb.height / 2) } });
      await delay(2500);
      const res = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.chat-messages'));
        return els.map((el) => {
          const max = el.scrollHeight - el.clientHeight;
          return {
            top: el.scrollTop,
            max,
            distFromTop: el.scrollTop + max,
            sticky: el.scrollTop + max > max - 48,
          };
        });
      });
      const ok = res.length === 2 && res.every((s) => s.distFromTop >= s.max - 3);
      return { ok, why: JSON.stringify(res) };
    })();
    report('T8 reload + split leaves both windows at the bottom', t8.ok, t8.why);

    const t5 = await (async () => {
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
        const info = (el) => ({
          top: el.scrollTop,
          max: el.scrollHeight - el.clientHeight,
          distFromTop: el.scrollTop + (el.scrollHeight - el.clientHeight),
        });
        const beforeR = info(r);
        l.scrollTop = -Math.round((l.scrollHeight - l.clientHeight) * 0.5);
        const afterR = info(r);
        return { beforeR, afterR };
      });
      return {
        ok: Math.abs(res.afterR.top - res.beforeR.top) <= 2,
        why: `right window: ${res.beforeR.top} → ${res.afterR.top} after scrolling left`,
      };
    })();
    report('T5 split-tile windows scroll independently', t5.ok, t5.why);

    const t10 = await (async () => {
      await switchTab('XWin-E');
      await delay(600);
      const before = await page.evaluate(() => ({
        blocks: document.querySelectorAll('.chat-composer-block').length,
        inputDisabled: document.querySelectorAll('.chat-window .chat-input')[0]?.disabled ?? null,
      }));
      const eFile = fs.readdirSync(TEST_SESSIONS_DIR).find((f) => f.includes('xwin-e-'));
      if (!eFile) return { ok: false, why: 'no xwin-e file on disk' };
      fs.rmSync(path.join(TEST_SESSIONS_DIR, eFile));
      const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
      const freshId = uid();
      const freshLines = [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: freshId,
          parentId: null,
          timestamp: new Date().toISOString(),
          cwd: TEST_CWD,
        }),
        JSON.stringify({
          type: 'message',
          id: 't10-u1',
          parentId: freshId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'XWin-T10: fresh trigger session — padding for a taller row '.repeat(6) },
            ],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(
        path.join(TEST_SESSIONS_DIR, `2026-08-10T00-00-00-040Z_xwin-t10-${uid()}.jsonl`),
        `${freshLines.join('\n')}\n`,
      );
      await delay(6000);
      const blocked = await page.evaluate(() => {
        const win = document.querySelector('.chat-window');
        const block = win?.querySelector('.chat-composer-block');
        const input = win?.querySelector('.chat-input');
        const send = win?.querySelector('.chat-send-btn');
        const scroll = win?.querySelector('.chat-scroll-btn');
        const img = win?.querySelector('.chat-image-btn');
        return {
          blockText: block?.textContent?.trim() ?? '',
          inputDisabled: input?.disabled ?? null,
          sendDisabled: send?.disabled ?? null,
          scrollDisabled: scroll?.disabled ?? null,
          imgDisabled: img?.disabled ?? null,
        };
      });
      const blockOk =
        blocked.blockText.length > 0 &&
        blocked.inputDisabled &&
        blocked.sendDisabled &&
        blocked.scrollDisabled &&
        blocked.imgDisabled;
      await switchTab('XWin-B');
      const other = await page.evaluate(() => {
        const wins = Array.from(document.querySelectorAll('.chat-window'));
        const blocked = wins.filter((w) => w.querySelector('.chat-composer-block'));
        const usable = wins.filter((w) => {
          const input = w.querySelector('.chat-input');
          return !w.querySelector('.chat-composer-block') && input && !input.disabled;
        });
        return { blocked: blocked.length, usable: usable.length, total: wins.length };
      });
      return {
        ok:
          before.blocks === 0 &&
          before.inputDisabled === false &&
          blockOk &&
          other.blocked === 1 &&
          other.usable >= 1,
        why: `E before{blocks:${before.blocks},input:${before.inputDisabled}} E blocked{banner:${JSON.stringify(blocked.blockText)},input:${blocked.inputDisabled},send:${blocked.sendDisabled},scroll:${blocked.scrollDisabled},img:${blocked.imgDisabled}} windows{total:${other.total},blocked:${other.blocked},usable:${other.usable}}`,
      };
    })();
    report('T10 vanished session blocks the composer with a banner on top', t10.ok, t10.why);

    const t11 = await (async () => {
      await switchTab('XWin-A');
      await delay(800);
      const sash = page.locator('.sf-sash').first();
      if ((await sash.count()) === 0) return { ok: false, why: 'no sash (split missing)' };
      const sashInfo = await page.evaluate(() => {
        const wins = Array.from(document.querySelectorAll('.chat-messages')).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        const sashes = Array.from(document.querySelectorAll('.sf-sash')).map((el, i) => {
          const r = el.getBoundingClientRect();
          return { i, x: r.x, y: r.y, w: r.width, h: r.height };
        });
        return { wins, sashes };
      });
      const w0 = sashInfo.wins[0];
      const w1 = sashInfo.wins[1];
      const between = sashInfo.sashes.filter(
        (s) => s.h > 100 && s.x >= Math.min(w0.x, w1.x) && s.x <= Math.max(w0.x, w1.x) && s.w <= 12,
      );
      const pick = between[0] ?? sashInfo.sashes[0];
      if (!pick) return { ok: false, why: `no sash between windows: ${JSON.stringify(sashInfo)}` };
      console.log(
        `  T11 sashInfo wins:${JSON.stringify(sashInfo.wins)} sashes:${JSON.stringify(sashInfo.sashes)} pick:${pick.i}`,
      );
      const dom = await page.evaluate(() => ({
        innerCls: document.querySelector('.sf-workspace-inner')?.className ?? '',
        splits: Array.from(document.querySelectorAll('.sf-split')).map((el) => {
          const r = el.getBoundingClientRect();
          return { cls: el.className, x: r.x, y: r.y, w: r.width, h: r.height };
        }),
        roots: Array.from(document.querySelectorAll('.sf-root-group')).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }),
        sashEls: Array.from(document.querySelectorAll('.sf-sash')).map((el) => ({
          cls: el.className,
          r: (() => {
            const b = el.getBoundingClientRect();
            return { x: b.x, y: b.y, w: b.width, h: b.height };
          })(),
        })),
      }));
      console.log(`  T11 dom ${JSON.stringify(dom)}`);
      const two = await ui();
      if (two.messages !== 2) return { ok: false, why: `expected 2 windows, got ${two.messages}` };
      const dragSash = async (dx) => {
        const sashEl = page.locator('.sf-sash').nth(pick.i);
        const sb = await sashEl.boundingBox();
        const sx = sb.x + sb.width / 2;
        const sy = sb.y + sb.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx + dx, sy, { steps: 20 });
        await delay(200);
        await page.mouse.up();
        await delay(900);
      };
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.chat-messages')) el.scrollTop = 0;
      });
      await delay(600);
      const before = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.chat-messages')).map((el) => {
          const max = el.scrollHeight - el.clientHeight;
          return { top: el.scrollTop, max, distFromTop: el.scrollTop + max };
        }),
      );
      await dragSash(140);
      const after = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.chat-messages')).map((el) => {
          const max = el.scrollHeight - el.clientHeight;
          return { top: el.scrollTop, max, distFromTop: el.scrollTop + max };
        }),
      );
      const pinned = after.every((s) => s.distFromTop >= s.max - 3);
      const midBefore = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.chat-messages'));
        els[0].scrollTop = -Math.round((els[0].scrollHeight - els[0].clientHeight) * 0.4);
        return els[0].scrollTop;
      });
      await delay(500);
      await dragSash(-110);
      const midAfter = await page.evaluate(
        () => Array.from(document.querySelectorAll('.chat-messages'))[0].scrollTop,
      );
      const linePinned = Math.abs(midAfter - midBefore) <= 3;
      return {
        ok: pinned && linePinned,
        why: `pinned ${JSON.stringify(before)} → ${JSON.stringify(after)} (both:${pinned}); mid ${midBefore} → ${midAfter} (first line:${linePinned})`,
      };
    })();
    report('T11 sash resize keeps both windows pinned, first line otherwise', t11.ok, t11.why);

    const t12 = await (async () => {
      const why = [];
      const stubChatFetch = () =>
        page.evaluate(() => {
          window.__chatPosts = 0;
          const realFetch = window.fetch.bind(window);
          window.fetch = (url, init) => {
            if (typeof url === 'string' && url.includes('/api/chat')) {
              window.__chatPosts += 1;
              return Promise.resolve({ ok: true, json: async () => ({}) });
            }
            return realFetch(url, init);
          };
        });
      const B_TAB_SEL = '.sf-tab-label:has-text("XWin-B:")';
      const state = () =>
        page.evaluate(() => {
          const label = Array.from(document.querySelectorAll('.sf-tab-label')).find((el) =>
            el.textContent?.includes('XWin-B:'),
          );
          const tile = label?.closest('.sf-tile');
          const msgs = tile?.querySelector('.chat-messages');
          return {
            value: tile?.querySelector('.chat-input')?.value ?? '',
            rows: msgs ? msgs.querySelectorAll('.chat-msg').length : -1,
            posts: window.__chatPosts ?? 0,
          };
        });
      const input = page
        .locator(B_TAB_SEL)
        .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " sf-tile ")][1]')
        .locator('.chat-input');
      const prime = async (sendKey) => {
        await page.evaluate((k) => {
          localStorage.setItem('sf-chat:prefs', JSON.stringify({ sendKey: k, renderMarkdown: true }));
        }, sendKey);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
        await page.waitForSelector('.chat-messages', { timeout: 30000 });
        await delay(3000);
        await switchTab('XWin-B');
      };

      await prime('shiftEnter');
      await stubChatFetch();
      await input.click({ force: true });
      await page.keyboard.type('composer-enter-probe');
      const pre = await state();
      await page.keyboard.press('Enter');
      const c1 = await state();
      const ok1 = c1.value.includes('\n') && c1.rows === pre.rows && c1.posts === 0;
      why.push(`plainEnter:${ok1 ? 'ok' : `BAD ${JSON.stringify(c1)}`}`);
      await input.dispatchEvent('keydown', { key: 'Enter', shiftKey: true });
      const c2 = await state();
      const ok2 = c2.value === c1.value && c2.rows === pre.rows && c2.posts === 0;
      why.push(`spuriousShift:${ok2 ? 'ok' : `BAD ${JSON.stringify(c2)}`}`);
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await delay(800);
      const c3 = await state();
      const ok3 = c3.value === '' && c3.rows === pre.rows + 1 && c3.posts === 1;
      why.push(`realShiftEnter:${ok3 ? 'ok' : `BAD ${JSON.stringify(c3)}`}`);

      await prime('enter');
      await stubChatFetch();
      await input.click({ force: true });
      await page.keyboard.type('composer-enter-probe-2');
      const e0 = await state();
      await input.dispatchEvent('keydown', { key: 'Enter', shiftKey: true });
      await delay(800);
      const e1 = await state();
      const ok4 = e1.value === '' && e1.rows === e0.rows + 1 && e1.posts === 1;
      why.push(`enterModeSpurious:${ok4 ? 'ok' : `BAD ${JSON.stringify(e1)}`}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
      return { ok: ok1 && ok2 && ok3 && ok4, why: why.join(' | ') };
    })();
    report('T12 composer send-key isolation (iOS spurious shiftKey, both modes)', t12.ok, t12.why);

    const t13 = await (async () => {
      await switchTab('XWin-B');
      const bTile = page
        .locator('.sf-tab-label:has-text("XWin-B:")')
        .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " sf-tile ")][1]');
      const bList = bTile.locator('.chat-messages');
      if ((await bList.count()) !== 1) return { ok: false, why: `B tile list count ${await bList.count()}` };
      const why = [];
      const inB = (fn, ...args) => bList.evaluate(fn, ...args);
      const winOf = () =>
        inB((el) => {
          const lr = el.getBoundingClientRect();
          const max = el.scrollHeight - el.clientHeight;
          const sep = window.__t13?.sep ?? null;
          const row = window.__t13?.row ?? null;
          return {
            scrollTop: el.scrollTop,
            max,
            distFromTop: el.scrollTop + max,
            sepTop: sep ? Math.round(sep.getBoundingClientRect().top - lr.top) : -1,
            rowTop: row ? Math.round(row.getBoundingClientRect().top - lr.top) : -1,
            sepH: sep ? Math.round(sep.getBoundingClientRect().height) : -1,
          };
        });
      await inB((el) => {
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * 0.5);
      });
      await delay(600);
      await inB((el) => {
        const lr = el.getBoundingClientRect();
        const tops = Array.from(el.querySelectorAll('.chat-sep')).map((s) => ({
          s,
          t: s.getBoundingClientRect().top - lr.top,
        }));
        if (!tops.some((x) => Math.abs(x.t) < 2)) {
          const next = tops.find((x) => x.t >= 2);
          if (next) el.scrollTop += Math.round(next.t);
        }
      });
      await delay(600);
      const pin = await inB((el) => {
        const lr = el.getBoundingClientRect();
        const sep = Array.from(el.querySelectorAll('.chat-sep')).find(
          (s) => Math.abs(s.getBoundingClientRect().top - lr.top) < 2,
        );
        if (!sep) return null;
        const row = sep.nextElementSibling;
        const expected = Math.round(
          row.getBoundingClientRect().top - lr.top + el.scrollTop - sep.getBoundingClientRect().height,
        );
        window.__t13 = { sep, row };
        sep.click();
        return expected;
      });
      await delay(400);
      const afterPin = await winOf();
      const pinExpected = pin ?? -1;
      const jumpOk =
        pin !== null &&
        Math.abs(afterPin.scrollTop - pinExpected) <= 3 &&
        Math.abs(afterPin.sepTop) <= 2 &&
        Math.abs(afterPin.rowTop - afterPin.sepH) <= 2;
      why.push(
        `pinnedJump:${jumpOk ? 'ok' : `BAD sepTop:${afterPin.sepTop} rowTop:${afterPin.rowTop} sepH:${afterPin.sepH} scrollTop:${afterPin.scrollTop} (want ${pinExpected})`}`,
      );
      await inB((el) => {
        el.scrollTop = -1200;
      });
      await delay(400);
      const first = await inB((el) => {
        const sep = el.querySelector('.chat-sep');
        if (!sep) return null;
        const row = sep.nextElementSibling;
        const lr = el.getBoundingClientRect();
        const off = Math.round(
          row.getBoundingClientRect().top - lr.top + el.scrollTop - sep.getBoundingClientRect().height,
        );
        window.__t13 = { sep, row };
        sep.click();
        return off;
      });
      await delay(250);
      const afterTop1 = await winOf();
      await delay(900);
      const afterTop2 = await winOf();
      const firstOffset = first ?? -1;
      const topOk =
        first !== null &&
        Math.abs(afterTop1.scrollTop - firstOffset) <= 3 &&
        Math.abs(afterTop1.sepTop) <= 2 &&
        Math.abs(afterTop1.rowTop - afterTop1.sepH) <= 2 &&
        Math.abs(afterTop2.scrollTop - afterTop1.scrollTop) <= 3 &&
        afterTop1.distFromTop < 150;
      why.push(
        `topJump:${topOk ? 'ok' : `BAD sepTop:${afterTop1.sepTop} rowTop:${afterTop1.rowTop} scrollTop:${afterTop1.scrollTop}→${afterTop2.scrollTop} (want ≈${firstOffset}, stable)`}`,
      );
      return { ok: jumpOk && topOk, why: why.join(' | ') };
    })();
    report('T13 separator click jumps to the message start — no clip, no loadOlder yank', t13.ok, t13.why);

    const t14 = await (async () => {
      await switchTab('XWin-A');
      const aTile = page
        .locator('.sf-tab-label:has-text("XWin-A:")')
        .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " sf-tile ")][1]');
      const aList = aTile.locator('.chat-messages');
      const rows = () => aList.evaluate((el) => el.querySelectorAll('.chat-msg').length);
      const heldRow = () =>
        aList.evaluate((el) => {
          const lr = el.getBoundingClientRect();
          const first = Array.from(el.querySelectorAll('[data-msg-id]')).find(
            (m) => m.getBoundingClientRect().bottom > lr.top + 2,
          );
          return {
            msgId: first?.dataset.msgId ?? null,
            top: first ? first.getBoundingClientRect().top - lr.top : null,
          };
        });
      const rowOffset = (msgId) =>
        aList.evaluate((el, id) => {
          const lr = el.getBoundingClientRect();
          const row = el.querySelector(`[data-msg-id="${id}"]`);
          return row ? row.getBoundingClientRect().top - lr.top : null;
        }, msgId);
      const posInfo = () =>
        aList.evaluate((el) => {
          const max = el.scrollHeight - el.clientHeight;
          return { top: el.scrollTop, max, distFromTop: el.scrollTop + max };
        });

      await aList.evaluate((el) => {
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * 0.4);
      });
      await delay(500);
      let olderFetches = 0;
      const routeCount = async (route) => {
        const url = route.request().url();
        if (url.includes('before=')) {
          olderFetches += 1;
          await delay(600);
        }
        await route.continue();
      };
      await page.route('**/api/sessions/messages*', routeCount);
      await aList.evaluate((el) => {
        el.scrollTop = -(el.scrollHeight - el.clientHeight);
      });
      await delay(120);
      const before = await heldRow();
      for (let i = 0; i < 10; i++) {
        await aList.evaluate((el) => {
          el.dispatchEvent(new Event('scroll'));
        });
        await delay(120);
      }
      await delay(800);
      const afterTop1 = await rowOffset(before.msgId);
      const pos1 = await posInfo();
      await page.unroute('**/api/sessions/messages*', routeCount);
      const pinned1 = before.msgId !== null && afterTop1 !== null && Math.abs(afterTop1 - before.top) <= 1;
      const leftZone1 = pos1.distFromTop >= 80;
      const phase1Ok = olderFetches === 1 && pinned1 && leftZone1;

      let touchFetches = 0;
      const older10 = Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        const user = n % 2 === 1;
        return {
          id: user ? `u${n}` : `a${n}`,
          role: user ? 'user' : 'assistant',
          text: `older ${n} — ${'padding '.repeat(20)}`,
          ts: 1700000000000 + n * 60000,
        };
      });
      const routeTouch = async (route) => {
        const url = route.request().url();
        if (url.includes('before=')) {
          touchFetches += 1;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ messages: older10, oldestId: null, hasMore: false }),
          });
        } else {
          await route.continue();
        }
      };
      await page.route('**/api/sessions/messages*', routeTouch);
      const slotHeight = () =>
        aList.evaluate((el) => {
          const slot = el.querySelector('.chat-load-older');
          return slot ? slot.getBoundingClientRect().height : -1;
        });
      const slotBefore = await slotHeight();
      await aList.evaluate((el) => {
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * 0.4);
      });
      await delay(400);
      await aList.evaluate((el) => {
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      });
      await aList.evaluate((el) => {
        window.__tr = { scrolls: [], t0: performance.now(), spinnerOn: -1, spinnerOff: -1 };
        const mo = new MutationObserver(() => {
          const on = !!el.querySelector('.chat-load-older--loading');
          const t = performance.now();
          if (on && window.__tr.spinnerOn < 0) window.__tr.spinnerOn = t;
          if (!on && window.__tr.spinnerOn >= 0 && window.__tr.spinnerOff < 0) window.__tr.spinnerOff = t;
        });
        mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        window.__mo = mo;
        el.addEventListener('scroll', () => window.__tr.scrolls.push(Math.round(el.scrollTop)));
      });
      await aList.evaluate((el) => {
        el.scrollTop = -(el.scrollHeight - el.clientHeight);
      });
      await delay(150);
      const heldBefore = await heldRow();
      const rowsWhileLoading = await rows();
      await delay(750);
      const rowsHeld = await rows();
      const heldDuring = await heldRow();
      const fetchesWhileHeld = touchFetches;
      await aList.evaluate((el) => {
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
      });
      await delay(700);
      const rowsAfter = await rows();
      const heldAfterTop = await rowOffset(heldBefore.msgId);
      const pos2 = await posInfo();
      const slotAfter = await slotHeight();
      const trace = await aList.evaluate(() => {
        const tr = window.__tr;
        return {
          ...tr,
          spinnerOnRel: tr.spinnerOn >= 0 ? Math.round(tr.spinnerOn - tr.t0) : -1,
          spinnerOffRel: tr.spinnerOff >= 0 ? Math.round(tr.spinnerOff - tr.t0) : -1,
          now: Math.round(performance.now() - tr.t0),
        };
      });
      await page.unroute('**/api/sessions/messages*', routeTouch);
      const noLoadWhileHeld =
        fetchesWhileHeld === 0 &&
        rowsWhileLoading === 100 &&
        rowsHeld === 100 &&
        heldDuring.msgId === heldBefore.msgId;
      const spinnerRan = trace.spinnerOnRel >= 0 && trace.spinnerOffRel >= 0;
      const slotReserved = slotBefore >= 30 && slotAfter === slotBefore;
      const pinned2 =
        heldBefore.msgId !== null && heldAfterTop !== null && Math.abs(heldAfterTop - heldBefore.top) <= 1;
      const committed2 = rowsAfter === 110;
      const leftZone2 = pos2.distFromTop >= 80;
      const phase2Ok =
        touchFetches === 1 &&
        noLoadWhileHeld &&
        spinnerRan &&
        slotReserved &&
        committed2 &&
        pinned2 &&
        leftZone2;
      return {
        ok: phase1Ok && phase2Ok,
        why:
          `phase1 fetches:${olderFetches} pinned:${pinned1 ? 'yes' : 'no'} ` +
          `(row ${before.msgId} ${before.top} → ${afterTop1}) leftZone:${leftZone1 ? 'yes' : 'no'} ` +
          `(distFromTop ${pos1.distFromTop}/${pos1.max}) | ` +
          `phase2 fetches:${fetchesWhileHeld}/${touchFetches} spinner:${trace.spinnerOnRel}→${trace.spinnerOffRel}ms ` +
          `(want 0/1, on→off) rows:${rowsWhileLoading}/${rowsHeld}/${rowsAfter} (want 100/100/110) ` +
          `slot:${slotBefore}→${slotAfter}px (want equal) held:${heldBefore.msgId}→${heldDuring.msgId}→` +
          `${heldAfterTop} drift:${heldBefore.top}→${heldAfterTop} leftZone:${leftZone2 ? 'yes' : 'no'} ` +
          `(distFromTop ${pos2.distFromTop}/${pos2.max}) trace:${JSON.stringify(trace)}`,
      };
    })();
    report(
      'T14 older page pins under the finger — held: 0px movement, no commit; up: 0px drift, one page',
      t14.ok,
      t14.why,
    );

    const t15 = await (async () => {
      const aIdx = await tabIndex('XWin-A:');
      if (aIdx < 0) return { ok: false, why: 'XWin-A tab not found' };
      await switchTab('XWin-A:');
      const aTile = page
        .locator('.sf-tab')
        .nth(aIdx)
        .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " sf-tile ")][1]');
      const tabText = () => aTile.locator('.sf-tab-label').allInnerTexts();
      const until = async (probe) => {
        for (let i = 0; i < 80; i++) {
          if (await probe()) return true;
          await delay(400);
        }
        return false;
      };
      await page.waitForSelector('.chat-list-item', { timeout: 20000 });
      const aRow = page.locator('.chat-list-item:has-text("XWin-A:")').first();
      if ((await aRow.count()) === 0) return { ok: false, why: 'XWin-A row missing in the session list' };
      const newTitle = 'XWin-A renamed without reload';
      await aRow.click({ button: 'right' });
      await page.locator('.sf-sm-menu .sf-sm-menu-row', { hasText: 'Rename' }).click();
      await page.locator('.chat-dialog-input').fill(newTitle);
      await page.getByRole('button', { name: 'Save' }).click();
      const rowShows = async () =>
        (await page.locator(`.chat-list-item:has-text("${newTitle}")`).count()) > 0;
      const tabShows = async () => (await tabText()).some((t) => t.includes(newTitle));
      const updated = await until(async () => (await rowShows()) && (await tabShows()));
      return {
        ok: updated,
        why: `row:${(await rowShows()) ? 'ok' : 'stale'} tab:${(await tabShows()) ? 'ok' : 'stale'}`,
      };
    })();
    report('T15 rename updates the open tab label and history row (no reload)', t15.ok, t15.why);

    const t17 = await (async () => {
      const marker = 'XWin-B:';
      const i = await tabIndex(marker);
      if (i >= 0) {
        await page.locator('.sf-tab-label').nth(i).click({ button: 'middle' });
        for (let k = 0; k < 20 && (await tabIndex(marker)) >= 0; k++) await delay(300);
        if ((await tabIndex(marker)) >= 0) return { ok: false, why: 'could not close XWin-B tab' };
      }
      await delay(600);
      await page.locator(`.chat-list-item:has-text("${marker}")`).first().click({ force: true });
      await page.waitForSelector('.chat-messages', { timeout: 20000 });
      const reviewTab = page.locator(`.sf-tab:has-text("${marker}")`).first();
      await reviewTab.waitFor({ state: 'visible', timeout: 10000 });
      const reviewOn = async () => ((await reviewTab.getAttribute('class')) ?? '').includes('sf-tab--review');
      await delay(3000);
      const dimEarly = await reviewOn();
      await delay(16000);
      const dimAfterPoll = await reviewOn();
      await page.locator('.sf-tab-label', { hasText: marker }).first().click({ force: true });
      await delay(1200);
      const dimAfterPin = await reviewOn();
      return {
        ok: dimEarly && dimAfterPoll && !dimAfterPin,
        why: `dim@3s:${dimEarly} dim@19s:${dimAfterPoll} dimAfterTabClick:${dimAfterPin}`,
      };
    })();
    report(
      'T17 review tab stays dimmed through message loads, list polls and pins on tab click',
      t17.ok,
      t17.why,
    );

    const t18 = await (async () => {
      const why = [];
      await switchTab('XWin-B:');
      const input = page
        .locator('.sf-tab-label:has-text("XWin-B:")')
        .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " sf-tile ")][1]')
        .locator('.chat-input');
      const metrics = () =>
        input.evaluate((el) => ({
          h: el.offsetHeight,
          scrollable: el.scrollHeight - el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
        }));
      await input.fill('');
      await delay(300);
      const empty = await metrics();
      await input.fill('one\ntwo\nthree');
      await delay(300);
      const three = await metrics();
      await input.fill(`${'autogrow probe line\n'.repeat(40)}`);
      await delay(300);
      const big = await metrics();
      await input.fill('shrunk back to a single line');
      await delay(300);
      const shrunk = await metrics();
      await input.fill('');
      const growOk = three.h > empty.h + 20 && three.h < 300 && three.scrollable <= 0;
      const capOk = Math.abs(big.h - 320) <= 1 && big.scrollable > 0 && big.overflowY === 'auto';
      const shrinkOk = Math.abs(shrunk.h - empty.h) <= 2;
      why.push(
        `grow ${empty.h}→${three.h} (ok:${growOk})`,
        `cap h=${big.h} scroll=${big.scrollable} ovf=${big.overflowY} (ok:${capOk})`,
        `shrink →${shrunk.h} (ok:${shrinkOk})`,
      );
      let mobileOk = false;
      let mobileWhy = 'n/a';
      let mob;
      try {
        mob = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await mob.goto(`http://127.0.0.1:${ports.vite}`, { waitUntil: 'domcontentloaded' });
        await mob.waitForSelector('.chat-list-item', { timeout: 60000 });
        await mob.locator('.chat-list-item').first().click({ force: true });
        await mob.waitForSelector('.chat-input', { timeout: 20000 });
        await delay(1500);
        await mob.setViewportSize({ width: 420, height: 900 });
        await delay(600);
        const minput = mob.locator('.chat-input').first();
        const mm = () =>
          minput.evaluate((el) => ({
            h: el.offsetHeight,
            scrollable: el.scrollHeight - el.clientHeight,
            overflowY: getComputedStyle(el).overflowY,
          }));
        await minput.fill(`${'mobile autogrow probe line\n'.repeat(40)}`);
        await delay(300);
        const mBig = await mm();
        await minput.fill('mobile single line');
        await delay(300);
        const mSmall = await mm();
        const capMob = Math.abs(mBig.h - 120) <= 1 && mBig.scrollable > 0 && mBig.overflowY === 'auto';
        const shrinkMob = mSmall.h < 120 && mSmall.scrollable <= 0;
        mobileOk = capMob && shrinkMob;
        mobileWhy = `cap h=${mBig.h} scroll=${mBig.scrollable} ovf=${mBig.overflowY}; small h=${mSmall.h}`;
      } catch (e) {
        mobileWhy = `error: ${e.message}`;
      } finally {
        if (mob) await mob.close().catch(() => {});
      }
      why.push(`mobile (ok:${mobileOk}) ${mobileWhy}`);
      return { ok: growOk && capOk && shrinkOk && mobileOk, why: why.join(' | ') };
    })();
    report('T18 chat input auto-grows to its cap then scrolls (desktop + mobile)', t18.ok, t18.why);

    const t19 = await (async () => {
      const histSub = page.locator('.sf-subsection:has([data-sub-body="history"])');
      const plusBtn = histSub.locator('.sf-subsection-util[title="New Chat (Ctrl+N)"]');
      const newRow = () => page.locator('[data-sub-body="history"] .chat-list-item:has-text("New Chat")');
      await histSub.locator('.sf-subsection-header').hover();
      await delay(150);
      for (let i = 0; i < 3; i++) {
        await plusBtn.click({ force: true });
        await delay(900);
      }
      await delay(1200);
      const rowsAfterPlus = await newRow().count();
      const newTabs = await page.locator('.sf-tab:has-text("New Chat")').count();
      const savedPending = await page.evaluate(() => localStorage.getItem('sf-chat:pending'));
      const composer = page.locator('.chat-input').first();
      await composer.fill('pins the lazy tab');
      await delay(900);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-list-item', { timeout: 60000 });
      await delay(4000);
      const rowsAfterReload = await newRow().count();
      const tabsAfterReload = await page.locator('.sf-tab:has-text("New Chat")').count();
      const ghostsAfterReload = await page.locator('.sf-tab--ghost').count();
      return {
        ok:
          rowsAfterPlus === 0 &&
          newTabs === 1 &&
          savedPending === null &&
          rowsAfterReload === 0 &&
          tabsAfterReload === 0 &&
          ghostsAfterReload === 0,
        why: `rowsAfter3xPlus:${rowsAfterPlus} tabs:${newTabs} savedPending:${savedPending ?? 'null'} rowsAfterReload:${rowsAfterReload} tabsAfterReload:${tabsAfterReload} ghosts:${ghostsAfterReload}`,
      };
    })();
    report(
      'T19 lazy New Chat never shows in history nor persists — one window only, gone after reload',
      t19.ok,
      t19.why,
    );

    const t20 = await (async () => {
      const jsonlFiles = () => fs.readdirSync(TEST_SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
      const agentStates = () =>
        page.evaluate(() =>
          fetch('/api/agent-states')
            .then((r) => r.json())
            .then((j) => j.states ?? []),
        );
      const draftsClean = async () => {
        const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem('sf-chat:drafts') || '{}'));
        const onDisk = new Set(jsonlFiles());
        const stale = Object.keys(drafts).filter((k) => !onDisk.has(path.basename(decodeURIComponent(k))));
        return { ok: stale.length === 0, stale: stale.length };
      };
      const statesFileClean = () => {
        if (!fs.existsSync(TEST_STATES_PATH)) return true;
        const onDisk = new Set(jsonlFiles());
        let j;
        try {
          j = JSON.parse(fs.readFileSync(TEST_STATES_PATH, 'utf8'));
        } catch {
          return false;
        }
        return (j.entries ?? []).every((e) => onDisk.has(path.basename(e.file)));
      };
      const filesBefore = jsonlFiles().length;
      const agentsBefore = (await agentStates()).length;
      const boot = await draftsClean();
      const histSub = page.locator('.sf-subsection:has([data-sub-body="history"])');
      const plusBtn = histSub.locator('.sf-subsection-util[title="New Chat (Ctrl+N)"]');
      await histSub.locator('.sf-subsection-header').hover();
      await delay(150);
      await plusBtn.click({ force: true });
      await delay(1200);
      const lazyTile = page.locator('.sf-tile:has(.sf-tab:has-text("New Chat"))').first();
      await lazyTile.locator('.chat-input').first().fill('unsent lazy draft');
      await delay(600);
      const filesWithLazyOpen = jsonlFiles().length;
      const pendingWhileOpen = (await agentStates()).length;
      await page.locator('.sf-tab:has-text("New Chat")').first().click({ button: 'middle' });
      let pendingAfterClose = -1;
      for (let i = 0; i < 20; i++) {
        await delay(300);
        pendingAfterClose = (await agentStates()).length;
        if (pendingAfterClose <= agentsBefore) break;
      }
      const filesAfterClose = jsonlFiles().length;
      const drafts = await draftsClean();
      const statesOk = statesFileClean();
      return {
        ok:
          boot.ok &&
          filesWithLazyOpen === filesBefore &&
          pendingWhileOpen === agentsBefore + 1 &&
          pendingAfterClose === agentsBefore &&
          filesAfterClose === filesBefore &&
          drafts.ok &&
          statesOk,
        why: `bootDraftsStale:${boot.stale} files:${filesBefore}→${filesWithLazyOpen}→${filesAfterClose} agents:${agentsBefore}→${pendingWhileOpen}→${pendingAfterClose} draftsStale:${drafts.stale} statesFileClean:${statesOk}`,
      };
    })();
    report(
      'T20 lazy New Chat leaves nothing behind — no file, pending dropped on close, drafts/states clean',
      t20.ok,
      t20.why,
    );

    const t21 = await (async () => {
      const marker = 'XWin-D:';
      const i = await tabIndex(marker);
      if (i >= 0) {
        await page.locator('.sf-tab-label').nth(i).click({ button: 'middle' });
        for (let k = 0; k < 20 && (await tabIndex(marker)) >= 0; k++) await delay(300);
      }
      await page.setViewportSize({ width: 450, height: 900 });
      await delay(500);
      const dockChat = page.locator('.sf-docker-app[title="Chat"]');
      const openList = async () => {
        await dockChat.click();
        await delay(400);
      };
      await openList();
      await page.locator(`.chat-list-item:has-text("${marker}")`).first().click({ force: true });
      await delay(2500);
      await page.locator('.sf-panel-close-btn').click();
      await delay(400);
      const label = page.locator('.sf-mobile-tab-label');
      await label.waitFor({ state: 'visible', timeout: 10000 });
      const reviewOn = () => label.evaluate((el) => el.classList.contains('sf-tab--review'));
      const dimBefore = await reviewOn();
      const b = await label.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await delay(900);
      await page.mouse.up();
      await delay(600);
      const pinned = !(await reviewOn());
      const dropdownClosed = (await page.locator('.sf-tab-dropdown').count()) === 0;
      await openList();
      await page.locator('.chat-list-item:has-text("XWin-C:")').first().click({ force: true });
      await delay(2500);
      await page.locator('.sf-panel-close-btn').click();
      await delay(400);
      await label.click();
      await delay(300);
      const rows = await page.locator('.sf-tab-dropdown .sf-tab-dropdown-label').allInnerTexts();
      const kept = rows.some((t) => t.includes('XWin-D'));
      const freshReview = await reviewOn();
      await page.locator('.sf-tab-dropdown-close').click();
      await delay(200);
      await page.setViewportSize({ width: 1440, height: 900 });
      await delay(500);
      return {
        ok: dimBefore && pinned && dropdownClosed && kept && freshReview,
        why: `review:${dimBefore} pinnedByLongPress:${pinned} dropdownStayedClosed:${dropdownClosed} pinnedTabKept:${kept} nextChatIsReview:${freshReview}`,
      };
    })();
    report(
      'T21 mobile: long-press on the tab selection bar makes a window out of review mode',
      t21.ok,
      t21.why,
    );

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
