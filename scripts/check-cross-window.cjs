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
 *  - T6 resize anchoring: at the bottom a resize keeps the view pinned to
 *    the bottom edge; scrolled up, the FIRST VISIBLE LINE stays put
 *    (scrollTop preserved) while the messages area grows/shrinks.
 *  - T7 reload restore: a page refresh wipes the runtime scroll memory,
 *    so EVERY restored window must come back pinned to the bottom —
 *    switching to a non-active restored tab must not strand it on the
 *    oldest page.
 *  - T13 separator click (chat bar): clicking a pinned separator jumps to
 *    the start of that message — the separator lands at the top with the
 *    row right below it (never clipped under the sticky bar), and the
 *    jump's own near-top scroll must not trigger loadOlder (which would
 *    re-anchor the view a page away).
 *  - T14 held-finger top bounce: on a touch device the older page loads
 *    ONLY after the finger releases — never during the gesture. The
 *    message list is an INVERTED scroll container (column-reverse; scroll
 *    origin at the bottom/newest), so prepending an older page grows the
 *    far end and the already-loaded rows keep their exact distance from
 *    the origin: 0px shift BY CONSTRUCTION, under a held finger, mid-
 *    gesture, or during iOS's release animation alike. With a REAL held
 *    finger (touch events; iOS Safari fires no pointer events for scroll
 *    gestures) zero before= fetches start while the finger is down and the
 *    list does not move 1px; on touchend exactly one fetch lands and
 *    commits with 0px drift and the position left out of the <80 trigger
 *    zone (distFromTop >= 80).
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
      // Both withTool sessions reuse the SAME message-id space ('a2' is the
      // first assistant id in every session): their first work group gets
      // the identically-keyed id 'work-a2' — the collision class the open
      // map must isolate. The content keeps a text reply so the turn flows.
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
  // D and E share the same message-id space — their first work group is
  // identically keyed 'work-a2' in both (the collision the open map must
  // isolate per session).
  sessionFile('XWin-D', 20, { withTool: true }); // first assistant = work-a2
  sessionFile('XWin-E', 20, { withTool: true }); // collides with D on work-a2
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
        const max = el.scrollHeight - el.clientHeight;
        // Inverted flow (column-reverse), Chromium convention: scrollTop ∈
        // [-max, 0], 0 = bottom (newest). distFromTop = px from the OLDER
        // edge — the loadOlder trigger zone is distFromTop < 80.
        return { top: el.scrollTop, max, distFromTop: el.scrollTop + max };
      });
    const setScrollFrac = (frac) =>
      page.evaluate((f) => {
        // frac: 0 = the older edge, 1 = the bottom (newest). Inverted
        // flow: the older edge is scrollTop = -max.
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
        // Inverted flow: cross to the OLDER edge (scrollTop = -max) to
        // trigger loadOlder.
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

    // ── T9: expanded work-group box must not ride into the next window ────

    const t9 = await (async () => {
      // D and E share the message-id space: their first work group is
      // identically keyed 'work-a2' in both. Expanding it in D must not
      // render E's same-keyed box expanded (the pre-fix shared `open` ref
      // leaked the key across the component-instance reuse).
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
      // The default view is the BOTTOM (newest) in the inverted flow; the
      // image message sits mid-history — scroll it to the list top first.
      // (Playwright's scrollIntoViewIfNeeded misjudges column-reverse
      // containers, so scroll the container manually: target scrollTop =
      // current + the element's screen offset from the list top.)
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

    // ── T6: resize keeps bottom pinned when sticky, first line otherwise ──

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
        el.scrollTop = 0; // the bottom (newest) edge in the inverted flow → sticky
      });
      await delay(600);
      const bottomBefore = await scrollState();
      await drag(-130); // grow the composer → messages area shrinks
      const bottomAfter = await scrollState();
      const pinnedBottom = bottomAfter.distFromTop >= bottomAfter.max - 3;
      await setScrollFrac(0.4); // scrolled up → not sticky
      await delay(600);
      const mid = await scrollState();
      await drag(260); // shrink the composer → messages area grows
      const midAfter = await scrollState();
      const linePinned = Math.abs(midAfter.top - mid.top) <= 3;
      // Restore the composer's auto height (double-click resets).
      const bb = await handle.boundingBox();
      await page.mouse.dblclick(bb.x + bb.width / 2, bb.y + 4);
      await delay(500);
      return {
        ok: pinnedBottom && linePinned,
        why: `bottom ${bottomBefore.top}/${bottomBefore.max} → ${bottomAfter.top}/${bottomAfter.max} (pinned:${pinnedBottom}); mid ${mid.top} → ${midAfter.top} (first line pinned:${linePinned})`,
      };
    })();
    report('T6 resize pins bottom when sticky, first line otherwise', t6.ok, t6.why);

    // ── T7: after a reload every restored window sits at the bottom ──────

    const t7 = await (async () => {
      // Repro: a reload wipes the runtime scroll memory, so every session
      // starts fresh (top=0 / sticky=true). The ACTIVE window mounts and
      // scrolls to the bottom, but switching to another restored tab used
      // to treat that fresh top=0 as a real position and strung the window
      // on the oldest page. Every restored window must be at the bottom.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
      await page.waitForSelector('.chat-messages', { timeout: 30000 });
      await delay(3500); // list fetch + ghost reconcile + message load
      const atBottom = async () => {
        await delay(500);
        const s = await scrollState();
        return { ok: s.distFromTop >= s.max - 3, s };
      };
      const why = [];
      const first = await atBottom(); // the window active at refresh
      why.push(`active:${first.s.top}/${first.s.max}`);
      const results = [first.ok];
      // Click every restored tab — each must come back pinned to the
      // bottom (B is checked twice: first switch and a round-trip).
      for (const m of ['XWin-B:', 'XWin-A:', 'XWin-C:', 'XWin-B:']) {
        await switchTab(m);
        const r = await atBottom();
        results.push(r.ok);
        why.push(`${m.trim()} ${r.s.top}/${r.s.max}`);
      }
      return { ok: results.every(Boolean), why: why.join('; ') };
    })();
    report('T7 reload restores every window pinned to the bottom', t7.ok, t7.why);

    // ── T8: reload then split — both windows must be at the bottom ───────

    const t8 = await (async () => {
      // Repro: 2 tabs restored by a reload, then one tab dragged out to a
      // side-by-side split. Both windows must sit at the bottom.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
      await page.waitForSelector('.chat-messages', { timeout: 30000 });
      await delay(3500);
      // The failing path needs the dragged tab ACTIVE: the drag rebinds
      // the shared tile instance B→A, capturing B's position, then the
      // new tile mounts B from that capture.
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
        const info = (el) => ({
          top: el.scrollTop,
          max: el.scrollHeight - el.clientHeight,
          distFromTop: el.scrollTop + (el.scrollHeight - el.clientHeight),
        });
        const beforeR = info(r);
        l.scrollTop = -Math.round((l.scrollHeight - l.clientHeight) * 0.5); // scroll LEFT
        const afterR = info(r);
        return { beforeR, afterR };
      });
      return {
        ok: Math.abs(res.afterR.top - res.beforeR.top) <= 2,
        why: `right window: ${res.beforeR.top} → ${res.afterR.top} after scrolling left`,
      };
    })();
    report('T5 split-tile windows scroll independently', t5.ok, t5.why);

    // ── T10: a window whose session vanished blocks the composer on top ───

    const t10 = await (async () => {
      // A session deleted from disk while its window stays open drops out of
      // the list on the next refresh. The composer must not keep looking
      // interactive (send would silently no-op): the whole input panel is
      // blocked by a banner ON TOP of all its controls — never by pushing
      // the controls to the side. Other windows keep their composers.
      await switchTab('XWin-E');
      await delay(600);
      const before = await page.evaluate(() => ({
        blocks: document.querySelectorAll('.chat-composer-block').length,
        inputDisabled: document.querySelectorAll('.chat-window .chat-input')[0]?.disabled ?? null,
      }));
      // Delete E's session file; write a fresh session file so the backend
      // file watcher emits a refresh (deletion alone is not detected), which
      // makes the frontend re-fetch the list and drop E.
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
      // Backend watcher polls every 2s; frontend re-fetches on the SSE
      // refresh and drops E.
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
      // Other windows (the split tile, e.g. B) must keep a usable composer.
      await switchTab('XWin-B');
      const other = await page.evaluate(() => {
        // Two tiles are mounted side by side: inspect EVERY window instead
        // of the first in DOM order (E's window may precede B's).
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

    // ── T11: split-sash resize keeps BOTH windows pinned to the bottom ────

    const t11 = await (async () => {
      // Repro (reported): two chat windows side by side, then dragging the
      // divider between the tiles. The narrower window's content reflows
      // taller, so the resize re-pin lands below the NEW bottom — and the
      // pin's own scroll event, dispatched against the grown scrollHeight,
      // read mid-list and cleared sticky, stranding the window there. Both
      // windows must stay pinned to the bottom edge at ANY width.
      await switchTab('XWin-A'); // left tile: A's usable window
      await delay(800);
      const sash = page.locator('.sf-sash').first();
      if ((await sash.count()) === 0) return { ok: false, why: 'no sash (split missing)' };
      // The workspace may hold several sashes (nested splits from earlier
      // drags): pick the VERTICAL one sitting between the two chat windows.
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
      // Pin BOTH windows to the bottom, then drag the sash (A wider, B
      // narrower — the direction that used to strand B mid-list).
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
      // MID-scroll first-line case: scroll one window away from the bottom,
      // drag the sash — the first visible line must stay put (scrollTop
      // preserved), never yanked to the bottom.
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

    // ── T12: composer send-key isolation (iOS spurious shiftKey) ──────────

    const t12 = await (async () => {
      // Repro: in shiftEnter mode, a SECOND plain Enter on iPhone Safari
      // used to SEND — iOS virtual keyboards can report shiftKey=true on a
      // Return keydown with no real Shift keypress (auto-capitalize state).
      // The fix trusts shiftKey only when a real Shift keydown was observed
      // (window-level tracker); e.isComposing guards IME-confirm Enters.
      // The positive cases stub fetch at the /api/chat boundary, so the
      // suite's own pi-nest never runs a real agent.
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

      // shiftEnter mode: plain Enter = newline, real Shift+Enter = send.
      await prime('shiftEnter');
      await stubChatFetch();
      await input.click({ force: true });
      await page.keyboard.type('composer-enter-probe');
      const pre = await state();
      // 1) plain Enter: newline inserted, nothing sent.
      await page.keyboard.press('Enter');
      const c1 = await state();
      const ok1 = c1.value.includes('\n') && c1.rows === pre.rows && c1.posts === 0;
      why.push(`plainEnter:${ok1 ? 'ok' : `BAD ${JSON.stringify(c1)}`}`);
      // 2) iOS-style spurious-shift Enter (no real Shift keydown ever fired).
      await input.dispatchEvent('keydown', { key: 'Enter', shiftKey: true });
      const c2 = await state();
      const ok2 = c2.value === c1.value && c2.rows === pre.rows && c2.posts === 0;
      why.push(`spuriousShift:${ok2 ? 'ok' : `BAD ${JSON.stringify(c2)}`}`);
      // 3) real Shift+Enter sends exactly once (optimistic row + stubbed post).
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await delay(800);
      const c3 = await state();
      const ok3 = c3.value === '' && c3.rows === pre.rows + 1 && c3.posts === 1;
      why.push(`realShiftEnter:${ok3 ? 'ok' : `BAD ${JSON.stringify(c3)}`}`);

      // 'enter' mode: a spurious-shift Enter must SEND (trusted as plain Enter).
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
      // Leave the page clean: the reload drops the fetch stub (nothing after
      // this uses the page's network stack).
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sf-tab-label:has-text("XWin-B:")', { timeout: 30000 });
      return { ok: ok1 && ok2 && ok3 && ok4, why: why.join(' | ') };
    })();
    report('T12 composer send-key isolation (iOS spurious shiftKey, both modes)', t12.ok, t12.why);

    // ── T13: separator click (chat bar) jumps to the message start ────────

    const t13 = await (async () => {
      // Repro (reported): clicking the chat bar (the pinned separator) to
      // jump to the start of a message undershoots when the first item of
      // the group is a bubble. The old jump aligned the ROW with the list
      // top, so the sticky separator pinned ON TOP of the row — hiding the
      // first item (a bubble loses its top). And the jump's own near-top
      // scroll (< 80px) read as a scroll-up gesture, so loadOlder fetched
      // the older page and re-anchored the view a page away from the jump
      // target. The jump must align the SEPARATOR with the content top (the
      // row starts right below it) and must not trigger loadOlder.
      await switchTab('XWin-B');
      // Scope to B's OWN tile — with two windows side by side the first
      // .chat-messages in the DOM may be the OTHER window's (the split-root
      // state from T11; A's window can precede B's in DOM order).
      const bTile = page
        .locator('.sf-tab-label:has-text("XWin-B:")')
        .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " sf-tile ")][1]');
      const bList = bTile.locator('.chat-messages');
      if ((await bList.count()) !== 1) return { ok: false, why: `B tile list count ${await bList.count()}` };
      const why = [];
      const inB = (fn, ...args) => bList.evaluate(fn, ...args);
      // Post-jump geometry of a SPECIFIC sep/row pair (the clicked one —
      // the first separator in the list is the top of the chat and would be
      // far above after a mid-chat jump). The element refs survive because
      // the click happens in the same evaluation that returns them.
      // Post-jump geometry of the clicked sep/row pair. The refs live on
      // window.__t13 (set in the click evaluation — DOM elements cannot
      // cross the evaluate boundary). The first separator in the list is
      // the top of the chat and would be far above after a mid-chat jump,
      // so measuring it would prove nothing.
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
      // 1) Click the PINNED separator mid-chat: the separator must land at
      //    the top and the row must start right below it (rowTop ≈ sepH,
      //    never 0 — the old overlap hid the first item). Measure the
      //    PINNED separator's row (not the first sep in the list).
      await inB((el) => {
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * 0.5);
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
      // 2) Click the FIRST separator (top of the chat): the jump lands near
      //    the top (< 80px from the older edge) — the loadOlder trigger must
      //    NOT fire and yank the view a page away (XWin-B has 60 messages >
      //    1 page).
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
      await delay(900); // let any (buggy) loadOlder settle and re-anchor
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

    // ── T14: held-finger top bounce must not page through history ────────

    const t14 = await (async () => {
      // Repro (reported on a touch device): scroll to the top of the loaded
      // content auto-loads the older page; a user who does not release
      // their hand immediately keeps the scroll position AT the top, so
      // after the reload the previously loaded content flicked to the top
      // and the next bounce re-triggered loadOlder — page after page, with
      // flicker.
      //
      // The fix (per the user's prescription): the older page is appended
      // to the HEAD of the previously loaded content WITHOUT moving it 1px.
      // The messages box is an INVERTED scroll container (column-reverse,
      // origin at the bottom), so prepending grows the FAR end and the
      // loaded rows keep their exact distance from the origin — the 0px pin
      // is structural, not a scroll write, which is what makes it hold even
      // under a held finger / mid-gesture / during iOS's release
      // animation.
      //
      // Phase 1 (desktop / quiet top): exactly ONE before= fetch from the
      // crossing + scroll burst, the pinned row at 0px drift, position out
      // of the <80 trigger zone (distFromTop >= 80).
      // Phase 2 (real held finger, touch events): ZERO loads may start
      // while the finger is held at the older edge (0px movement — the
      // list does not even grow); on touchend exactly one page loads and
      // commits, the finger-held row lands at the SAME viewport offset and
      // the position leaves the trigger zone.
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
      // Offset of a SPECIFIC row (the one held before the load) — after the
      // prepend the first visible row is a different one (the page above),
      // so the pin assertion must follow the SAME row id.
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

      // ── Phase 1: scroll burst at the top, no touch ────────────────────

      // Start mid-list so the coming jump to the older edge is a real
      // crossing.
      await aList.evaluate((el) => {
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * 0.4);
      });
      await delay(500);
      let olderFetches = 0;
      // Delay the REAL older page through the wire (600ms) so the "finger"
      // is held while the fetch is in flight — count the before= fetches.
      const routeCount = async (route) => {
        const url = route.request().url();
        if (url.includes('before=')) {
          olderFetches += 1;
          await delay(600);
        }
        await route.continue();
      };
      await page.route('**/api/sessions/messages*', routeCount);
      // The crossing: scroll to the OLDER edge (−max) → onScroll fires
      // loadOlder. The fetch is still in flight when we snapshot the held
      // row 120ms later.
      await aList.evaluate((el) => {
        el.scrollTop = -(el.scrollHeight - el.clientHeight);
      });
      await delay(120);
      const before = await heldRow();
      // In-place scroll events at the CURRENT position while the fetch lands
      // (the browser owns scrollTop — the app must not need to fight it).
      for (let i = 0; i < 10; i++) {
        await aList.evaluate((el) => {
          el.dispatchEvent(new Event('scroll'));
        });
        await delay(120);
      }
      await delay(800); // let fetch + prepend + re-anchor settle
      const afterTop1 = await rowOffset(before.msgId);
      const pos1 = await posInfo();
      await page.unroute('**/api/sessions/messages*', routeCount);
      const pinned1 = before.msgId !== null && afterTop1 !== null && Math.abs(afterTop1 - before.top) <= 1;
      const leftZone1 = pos1.distFromTop >= 80;
      const phase1Ok = olderFetches === 1 && pinned1 && leftZone1;

      // ── Phase 2: a REAL held finger (touch events) ────────────────────

      // The touch contract (per the user): the older page is loaded ONLY
      // after the finger is released. While the finger is down at the older
      // edge, ZERO before= fetches may start; on touchend exactly one
      // fetch starts, lands pinned (0px drift), and leaves the position out
      // of the <80 trigger zone. Touch events (not pointer events): iOS
      // Safari dispatches no pointer events for scroll gestures.
      let touchFetches = 0;
      // Stub the older-page response INSTANTLY (no network — a real fetch
      // would take ~440ms in this harness and outlast the release window,
      // masking the bug). The remaining older messages of XWin-A are u1..a10.
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
      // Mid-list, then put the finger DOWN on the list and cross to the
      // older edge.
      await aList.evaluate((el) => {
        el.scrollTop = -Math.round((el.scrollHeight - el.clientHeight) * 0.4);
      });
      await delay(400);
      await aList.evaluate((el) => {
        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      });
      await aList.evaluate((el) => {
        // Page-side trace: when the loading spinner appears (load started)
        // and clears (commit landed), plus every scroll event — the settle
        // window is the spinner ON→OFF span.
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
        el.scrollTop = -(el.scrollHeight - el.clientHeight); // crossing to the older edge while the finger is down
      });
      await delay(150);
      const heldBefore = await heldRow();
      const rowsWhileLoading = await rows();
      // Hold the finger at the older edge for longer than the whole fetch
      // would take: NO load may start and the list must not grow (rows stay
      // 100, the held row does not move 1px).
      await delay(750);
      const rowsHeld = await rows();
      const heldDuring = await heldRow();
      const fetchesWhileHeld = touchFetches;
      // Finger up: the load starts NOW and commits as soon as the fetch
      // completes (the inverted flow makes the commit a pure prepend — the
      // loaded rows cannot move, so there is no need to wait out any
      // release animation).
      await aList.evaluate((el) => {
        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
      });
      await delay(700); // commit + re-anchor + settle
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
      // The spinner must have appeared (load started) and cleared (commit
      // landed). The span is the fetch duration — the commit is immediate;
      // the 0px pin no longer depends on timing.
      const spinnerRan = trace.spinnerOnRel >= 0 && trace.spinnerOffRel >= 0;
      // The load-older slot is PERMANENT: its height above the pinned row is
      // identical before and after the load (the marker only changes text,
      // never geometry). If it were removed on the last page, the whole list
      // would shift up by the slot height exactly when the page lands.
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
