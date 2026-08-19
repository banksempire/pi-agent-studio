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
const QUEUE_CAP_MB = Number(process.env.SSE_FLOOD_QUEUE_CAP_MB || 4);

const FLOOD_FILE = '/tmp/sse-flood/session.jsonl';
const MSG_ID = 'flood-m1';
const PHASE1_FRAMES = 1200;
const PHASE1_PAYLOAD = 300_000;
const PHASE2_IDS = 220;
const PHASE2_PAYLOAD = 200_000;
const SHARED_FRAMES = 200;

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

function sseClient(port, { files = [], label = 'sse' } = {}) {
  const c = {
    label,
    buf: '',
    closed: false,
    clientId: null,
    req: null,
    res: null,
  };
  return new Promise((resolve, reject) => {
    c.req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      c.res = res;
      res.on('data', (chunk) => (c.buf += chunk));
      res.on('end', () => (c.closed = true));
      res.on('error', () => (c.closed = true));
      res.on('close', () => (c.closed = true));
      c.files = files;
      const ready = async () => {
        for (let i = 0; i < 50; i++) {
          const m = c.buf.match(/event: ready\ndata: (\{[^\n]*\})/);
          if (m) {
            c.clientId = JSON.parse(m[1]).clientId ?? null;
            break;
          }
          await delay(200);
        }
        if (c.clientId === undefined) return reject(new Error(`${label}: never got ready`));
        c.files = files;
        if (files.length > 0) postStreamSignal(port, 'open', c.clientId, files);
        resolve(c);
      };
      ready();
    });
    c.req.on('error', reject);
  });
}

function postStreamSignal(port, action, clientId, files) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ clientId, files });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/events/${action}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode));
      },
    );
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

function killClient(c) {
  if (!c) return;
  try {
    c.req.destroy();
  } catch {}
}

async function runBackend(nestPort, opts) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${BACKEND_HEAP_MB}`, 'src/pi-studio/server/index.mjs'],
    {
      cwd: PRODUCT_ROOT,
      env: {
        ...process.env,
        PI_STUDIO_PORT: String(port),
        PI_NEST_PORT: String(nestPort),
        PI_STUDIO_SESSIONS: opts.sessionsDir,
        PI_STUDIO_CWD: opts.cwdDir,
        PI_STUDIO_SSE_MAX_QUEUED: String(QUEUE_CAP_MB * 1024 * 1024),
      },
      stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
    },
  );
  let died = '';
  child.on('exit', (code, signal) => {
    died = `exit=${code} signal=${signal}`;
  });
  await waitHealthy(port);
  return {
    port,
    child,
    died: () => died,
    stop: () => {
      if (child.exitCode === null && !child.killed) {
        try {
          process.kill(child.pid, 'SIGTERM');
        } catch {}
      }
    },
  };
}

(async () => {
  const { report, isFailed } = makeReporter();
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-flood-sessions-'));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-flood-cwd-'));
  const nestPort = await freePort();
  const stub = await startStubNest(nestPort);
  const backends = [];
  const clients = [];

  const cleanup = () => {
    for (const c of clients) killClient(c);
    for (const b of backends) b.stop();
    try {
      stub.server.tryShutdown(() => {});
    } catch {}
    for (const d of [sessionsDir, cwdDir]) fs.rmSync(d, { recursive: true, force: true });
  };

  try {
    console.log('phase 1 — fold + valve with heartbeating views');
    const b1 = await runBackend(nestPort, {
      sessionsDir,
      cwdDir,
      heartbeatTimeoutMs: 120_000,
    });
    backends.push(b1);
    const fast = await sseClient(b1.port, { files: [FLOOD_FILE], label: 'fast' });
    clients.push(fast);
    const stalled = await sseClient(b1.port, { files: [FLOOD_FILE], label: 'stalled' });
    clients.push(stalled);
    stalled.res.pause();
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

    const h1 = await health(b1.port);
    report(
      `T1 backend survives ${PHASE1_FRAMES}x300KB same-message flood with a stalled (but beating) view (heap cap ${BACKEND_HEAP_MB}MB)`,
      h1.status === 200 && !b1.died(),
      b1.died() ||
        (h1.json
          ? `heap=${Math.round(h1.json.mem.heapUsed / 1048576)}MB sseQ=${Math.round((h1.json.sseQueued ?? 0) / 1048576)}MB`
          : `status=${h1.status}`),
    );

    stalled.res.removeAllListeners('data');
    stalled.buf = '';
    stalled.res.on('data', (chunk) => (stalled.buf += chunk));
    stalled.res.resume();
    let finalSeen = false;
    for (let i = 0; i < 60 && !finalSeen; i++) {
      await delay(500);
      finalSeen = stalled.buf.includes('FINAL-STATE');
    }
    const stalledEvents = parseFrames(stalled.buf);
    const m1Frames = stalledEvents.filter((e) => e.type === 'message' && e.message?.id === MSG_ID);
    const lastM1 = m1Frames[m1Frames.length - 1];
    report(
      'T2 stalled-but-alive view still receives the final message state (fold, not drop)',
      finalSeen && !!lastM1 && lastM1.message.text.startsWith('FINAL-STATE'),
      `frames for ${MSG_ID}: ${m1Frames.length}/${PHASE1_FRAMES} sent, final=${finalSeen}`,
    );
    report(
      'T3 superseded snapshots were folded (queue stayed tiny)',
      m1Frames.length < PHASE1_FRAMES / 10,
      `${m1Frames.length} frames delivered of ${PHASE1_FRAMES}`,
    );

    stalled.res.pause();
    stalled.res.removeAllListeners('data');
    for (let i = 0; i < PHASE2_IDS; i++) {
      await stub.writeEvent('message', {
        id: `burst-${i}`,
        role: 'assistant',
        text: `burst ${i} ${'y'.repeat(PHASE2_PAYLOAD)}`,
        ts: Date.now(),
      });
    }
    for (let i = 0; i < 60 && !stalled.closed && !b1.died(); i++) {
      await delay(500);
      if (i === 4) stalled.res.resume();
    }
    const h2 = await health(b1.port);
    report(
      `T4 non-foldable burst (${PHASE2_IDS}x200KB, >${QUEUE_CAP_MB}MB) trips the loud disconnect, not the OOM`,
      stalled.closed && h2.status === 200 && !b1.died(),
      `stalledClosed=${stalled.closed} health=${h2.status} ${b1.died()}`,
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
    report('T5 other views keep receiving after the valve trips', sentinelSeen && !fast.closed);
    report('T6 backend healthy at the end of phase 1', h2.status === 200 && !b1.died(), b1.died());

    killClient(fast);
    killClient(stalled);
    b1.stop();
    await delay(1000);

    console.log('phase 2 — dead-frontend release + one queue per session');
    const b2 = await runBackend(nestPort, { sessionsDir, cwdDir });
    backends.push(b2);

    const dead = await sseClient(b2.port, { files: [FLOOD_FILE], label: 'dead' });
    clients.push(dead);
    dead.res.pause();
    dead.res.removeAllListeners('data');
    await delay(300);
    for (let i = 0; i < 60; i++) {
      await stub.writeEvent('message', {
        id: MSG_ID,
        role: 'assistant',
        text: `dead-probe ${i} ${'z'.repeat(PHASE1_PAYLOAD)}`,
        ts: Date.now(),
      });
    }
    await delay(600);
    const aliveBefore = await health(b2.port);
    const viewsBefore = aliveBefore.json ? aliveBefore.json.sseViews : -1;
    killClient(dead);
    let deadDropped = false;
    for (let i = 0; i < 40 && !deadDropped; i++) {
      await delay(500);
      deadDropped = dead.closed;
    }
    const h3 = await health(b2.port);
    const freedKB = h3.json ? Math.round((h3.json.sseQueued ?? -1) / 1024) : -1;
    report(
      'T7 dead frontend (connection gone) — its connection, views and queued data all released',
      deadDropped &&
        h3.status === 200 &&
        !b2.died() &&
        freedKB === 0 &&
        h3.json &&
        h3.json.sseClients === 0 &&
        h3.json.sseViews === 0 &&
        viewsBefore === 1,
      `viewsBefore=${viewsBefore} → sse=${h3.json ? h3.json.sseClients : '?'} views=${h3.json ? h3.json.sseViews : '?'} sseQ=${freedKB}KB ${b2.died()}`,
    );

    const viewA = await sseClient(b2.port, { files: [FLOOD_FILE], label: 'viewA' });
    clients.push(viewA);
    const viewB = await sseClient(b2.port, { files: [FLOOD_FILE], label: 'viewB' });
    clients.push(viewB);
    viewA.res.pause();
    viewB.res.pause();
    viewA.res.removeAllListeners('data');
    viewB.res.removeAllListeners('data');
    await delay(600);
    for (let i = 1; i <= SHARED_FRAMES; i++) {
      const isFinal = i === SHARED_FRAMES;
      await stub.writeEvent('message', {
        id: MSG_ID,
        role: 'assistant',
        text: isFinal
          ? `SHARED-FINAL ${'w'.repeat(PHASE1_PAYLOAD)}`
          : `shared ${i} ${'w'.repeat(PHASE1_PAYLOAD)}`,
        ts: Date.now(),
      });
    }
    await delay(1200);
    const h4 = await health(b2.port);
    const sharedKB = h4.json ? Math.round((h4.json.sseQueued ?? 0) / 1024) : -1;
    report(
      `T8 two views of one session share one queue (${SHARED_FRAMES}x300KB, both stalled → ~1 copy, not 2)`,
      h4.status === 200 && sharedKB >= 0 && sharedKB < 450 && !b2.died(),
      `sse=${h4.json ? h4.json.sseClients : '?'} views=${h4.json ? h4.json.sseViews : '?'} sseQ=${sharedKB}KB (one snapshot ≈${Math.round(PHASE1_PAYLOAD / 1024)}KB) ${b2.died()}`,
    );

    for (const v of [viewA, viewB]) {
      v.buf = '';
      v.res.on('data', (chunk) => (v.buf += chunk));
      v.res.resume();
    }
    const finals = { A: false, B: false };
    for (let i = 0; i < 60 && (!finals.A || !finals.B); i++) {
      await delay(500);
      finals.A = viewA.buf.includes('SHARED-FINAL');
      finals.B = viewB.buf.includes('SHARED-FINAL');
    }
    report(
      'T9 both views receive the final snapshot after resuming',
      finals.A && finals.B,
      `A=${finals.A} B=${finals.B}`,
    );

    const h5 = await health(b2.port);
    report('T10 backend healthy at the end of phase 2', h5.status === 200 && !b2.died(), b2.died());

    console.log('phase 3 — refcount-0 close signal');
    viewA.files = [];
    const closeA = await postStreamSignal(b2.port, 'close', viewA.clientId, [FLOOD_FILE]);
    await delay(600);
    const afterClose = await health(b2.port);
    report(
      'T11 refcount-0 close releases that session stream for the page (conn stays for globals)',
      closeA === 200 && afterClose.json && afterClose.json.sseClients === 2 && afterClose.json.sseViews === 1,
      `close=${closeA} sse=${afterClose.json ? afterClose.json.sseClients : '?'} views=${afterClose.json ? afterClose.json.sseViews : '?'}`,
    );

    await stub.writeEvent('message', {
      id: 'postclose',
      role: 'assistant',
      text: 'POST-CLOSE-MARKER',
      ts: Date.now(),
    });
    let bGotIt = false;
    for (let i = 0; i < 30 && !bGotIt; i++) {
      await delay(500);
      bGotIt = viewB.buf.includes('POST-CLOSE-MARKER');
    }
    report(
      'T12 closed view stops receiving session events; the still-open view gets them',
      bGotIt && !viewA.buf.includes('POST-CLOSE-MARKER') && !viewA.closed,
      `B received=${bGotIt} A leaked=${viewA.buf.includes('POST-CLOSE-MARKER')} A conn=${!viewA.closed}`,
    );

    viewB.files = [];
    await postStreamSignal(b2.port, 'close', viewB.clientId, [FLOOD_FILE]);
    await delay(600);
    await stub.writeEvent('message', {
      id: 'noviewer',
      role: 'assistant',
      text: 'NO-VIEWER-MARKER',
      ts: Date.now(),
    });
    await delay(800);
    const h6 = await health(b2.port);
    const qKB = h6.json ? Math.round((h6.json.sseQueued ?? -1) / 1024) : -1;
    report(
      'T13 zero views left → session queue stays empty, nothing retained',
      h6.json && h6.json.sseClients === 2 && h6.json.sseViews === 0 && qKB === 0 && !b2.died(),
      `sse=${h6.json ? h6.json.sseClients : '?'} views=${h6.json ? h6.json.sseViews : '?'} sseQ=${qKB}KB ${b2.died()}`,
    );
    report('T14 backend healthy at the end of phase 3', h6.status === 200 && !b2.died(), b2.died());

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
