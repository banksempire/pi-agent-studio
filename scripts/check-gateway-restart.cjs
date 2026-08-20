const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PRODUCT_ROOT = path.join(__dirname, '..');
const PROTO_PATH = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'proto', 'pi_nest.proto');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-restart-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const GATEWAY_LOG = '/tmp/gw-restart-check-backend.log';
const VITE_LOG = '/tmp/gw-restart-check-vite.log';

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

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', reject);
  });
}

function makeSessionFile() {
  const dir = path.join(SESSIONS_ROOT, '--restart-check--');
  fs.mkdirSync(dir, { recursive: true });
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const file = path.join(dir, 'restart-chat.jsonl');
  const base = Date.now() - 60_000;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date(base).toISOString(),
      cwd: RUN_ROOT,
    }),
    JSON.stringify({
      type: 'message',
      id: 'seedu0',
      parentId: id,
      timestamp: new Date(base).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'seed q0' }], timestamp: base },
    }),
    JSON.stringify({
      type: 'message',
      id: 'seeda0',
      parentId: 'seedu0',
      timestamp: new Date(base + 500).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'seed a0' }],
        timestamp: base + 500,
        stopReason: 'stop',
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.utimesSync(file, new Date(base), new Date(base));
  return file;
}

async function startStubNest(port, sessFile) {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const piNest = grpc.loadPackageDefinition(packageDefinition).pi_nest;
  let stream = null;
  let n = 0;
  let lastId = 'seeda0';
  let promptChain = Promise.resolve();
  const server = new grpc.Server();
  const writeEvent = async (type, file, payload) => {
    if (!stream) throw new Error('no relay subscriber');
    const ok = stream.write({ type, file, json: JSON.stringify(payload ?? {}) });
    if (!ok) await new Promise((r) => stream.once('drain', r)).catch(() => {});
  };
  server.addService(piNest.PiNest.service, {
    ping: (_c, cb) => cb(null, { ok: true }),
    createSession: (_c, cb) => cb(null, { file: '/unused' }),
    openAgent: (_c, cb) => cb(null, { ok: true, state: null }),
    closeAgent: (_c, cb) => cb(null, { ok: true }),
    prompt: (call, cb) => {
      const run = async () => {
        const file = call.request.agentId;
        const text = call.request.message;
        await writeEvent('ack', file, { reqId: call.request.reqId ?? '', kind: 'message' });
        n += 1;
        const ts = Date.now();
        await writeEvent('message', file, { id: `pending-${ts}`, role: 'user', text, ts });
        fs.appendFileSync(
          sessFile,
          `${JSON.stringify({ type: 'message', id: `stub-u${n}`, parentId: lastId, timestamp: new Date(ts).toISOString(), message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts } })}\n`,
        );
        lastId = `stub-u${n}`;
        await writeEvent('session_status', file, { status: 'running', runningSince: ts });
        await writeEvent('message', file, { id: `user-${ts}`, role: 'user', text, ts });
        await writeEvent('refresh', file, {});
        await delay(60);
        const ats = ts + 500;
        const reply = `REPLY-${n}-MARKER: ${'stub answer text '.repeat(6)}`;
        await writeEvent('message', file, {
          id: `asst-${ats}`,
          role: 'assistant',
          text: reply.slice(0, 20),
          ts: ats,
        });
        await delay(60);
        fs.appendFileSync(
          sessFile,
          `${JSON.stringify({ type: 'message', id: `stub-a${n}`, parentId: lastId, timestamp: new Date(ats).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: ats, stopReason: 'stop' } })}\n`,
        );
        lastId = `stub-a${n}`;
        await writeEvent('message', file, {
          id: `asst-${ats}`,
          role: 'assistant',
          text: reply,
          ts: ats,
          stopReason: 'stop',
        });
        await writeEvent('refresh', file, {});
        await writeEvent('session_status', file, { status: 'idle' });
        await writeEvent('refresh', file, {});
      };
      promptChain = promptChain.then(run, run);
      promptChain = promptChain.then(
        () => cb(null, { ok: true }),
        (e) => cb({ code: grpc.status.INTERNAL, message: String(e) }),
      );
    },
    abort: (_c, cb) => cb(null, { ok: true }),
    slash: (_c, cb) => cb(null, { ok: true, notice: '' }),
    getSlashCatalog: (_c, cb) => cb(null, { commandsJson: '[]', skillsJson: '[]' }),
    listStates: (_c, cb) => cb(null, { states: [] }),
    getAgentState: (_c, cb) => cb(null, { state: null }),
    subscribe: (call) => {
      stream = call;
      call.on('cancelled', () => {
        if (stream === call) stream = null;
      });
    },
  });
  return new Promise((resolve, reject) => {
    server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) return reject(err);
      resolve({ server });
    });
  });
}

const spawnGateway = (port, nestPort) =>
  spawn('node', ['src/pi-studio/server/index.mjs'], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_PORT: String(port),
      PI_NEST_PORT: String(nestPort),
      PI_STUDIO_SESSIONS: SESSIONS_ROOT,
      PI_STUDIO_STATES_PATH: STATES_PATH,
      PI_STUDIO_CWD: RUN_ROOT,
    },
    stdio: ['ignore', fs.openSync(GATEWAY_LOG, 'a'), fs.openSync(GATEWAY_LOG, 'a')],
    detached: true,
  });

(async () => {
  const { report, isFailed } = makeReporter();
  const nestPort = await freePort();
  const backendPort = await freePort();
  const vitePort = await freePort();
  console.log(`stack: stub-nest :${nestPort} gateway :${backendPort} vite :${vitePort}`);
  const sessFile = makeSessionFile();
  const stub = await startStubNest(nestPort, sessFile);
  let gateway = spawnGateway(backendPort, nestPort);
  let vite = null;
  let browser = null;

  const cleanup = async () => {
    try {
      if (browser) await browser.close();
    } catch {}
    for (const child of [gateway, vite]) {
      try {
        if (child) process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
    stub.server.tryShutdown(() => {});
    setTimeout(() => fs.rmSync(RUN_ROOT, { recursive: true, force: true }), 1000).unref();
  };

  try {
    for (let i = 0; i < 60; i++) {
      try {
        if (await getJson(backendPort, '/api/health')) break;
      } catch {}
      await delay(500);
    }
    vite = spawn(
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
        stdio: ['ignore', fs.openSync(VITE_LOG, 'w'), fs.openSync(VITE_LOG, 'w')],
        detached: true,
      },
    );
    for (let i = 0; i < 60; i++) {
      try {
        const r = await new Promise((resolve, reject) => {
          http
            .get(`http://127.0.0.1:${vitePort}/`, (res) => {
              res.resume();
              resolve(res.statusCode);
            })
            .on('error', reject);
        });
        if (r === 200) break;
      } catch {}
      await delay(500);
    }

    browser = await chromium.launch();
    const netLog = [];
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    for (const [tag, p] of [
      ['A', pageA],
      ['B', pageB],
    ]) {
      p.on('pageerror', (e) => console.log(`page${tag} pageerror: ${e.message}`));
      p.on('response', (r) => {
        const u = r.url();
        if (u.includes('/api/events/heartbeat')) netLog.push(`${tag} hb ${r.status()}`);
        else if (u.includes('/api/events') && u.includes('open'))
          netLog.push(`${tag} open-views ${r.status()}`);
        else if (u.includes('/api/sessions/messages'))
          netLog.push(`${tag} msgs ${r.status()} ${u.slice(u.indexOf('?') + 1, u.indexOf('?') + 60)}`);
      });
      await p.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForSelector('.chat-list-item', { timeout: 60000 });
      await p.locator('.chat-list-item').first().click({ force: true, timeout: 15000 });
      await p.waitForSelector('.chat-messages', { timeout: 30000 });
    }
    await delay(3000);

    const hasMarker = async (p, marker) =>
      (await p.locator('.chat-messages', { timeout: 10000 }).getByText(marker, { exact: false }).count()) > 0;
    const health = () => getJson(backendPort, '/api/health');
    const sendFrom = async (p, n) => {
      await p.bringToFront();
      await p.fill('.chat-input', `msg ${n}`);
      await p.press('.chat-input', 'Enter');
    };

    await sendFrom(pageA, 1);
    for (let i = 0; i < 20; i++) {
      await delay(500);
      if (await hasMarker(pageA, 'REPLY-1-MARKER')) break;
    }
    report(
      'T1 baseline: send before outage reaches both pages',
      (await hasMarker(pageA, 'REPLY-1-MARKER')) && (await hasMarker(pageB, 'REPLY-1-MARKER')),
    );

    process.kill(-gateway.pid, 'SIGKILL');
    await delay(5000);
    gateway = spawnGateway(backendPort, nestPort);
    for (let i = 0; i < 60; i++) {
      try {
        if (await getJson(backendPort, '/api/health')) break;
      } catch {}
      await delay(500);
    }
    await delay(3000);

    await sendFrom(pageA, 2);
    await sendFrom(pageA, 3);
    await sendFrom(pageB, 4);
    for (let i = 0; i < 30; i++) {
      await delay(500);
      if (
        (await hasMarker(pageA, 'REPLY-4-MARKER')) &&
        (await hasMarker(pageB, 'REPLY-4-MARKER')) &&
        (await hasMarker(pageA, 'REPLY-2-MARKER')) &&
        (await hasMarker(pageB, 'REPLY-2-MARKER'))
      )
        break;
    }

    const h = await health();
    const missing = [];
    for (const m of ['A', 'B']) {
      for (const n of [2, 3, 4]) {
        if (!(await hasMarker(m === 'A' ? pageA : pageB, `REPLY-${n}-MARKER`))) missing.push(`${m}:${n}`);
      }
    }
    report(
      'T2 after gateway restart: both pages keep receiving new turns (replies 2-4 visible)',
      missing.length === 0,
      missing.length ? `missing ${missing.join(' ')}` : '',
    );
    fs.writeFileSync('/tmp/gw-restart-net.log', netLog.join('\n'));
    const tailCheck = await getJson(
      backendPort,
      `/api/sessions/messages?file=${encodeURIComponent(sessFile)}&after=seeda0`,
    );
    console.log(`server tail after seeda0: ${(tailCheck.messages ?? []).map((m) => m.id).join(',')}`);
    const rawIds = fs
      .readFileSync(sessFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const e = JSON.parse(l);
          return `${e.id}<-${e.parentId}`;
        } catch {
          return 'PARSE-ERR';
        }
      });
    console.log(`file entries: ${rawIds.join(' ')}`);
    report(
      'T3 both SSE connections re-established with views after restart',
      h.sseClients === 2 && h.sseViews === 2,
      `clients=${h.sseClients} views=${h.sseViews}`,
    );

    await sendFrom(pageB, 5);
    for (let i = 0; i < 20; i++) {
      await delay(500);
      if (await hasMarker(pageA, 'REPLY-5-MARKER')) break;
    }
    report(
      'T4 cross-page after recovery: A sees the turn sent from B',
      await hasMarker(pageA, 'REPLY-5-MARKER'),
    );
  } catch (e) {
    report('suite crashed', false, String(e?.stack ? e.stack : e));
  }

  await cleanup();
  console.log(isFailed() ? 'gateway-restart check: FAILED' : 'gateway-restart check: all passed');
  process.exit(isFailed() ? 1 : 0);
})();
