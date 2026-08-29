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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
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

    const t4b = await page.evaluate(() => {
      const m = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      };
      return {
        scroll: m('.chat-scroll-btn'),
        image: m('.chat-image-btn'),
        queue: m('.chat-queue-btn'),
        send: m('.chat-send-btn:not(.chat-send-btn--stop)'),
      };
    });
    const sameSize =
      !!t4b.queue &&
      !!t4b.send &&
      Math.abs(t4b.queue.w - t4b.send.w) <= 0.5 &&
      Math.abs(t4b.queue.h - t4b.send.h) <= 0.5;
    report(
      'queue button is exactly the same size as the send button',
      sameSize,
      `queue:${JSON.stringify(t4b.queue)} send:${JSON.stringify(t4b.send)}`,
    );

    const rowOk =
      !!t4b.scroll &&
      !!t4b.image &&
      t4b.scroll.x < t4b.image.x &&
      t4b.image.x < t4b.queue.x &&
      t4b.queue.x < t4b.send.x &&
      [t4b.scroll, t4b.image, t4b.queue, t4b.send].every((r) => Math.abs(r.y - t4b.send.y) <= 1);
    report('button row order is [to bottom][image][queue][send] on one line', rowOk, JSON.stringify(t4b));

    const t4c = {
      label: (await queueBtn.innerText()).trim(),
      icons: await queueBtn.locator('svg').count(),
    };
    report(
      'queue button is text-only (label, no icon)',
      t4c.label === 'Queue' && t4c.icons === 0,
      JSON.stringify(t4c),
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

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }

    await input.fill('layout short');
    await queueBtn.click({ force: true });
    await input.fill('L'.repeat(400));
    await queueBtn.click({ force: true });
    await delay(400);

    const layout = await page.evaluate(() => {
      const q = document.querySelector('.chat-queue');
      const inputEl = document.querySelector('.chat-input');
      const texts = [...document.querySelectorAll('.chat-queue-box .chat-queue-text')];
      const boxesEls = [...document.querySelectorAll('.chat-queue-box')];
      const composer = document.querySelector('.chat-composer');
      const acts = [...document.querySelectorAll('.chat-queue-box .chat-queue-act')].map((b) => ({
        text: (b.textContent || '').trim(),
        icons: b.querySelectorAll('svg').length,
      }));
      const clampedOne = texts.find((t) => t.scrollWidth > t.clientWidth);
      return {
        inComposer: !!q && !!q.closest('.chat-composer'),
        aboveInput:
          !!q && !!inputEl && q.getBoundingClientRect().bottom <= inputEl.getBoundingClientRect().top,
        clamped: !!clampedOne,
        allNowrap: texts.every((t) => getComputedStyle(t).whiteSpace === 'nowrap'),
        maxBoxW: Math.max(...boxesEls.map((b) => b.getBoundingClientRect().width), 0),
        composerW: composer ? composer.getBoundingClientRect().width : 0,
        actCount: acts.length,
        boxCount: boxesEls.length,
        acts,
      };
    });
    report(
      'queue boxes live inside the input panel, above the input',
      layout.inComposer && layout.aboveInput,
    );
    report(
      'long queued text is truncated inside its box (no blowout)',
      layout.clamped && layout.allNowrap && layout.maxBoxW > 0 && layout.maxBoxW <= layout.composerW,
      `maxBox:${layout.maxBoxW.toFixed(1)} composer:${layout.composerW.toFixed(1)} clamped:${layout.clamped}`,
    );
    report(
      'box actions are icon-only (text first, then edit and cancel per box)',
      layout.actCount === layout.boxCount * 2 && layout.acts.every((a) => a.text === '' && a.icons === 1),
      `${layout.actCount} acts / ${layout.boxCount} boxes`,
    );

    const firstBox = boxes.first();
    await firstBox.locator('[title="Edit this queued message"]').click();
    await delay(300);
    await page.locator('.chat-queue-edit-text').press('Escape');
    await delay(200);
    report(
      'Esc closes the edit popup without changing the message',
      (await page.locator('.chat-queue-edit').count()) === 0 &&
        (await firstBox.innerText()).includes('layout short'),
    );
    await firstBox.locator('[title="Edit this queued message"]').click();
    await delay(300);
    await page.locator('.chat-queue-edit-text').fill('changed but cancelled');
    await page.locator('.chat-queue-edit-btn:not(.chat-queue-edit-btn--primary)').click();
    await delay(200);
    report(
      'Cancel in the edit popup keeps the original text',
      (await page.locator('.chat-queue-edit').count()) === 0 &&
        (await firstBox.innerText()).includes('layout short'),
    );
    await firstBox.locator('[title="Edit this queued message"]').click();
    await delay(300);
    await page.locator('.chat-queue-edit-text').fill('');
    report(
      'Save is disabled for an empty edit',
      await page.locator('.chat-queue-edit-btn--primary').isDisabled(),
    );
    await page.locator('.chat-queue-edit-text').press('Escape');
    await delay(200);
    await boxes.nth(1).locator('[title="Remove from queue"]').click();
    await firstBox.locator('[title="Remove from queue"]').click();
    await delay(300);
    report('boxes removed until the queue is empty again', (await boxes.count()) === 0);

    const idleBaseline = readPrompts().filter((p) => p.agentId === F).length;
    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    await delay(2500);
    report(
      'idle transitions with an empty queue never send anything',
      readPrompts().filter((p) => p.agentId === F).length === idleBaseline,
    );

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await input.fill('with attachment');
    await delay(300);
    await page.setInputFiles('.chat-image-input', {
      name: 'dot.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    for (let i = 0; i < 30; i++) {
      if ((await page.locator('.chat-attach-chip').count()) === 1) break;
      await delay(250);
    }
    const hiddenWithAttach = await hiddenQueueBtn();
    report(
      'queue button hides while an image is attached (running + text)',
      hiddenWithAttach.hidden && !hiddenWithAttach.visible,
      JSON.stringify(hiddenWithAttach),
    );
    await page.locator('.chat-attach-remove').click();
    await delay(400);
    const visibleNoAttach = await hiddenQueueBtn();
    report(
      'queue button returns once the attachment is removed',
      !visibleNoAttach.hidden && visibleNoAttach.visible,
      JSON.stringify(visibleNoAttach),
    );
    await input.fill('');

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }
    await input.fill('direct send while running');
    await delay(300);
    const directBefore = readPrompts().filter((p) => p.agentId === F).length;
    await page.locator('.chat-send-btn:not(.chat-send-btn--stop)').click();
    let directPrompt = null;
    for (let i = 0; i < 40; i++) {
      const prompts = readPrompts().filter((p) => p.agentId === F);
      if (prompts.length > directBefore) {
        directPrompt = prompts[prompts.length - 1];
        break;
      }
      await delay(250);
    }
    report(
      'normal Send while running always interrupts the current job (interrupt:true)',
      !!directPrompt &&
        directPrompt.message === 'direct send while running' &&
        directPrompt.interrupt === true,
      JSON.stringify(directPrompt),
    );

    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 0) break;
      await delay(250);
    }
    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }
    await input.fill('survive alpha');
    await queueBtn.click({ force: true });
    await input.fill('survive beta');
    await queueBtn.click({ force: true });
    await delay(500);
    const storedQueues = await page.evaluate(() => localStorage.getItem('sf-chat:queues'));
    report(
      'queued messages are persisted to localStorage',
      !!storedQueues && storedQueues.includes('survive alpha') && storedQueues.includes('survive beta'),
      (storedQueues || '').slice(0, 120),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-window', { timeout: 30000 });
    for (let i = 0; i < 40; i++) {
      if ((await boxes.count()) === 2) break;
      await delay(500);
    }
    const reloadedTexts = await boxes.allInnerTexts();
    report(
      'queued messages survive a page restart (boxes restored, order kept)',
      (await boxes.count()) === 2 &&
        reloadedTexts[0].includes('survive alpha') &&
        reloadedTexts[1].includes('survive beta'),
      JSON.stringify(reloadedTexts),
    );
    report(
      'nothing was auto-sent while the session still runs after restart',
      readPrompts().filter((p) => p.agentId === F && p.message === 'survive alpha').length === 0,
    );

    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    let surviveFlush = null;
    for (let i = 0; i < 40; i++) {
      surviveFlush = readPrompts().find((p) => p.agentId === F && p.message === 'survive alpha');
      if (surviveFlush) break;
      await delay(250);
    }
    report(
      'after the restart the queue still auto-sends on idle (exactly once)',
      !!surviveFlush &&
        readPrompts().filter((p) => p.agentId === F && p.message === 'survive alpha').length === 1 &&
        surviveFlush.interrupt === false,
      JSON.stringify(surviveFlush),
    );
    await delay(1000);
    report('one box left after the first post-restart flush', (await boxes.count()) === 1);

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }
    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    let surviveFlush2 = null;
    for (let i = 0; i < 40; i++) {
      surviveFlush2 = readPrompts().find((p) => p.agentId === F && p.message === 'survive beta');
      if (surviveFlush2) break;
      await delay(250);
    }
    report(
      'second queued message flushes after the next finish (exactly once)',
      !!surviveFlush2 &&
        readPrompts().filter((p) => p.agentId === F && p.message === 'survive beta').length === 1,
      JSON.stringify(surviveFlush2),
    );
    await delay(1000);
    const storedAfter = await page.evaluate(() => {
      const j = JSON.parse(localStorage.getItem('sf-chat:queues') || '{}');
      return Object.values(j).flat().length;
    });
    report(
      'queue storage is empty once everything is delivered',
      (await boxes.count()) === 0 && storedAfter === 0,
      `boxes:${await boxes.count()} storedItems:${storedAfter}`,
    );

    stub.emit('session_status', F, { status: 'running' });
    stub.setStates([{ agentId: F, status: 'running' }]);
    for (let i = 0; i < 40; i++) {
      if ((await page.locator('.chat-send-btn--stop').count()) === 1) break;
      await delay(250);
    }
    await input.fill('multi one');
    await queueBtn.click({ force: true });
    await input.fill('multi two');
    await queueBtn.click({ force: true });
    await delay(500);

    const page2 = await context.newPage();
    page2.on('pageerror', (e) => errors.push(`page2 pageerror: ${e.message}`));
    page2.on('console', (m) => {
      if (m.type() === 'error') errors.push(`page2 console: ${m.text()}`);
    });
    await page2.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('.chat-window', { timeout: 30000 });
    const boxes2 = page2.locator('.chat-queue-box');
    for (let i = 0; i < 40; i++) {
      if ((await boxes2.count()) === 2) break;
      await delay(500);
    }
    report(
      'a second tab restores the same queue from shared storage',
      (await boxes2.count()) === 2,
      `tab2 boxes:${await boxes2.count()}`,
    );

    await input.fill('multi three');
    await queueBtn.click({ force: true });
    let adopted = false;
    for (let i = 0; i < 20; i++) {
      if ((await boxes2.count()) === 3) {
        adopted = true;
        break;
      }
      await delay(500);
    }
    report('a queue action in one tab appears in the other (storage event)', adopted);

    stub.emit('session_status', F, { status: 'idle' });
    stub.setStates([]);
    let multiOne = null;
    for (let i = 0; i < 40; i++) {
      const prompts = readPrompts().filter((p) => p.agentId === F && p.message === 'multi one');
      if (prompts.length > 0) {
        multiOne = prompts;
        break;
      }
      await delay(500);
    }
    report(
      'two tabs idle-flush together: the claim guard delivers exactly once',
      !!multiOne && multiOne.length === 1 && multiOne[0].interrupt === false,
      `deliveries:${multiOne ? multiOne.length : 0}`,
    );
    let bothSynced = false;
    for (let i = 0; i < 20; i++) {
      if ((await boxes.count()) === 2 && (await boxes2.count()) === 2) {
        bothSynced = true;
        break;
      }
      await delay(500);
    }
    report('both tabs converge to the same remaining queue', bothSynced);

    await boxes.first().locator('[title="Remove from queue"]').click();
    await delay(300);
    let cancelSynced = false;
    for (let i = 0; i < 20; i++) {
      if ((await boxes.count()) === 1 && (await boxes2.count()) === 1) {
        cancelSynced = true;
        break;
      }
      await delay(500);
    }
    await boxes.first().locator('[title="Remove from queue"]').click();
    for (let i = 0; i < 20; i++) {
      if ((await boxes.count()) === 0 && (await boxes2.count()) === 0) break;
      await delay(500);
    }
    report(
      'cancelling in one tab clears the boxes in the other too',
      cancelSynced && (await boxes.count()) === 0 && (await boxes2.count()) === 0,
    );
    await page2.close();

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
