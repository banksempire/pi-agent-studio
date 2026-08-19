const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PRODUCT_ROOT = path.join(__dirname, '..');
const PROTO_PATH = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'proto', 'pi_nest.proto');
const BACKEND_LOG = '/tmp/sse-flood-backend.log';
const BACKEND_HEAP_MB = Number(process.env.SSE_FLOOD_HEAP_MB || 256);

const FLOOD_FILE = '/tmp/sse-flood/session.jsonl';
const MSG_ID = 'flood-m1';
const PHASE1_FRAMES = 1200;
const PHASE1_PAYLOAD = 300_000;
const PHASE2_IDS = 220;
const PHASE2_PAYLOAD = 200_000;
const QUEUE_CAP_MB = Number(process.env.SSE_FLOOD_QUEUE_CAP_MB || 4);

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

function parseFrames(buf) {
  const events = [];
  for (const block of buf.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
  return events;
}

function startStubNest(port) {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const piNest = grpc.loadPackageDefinition(packageDefinition).pi_nest;
  let stream = null;
  const server = new grpc.Server();
  server.addService(piNest.PiNest.service, {
    ping: (_, cb) => cb(null, { ok: true }),
    listStates: (_, cb) => cb(null, { states: [] }),
    getAgentState: (_, cb) => cb(null, { state: null }),
    subscribe: (call) => {
      stream = call;
    },
  });
  const writeEvent = async (type, payload) => {
    if (!stream) throw new Error('no relay subscriber yet');
    const okToWrite = stream.write({ type, file: FLOOD_FILE, json: JSON.stringify(payload) });
    if (!okToWrite) await once(stream, 'drain').catch(() => {});
  };
  return new Promise((resolve, reject) => {
    server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err, bound) => {
      if (err) return reject(err);
      resolve({ server, writeEvent, bound });
    });
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
  });
}

async function waitHealthy(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const h = await health(port);
    if (h.status === 200) return h;
    await delay(500);
  }
  throw new Error('backend did not come up');
}

function fastSseClient(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      const state = { buf: '', closed: false };
      res.on('data', (c) => (state.buf += c));
      res.on('end', () => (state.closed = true));
      res.on('error', () => (state.closed = true));
      const waitReady = async () => {
        for (let i = 0; i < 50; i++) {
          if (state.buf.includes('event: ready')) return state;
          await delay(200);
        }
        throw new Error('fast client never got ready');
      };
      waitReady().then(() => resolve(state), reject);
    });
    req.on('error', reject);
  });
}

function stalledSseClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write('GET /api/events HTTP/1.1\r\nHost: t\r\nAccept: text/event-stream\r\n\r\n');
      resolve(sock);
    });
    sock.on('error', (e) => {
      if (e.code !== 'ECONNRESET') reject(e);
    });
  });
}

(async () => {
  const { report, isFailed } = makeReporter();
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-flood-sessions-'));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-flood-cwd-'));
  const nestPort = await freePort();
  const backendPort = await freePort();
  const stub = await startStubNest(nestPort);
  let backend = null;
  let backendDied = '';

  const spawnBackend = () => {
    backend = spawn(
      process.execPath,
      [`--max-old-space-size=${BACKEND_HEAP_MB}`, 'src/pi-studio/server/index.mjs'],
      {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_NEST_PORT: String(nestPort),
          PI_STUDIO_SESSIONS: sessionsDir,
          PI_STUDIO_CWD: cwdDir,
          PI_STUDIO_SSE_MAX_QUEUED: String(QUEUE_CAP_MB * 1024 * 1024),
        },
        stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
      },
    );
    backend.on('exit', (code, signal) => {
      backendDied = `exit=${code} signal=${signal}`;
    });
  };

  const cleanup = () => {
    try {
      stub.server.tryShutdown(() => {});
    } catch {}
    if (backend && backend.exitCode === null && !backend.killed) {
      try {
        process.kill(backend.pid, 'SIGTERM');
      } catch {}
    }
    for (const d of [sessionsDir, cwdDir]) fs.rmSync(d, { recursive: true, force: true });
  };

  try {
    spawnBackend();
    await waitHealthy(backendPort);
    const fast = await fastSseClient(backendPort);
    const slow = await stalledSseClient(backendPort);
    await delay(800);

    for (let i = 1; i <= PHASE1_FRAMES; i++) {
      const isFinal = i === PHASE1_FRAMES;
      await stub.writeEvent('message', {
        id: MSG_ID,
        role: 'assistant',
        text: isFinal
          ? `FINAL-STATE ${'x'.repeat(PHASE1_PAYLOAD)}`
          : `frame ${i} ${'x'.repeat(PHASE1_PAYLOAD)}`,
        ts: Date.now(),
      });
    }
    await delay(1500);

    const h1 = await health(backendPort);
    report(
      `T1 backend survives ${PHASE1_FRAMES}x300KB same-message flood with a stalled client (heap cap ${BACKEND_HEAP_MB}MB)`,
      h1.status === 200 && !backendDied,
      backendDied ||
        (h1.json
          ? `heap=${Math.round(h1.json.mem.heapUsed / 1048576)}MB sseQ=${Math.round((h1.json.sseQueued ?? 0) / 1048576)}MB`
          : `status=${h1.status}`),
    );

    const slowBuf = { buf: '' };
    slow.on('data', (c) => (slowBuf.buf += c));
    slow.resume();
    let finalSeen = false;
    for (let i = 0; i < 60 && !finalSeen; i++) {
      await delay(500);
      finalSeen = slowBuf.buf.includes('FINAL-STATE');
    }
    const slowEvents = parseFrames(slowBuf.buf);
    const m1Frames = slowEvents.filter((e) => e.type === 'message' && e.message?.id === MSG_ID);
    const lastM1 = m1Frames[m1Frames.length - 1];
    report(
      'T2 stalled client still receives the final message state (fold, not drop)',
      finalSeen && !!lastM1 && lastM1.message.text.startsWith('FINAL-STATE'),
      `frames for ${MSG_ID}: ${m1Frames.length}/${PHASE1_FRAMES} sent, final=${finalSeen}`,
    );
    report(
      'T3 superseded snapshots were folded (queue stayed tiny)',
      m1Frames.length < PHASE1_FRAMES / 10,
      `${m1Frames.length} frames delivered of ${PHASE1_FRAMES}`,
    );

    slow.pause();
    slow.removeAllListeners('data');
    let dropped = slow.destroyed;
    slow.once('close', () => (dropped = true));
    for (let i = 0; i < PHASE2_IDS; i++) {
      await stub.writeEvent('message', {
        id: `burst-${i}`,
        role: 'assistant',
        text: `burst ${i} ${'y'.repeat(PHASE2_PAYLOAD)}`,
        ts: Date.now(),
      });
    }
    for (let i = 0; i < 60 && !dropped && !backendDied; i++) {
      await delay(500);
      if (i === 4) slow.resume();
    }
    const h2 = await health(backendPort);
    report(
      `T4 non-foldable burst (${PHASE2_IDS}x200KB, >${QUEUE_CAP_MB}MB) trips the loud disconnect, not the OOM`,
      dropped && h2.status === 200 && !backendDied,
      `dropped=${dropped} health=${h2.status} ${backendDied}`,
    );

    await stub.writeEvent('message', {
      id: 'sentinel',
      role: 'assistant',
      text: 'SENTINEL-AFTER-DROP',
      ts: Date.now(),
    });
    let sentinelSeen = false;
    for (let i = 0; i < 30 && !sentinelSeen; i++) {
      await delay(500);
      sentinelSeen = fast.buf.includes('SENTINEL-AFTER-DROP');
    }
    report('T5 other clients keep receiving after the valve trips', sentinelSeen && !fast.closed);

    const h3 = await health(backendPort);
    report('T6 backend healthy at the end', h3.status === 200 && !backendDied, backendDied);

    console.log(isFailed() ? '\nSSE FLOOD CHECKS FAILED' : '\nALL SSE FLOOD CHECKS PASSED');
    process.exitCode = isFailed() ? 1 : 0;
  } catch (e) {
    console.error(`check-sse-flood: ${e.message}`);
    console.error(
      `backend log tail: ${fs.readFileSync(BACKEND_LOG, 'utf8').split('\n').slice(-8).join('\n')}`,
    );
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
