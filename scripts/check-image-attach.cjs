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

const SUITE_STAMP = 'image-attach-check-stack';

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'image-attach-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const PROMPT_LOG = path.join(RUN_ROOT, 'prompts.jsonl');
const STUB_MODELS = [
  {
    id: 'stub-pro',
    provider: 'stub',
    name: 'Stub Pro',
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    input: ['text', 'image'],
    api: 'openai-completions',
    baseUrl: 'https://stub.example/v1',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
  },
];

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
  const dir = path.join(SESSIONS_ROOT, '--tmp-image-attach--');
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
    JSON.stringify({
      type: 'model_change',
      id: `${name}-mc0`,
      parentId: `${name}-a0`,
      timestamp: new Date().toISOString(),
      provider: 'stub',
      modelId: 'stub-pro',
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

function buildBmp(w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelOffset = 54;
  const size = pixelOffset + rowSize * h;
  const buf = Buffer.alloc(size, 0);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(pixelOffset, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = pixelOffset + y * rowSize + x * 3;
      buf[o] = (x * 5) % 256;
      buf[o + 1] = (y * 7) % 256;
      buf[o + 2] = 128;
    }
  }
  return buf;
}

function parseDataUrl(src) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(src || '');
  if (!m) return null;
  return { mime: m[1], data: m[2], head: m[2].slice(0, 8) };
}

(async () => {
  const { report, isFailed } = makeReporter();
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: SUITE_STAMP, browserRef, label: 'image-attach' });
  let browser;
  try {
    assertMemoryHeadroom({ label: 'image-attach' });
    sweepStaleStackProcesses(SUITE_STAMP, { label: 'image-attach' });
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    const F = writeSessionFile('image-attach-check');
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
          STUB_MODELS_JSON: JSON.stringify(STUB_MODELS),
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_SPILL_PATH: path.join(RUN_ROOT, 'backend-spill.json'),
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/image-attach-backend.log', 'a'),
          fs.openSync('/tmp/image-attach-backend.log', 'a'),
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
            fs.openSync('/tmp/image-attach-vite.log', 'a'),
            fs.openSync('/tmp/image-attach-vite.log', 'a'),
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
    await page.waitForSelector('.sf-pl-item:has-text("image-attach-check")', { timeout: 60000 });
    await delay(2000);
    await page.locator('.sf-pl-item:has-text("image-attach-check")').first().click({ force: true });
    await page.waitForSelector('.chat-window', { timeout: 20000 });
    await delay(1500);

    const canvasDataUrl = (type) =>
      page.evaluate((t) => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 32;
        const g = c.getContext('2d');
        g.fillStyle = '#3366cc';
        g.fillRect(0, 0, 64, 32);
        g.fillStyle = '#ffcc00';
        g.fillRect(8, 8, 20, 16);
        return c.toDataURL(t);
      }, type);

    const pngB64 = (await canvasDataUrl('image/png')).split(',')[1];
    const jpegB64 = (await canvasDataUrl('image/jpeg')).split(',')[1];
    if (!pngB64.startsWith('iVBOR') || !jpegB64.startsWith('/9j')) {
      throw new Error('fixture generation failed');
    }
    const BMP = buildBmp(40, 30);

    const attach = async (name, mimeType, buffer) => {
      await page.setInputFiles('.chat-image-input', { name, mimeType, buffer });
      for (let k = 0; k < 40; k++) {
        if ((await page.locator('.chat-attach-chip').count()) >= 1) break;
        await delay(250);
      }
      await delay(300);
      const src = await page.locator('.chat-attach-chip .chat-attach-thumb').first().getAttribute('src');
      return parseDataUrl(src);
    };
    const clearChips = async () => {
      while ((await page.locator('.chat-attach-chip').count()) > 0) {
        await page.locator('.chat-attach-remove').first().dispatchEvent('click');
        await delay(250);
      }
    };

    const bmpChip = await attach('shot.png', 'image/png', BMP);
    report(
      'clipboard-style BMP bytes labeled image/png are re-encoded to a provider-safe format',
      !!bmpChip && bmpChip.mime === 'image/jpeg' && bmpChip.head.startsWith('/9j'),
      JSON.stringify(bmpChip && { mime: bmpChip.mime, head: bmpChip.head }),
    );
    await clearChips();

    const pngChip = await attach('dot.png', 'image/png', Buffer.from(pngB64, 'base64'));
    report(
      'a real PNG stays untouched (mime corrected from sniffing, bytes identical)',
      !!pngChip && pngChip.mime === 'image/png' && pngChip.data === pngB64,
      JSON.stringify(pngChip && { mime: pngChip.mime, same: pngChip.data === pngB64 }),
    );
    await clearChips();

    const jpegChip = await attach('photo.png', 'image/png', Buffer.from(jpegB64, 'base64'));
    report(
      'a real JPEG mislabeled as image/png is delivered as image/jpeg',
      !!jpegChip && jpegChip.mime === 'image/jpeg' && jpegChip.data === jpegB64,
      JSON.stringify(jpegChip && { mime: jpegChip.mime, same: jpegChip.data === jpegB64 }),
    );
    await clearChips();

    await page.locator('.chat-input').fill('image attach end-to-end');
    await attach('shot.png', 'image/png', BMP);
    await page.locator('.chat-send-btn').dispatchEvent('click');
    let flush = null;
    for (let k = 0; k < 60; k++) {
      flush = readPrompts().find((p) => p.agentId === F && p.message === 'image attach end-to-end');
      if (flush) break;
      await delay(500);
    }
    report(
      'the prompt the backend receives carries the re-encoded image',
      !!flush &&
        flush.images === 1 &&
        flush.imageDetails?.[0]?.mime === 'image/jpeg' &&
        flush.imageDetails?.[0]?.head.startsWith('/9j'),
      JSON.stringify(flush && { images: flush.images, imageDetails: flush.imageDetails }),
    );
    await clearChips();

    report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    report('suite crashed', false, e.stack || e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }

  if (isFailed()) {
    console.log('\nIMAGE-ATTACH CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL IMAGE-ATTACH CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
