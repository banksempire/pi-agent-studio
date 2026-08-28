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

const SUITE_STAMP = 'queue-msg-check-stack';

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-msg-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const PROMPT_LOG = path.join(RUN_ROOT, 'prompts.jsonl');

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
  const dir = path.join(SESSIONS_ROOT, '--tmp-queue-msg--');
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

function readPrompts() {
  try {
    return fs
      .readFileSync(PROMPT_LOG, 'utf8')
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
  installStackCleanup({ procs, stamp: SUITE_STAMP, browserRef, label: 'queue-msg' });
  let browser;
  try {
    assertMemoryHeadroom({ label: 'queue-msg' });
    sweepStaleStackProcesses(SUITE_STAMP, { label: 'queue-msg' });
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    const F = writeSessionFile('queue-msg-check');
    fs.rmSync(PROMPT_LOG, { force: true });

    procs.push(
      spawnStackProc(spawn, SUITE_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        detached: true,
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          STUB_PROMPT_LOG: PROMPT_LOG,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_SPILL_PATH: path.join(RUN_ROOT, 'backend-spill.json'),
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/queue-msg-backend.log', 'a'),
          fs.openSync('/tmp/queue-msg-backend.log', 'a'),
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
            fs.openSync('/tmp/queue-msg-vite.log', 'a'),
            fs.openSync('/tmp/queue-msg-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-list-item:has-text("queue-msg-check")', { timeout: 60000 });
    await delay(2000);
    await page.locator('.chat-list-item:has-text("queue-msg-check")').first().click({ force: true });
    await page.waitForSelector('.chat-window', { timeout: 20000 });
    await delay(1500);

    const queueBtn = page.locator('.chat-queue-btn');
    const input = page.locator('.chat-input');
    const boxes = page.locator('.chat-queue-box');

    const hiddenQueueBtn = async () => {
      const el = await queueBtn.evaluate((node) => {
        const cls = node.getAttribute('class') || '';
        return {
          hidden: cls.includes('chat-queue-btn--hidden'),
          visible: getComputedStyle(node).visibility !== 'hidden',
        };
      });
      return el;
    };

    const actionRects = () =>
      page.evaluate(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: +r.x.toFixed(1), y: +r.y.toFixed(1) };
        };
        return {
          scroll: pick('.chat-scroll-btn'),
          image: pick('.chat-image-btn'),
          send: pick('.chat-send-btn'),
        };
      });

    const t1 = await hiddenQueueBtn();
    report('idle + empty input → queue button hidden', t1.hidden && !t1.visible, JSON.stringify(t1));

    await input.fill('idle text');
    await delay(300);
    const t2 = await hiddenQueueBtn();
    report('idle + text → queue button still hidden', t2.hidden && !t2.visible, JSON.stringify(t2));

    const idleRects = await actionRects();

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    await input.fill('');
    for (let i = 0; i < 40; i++) {
      const stop = await page.locator('.chat-send-btn--stop').count();
      if (stop === 1) break;
      await delay(250);
    }
    report('session running (Stop button shows)', (await page.locator('.chat-send-btn--stop').count()) === 1);

    await delay(300);
    const t3 = await hiddenQueueBtn();
    report('running + empty input → queue button hidden', t3.hidden && !t3.visible, JSON.stringify(t3));

    await input.fill('first queued message');
    await delay(300);
    const t4 = await hiddenQueueBtn();
    report('running + text → queue button visible', !t4.hidden && t4.visible, JSON.stringify(t4));

    const runningRects = await actionRects();
    const samePos =
      idleRects.scroll.x === runningRects.scroll.x &&
      idleRects.image.x === runningRects.image.x &&
      idleRects.image.y === runningRects.image.y;
    report(
      'other buttons keep their position when the queue button hides/shows',
      samePos,
      `idle:${JSON.stringify(idleRects.image)} running:${JSON.stringify(runningRects.image)}`,
    );

    await queueBtn.click({ force: true });
    await delay(400);
    report(
      'queueing moves the input text into one box and clears the input',
      (await input.inputValue()) === '' && (await boxes.count()) === 1,
    );

    await input.fill('second queued message with more words');
    await queueBtn.click({ force: true });
    await delay(400);
    const boxTexts = await boxes.allInnerTexts();
    report(
      'two boxes, top box is the first queued message',
      (await boxes.count()) === 2 &&
        boxTexts[0].includes('first queued message') &&
        boxTexts[1].includes('second queued message'),
      JSON.stringify(boxTexts),
    );

    await boxes.nth(1).locator('[title="Remove from queue"]').click();
    await delay(300);
    report(
      'cancel button removes that message from the queue',
      (await boxes.count()) === 1 && (await boxes.first().innerText()).includes('first queued message'),
    );

    await boxes.first().locator('[title="Edit this queued message"]').click();
    await delay(300);
    const editPopup = page.locator('.chat-queue-edit');
    report('edit button opens the edit popup', (await editPopup.count()) === 1);
    const editArea = page.locator('.chat-queue-edit-text');
    report(
      'popup shows the queued text',
      (await editArea.inputValue()) === 'first queued message',
      await editArea.inputValue(),
    );
    await editArea.fill('first queued message (edited)');
    await page.locator('.chat-queue-edit-btn--primary').click();
    await delay(300);
    report(
      'saving the popup updates the box text',
      (await editPopup.count()) === 0 &&
        (await boxes.count()) === 1 &&
        (await boxes.first().innerText()).includes('(edited)'),
    );

    await input.fill('third message');
    await queueBtn.click({ force: true });
    await delay(300);
    report('queue holds two messages before the flush', (await boxes.count()) === 2);

    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    let flushed = null;
    for (let i = 0; i < 40; i++) {
      const prompts = readPrompts().filter((p) => p.agentId === F);
      if (prompts.length >= 1) {
        flushed = prompts[0];
        break;
      }
      await delay(250);
    }
    report(
      'session going idle auto-sends the first queued message to the backend',
      !!flushed && flushed.message === 'first queued message (edited)',
      JSON.stringify(flushed),
    );
    report(
      'auto-send never interrupts (wait semantics)',
      !!flushed && flushed.interrupt === false,
      JSON.stringify(flushed),
    );
    await delay(1500);
    report(
      'after the flush only the second queued message remains',
      (await boxes.count()) === 1 && (await boxes.first().innerText()).includes('third message'),
    );
    const sentBubble = await page
      .locator('.chat-user-bubble', { hasText: 'first queued message (edited)' })
      .count();
    report('flushed message appears in the transcript as a sent user message', sentBubble === 1);

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }
    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    let secondFlush = null;
    for (let i = 0; i < 40; i++) {
      const prompts = readPrompts().filter((p) => p.agentId === F);
      if (prompts.length >= 2) {
        secondFlush = prompts[1];
        break;
      }
      await delay(250);
    }
    report(
      'next finish flushes the remaining message in FIFO order',
      !!secondFlush && secondFlush.message === 'third message',
      JSON.stringify(secondFlush),
    );
    await delay(1000);
    report('queue empties completely after all messages are sent', (await boxes.count()) === 0);

    report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    report('suite crashed', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }

  if (isFailed()) {
    console.log('\nQUEUE-MSG CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL QUEUE-MSG CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
