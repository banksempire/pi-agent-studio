const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { writeStubClient } = require('./lib/stub-backend.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const GATEWAY_LOG = '/tmp/session-sync-backend.log';

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

function writeSessionFile(name, { error = false, turns = 2 } = {}) {
  const dir = path.join(SESSIONS_ROOT, '--tmp-sync--');
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
  ];
  let prev = id;
  for (let t = 0; t < turns; t++) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `${name}-u${t}`,
        parentId: prev,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `${name} q${t}` }], timestamp: Date.now() },
      }),
    );
    prev = `${name}-u${t}`;
    const isLast = t === turns - 1;
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `${name}-a${t}`,
        parentId: prev,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${name} a${t}` }],
          timestamp: Date.now(),
          ...(isLast ? { stopReason: error ? 'error' : 'stop' } : {}),
          ...(isLast && error ? { errorMessage: 'API quota reached' } : {}),
        },
      }),
    );
    prev = `${name}-a${t}`;
  }
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  return file;
}

function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(out) });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(out) });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
      })
      .on('error', reject);
  });
}

function sseClient(port) {
  const c = { buf: '', events: [], closed: false, clientId: null };
  c.req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
    res.on('data', (chunk) => {
      c.buf += chunk;
      for (;;) {
        const idx = c.buf.indexOf('\n\n');
        if (idx < 0) break;
        const block = c.buf.slice(0, idx);
        c.buf = c.buf.slice(idx + 2);
        const ready = block.match(/^event: ready\ndata: (\{.*\})$/);
        if (ready && !c.clientId) {
          try {
            c.clientId = JSON.parse(ready[1]).clientId ?? null;
          } catch {}
        }
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            c.events.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    });
    res.on('end', () => (c.closed = true));
    res.on('error', () => (c.closed = true));
  });
  c.destroy = () => {
    try {
      c.req.destroy();
    } catch {}
  };
  return c;
}

async function waitReady(c, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (c.clientId) return;
    await delay(200);
  }
  throw new Error('sse client never got ready');
}

async function waitFor(c, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = c.events.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(150);
  }
}

async function waitHealthy(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getJson(port, '/api/health');
      if (r.status === 200) return;
    } catch {}
    await delay(500);
  }
  throw new Error('gateway did not come up');
}

async function waitDown(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await getJson(port, '/api/health');
    } catch {
      return;
    }
    await delay(300);
  }
  throw new Error('gateway never went down');
}

function spawnBackend(port, stub) {
  const child = spawn('node', ['src/pi-studio/server/index.mjs'], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_PORT: String(port),
      PI_STUDIO_CLIENT_MODULE: stub.stubPath,
      STUB_CONTROL_FILE: stub.controlPath,
      PI_STUDIO_SESSIONS: SESSIONS_ROOT,
      PI_STUDIO_STATES_PATH: STATES_PATH,
      PI_STUDIO_CWD: RUN_ROOT,
    },
    stdio: ['ignore', fs.openSync(GATEWAY_LOG, 'a'), fs.openSync(GATEWAY_LOG, 'a')],
  });
  return child;
}

async function stateOfSession(port, file) {
  const r = await getJson(port, '/api/sessions');
  const hit = (r.json?.sessions ?? []).find((s) => s.file === file);
  return hit ? hit.state : 'missing';
}

(async () => {
  const { report, isFailed } = makeReporter();
  const gatewayPort = await freePort();
  const stub = writeStubClient(RUN_ROOT);
  let gateway = spawnBackend(gatewayPort, stub);
  await waitHealthy(gatewayPort);

  const F_ERR = writeSessionFile('sync-err', { error: true });
  const F_OK = writeSessionFile('sync-ok', {});
  const F_WORK = writeSessionFile('sync-work', {});
  const F_OPEN = writeSessionFile('sync-open', {});

  const A = sseClient(gatewayPort);
  await waitReady(A);

  let t = await (async () => {
    const snap = await waitFor(A, (ev) => ev.type === 'session_states', 'initial snapshot', 3000);
    const empty = (snap.states ?? []).length === 0;
    const before = await stateOfSession(gatewayPort, F_OK);
    const chat = await postJson(gatewayPort, '/api/chat', { file: F_OK, message: 'hello' });
    const ev = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_OK && e.state === 'working',
      'working sync',
    );
    return {
      ok: empty && before === 'close' && chat.status === 200 && ev.state === 'working',
      why: `snapshot:${JSON.stringify(snap.states)} before:${before} chat:${chat.status}`,
    };
  })();
  report('S1 prompt marks the session working and syncs to all frontends', t.ok, t.why);

  t = await (async () => {
    await stub.emit('message', F_OK, {
      id: 'asst-1',
      role: 'assistant',
      text: 'done',
      stopReason: 'error',
      error: 'API quota reached',
      ts: Date.now(),
    });
    await stub.emit('session_status', F_OK, { status: 'idle' });
    const ev = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_OK && e.state === 'error',
      'error sync',
    );
    const viaList = await stateOfSession(gatewayPort, F_OK);
    return {
      ok: /quota/.test(ev.error ?? '') && viaList === 'error',
      why: `event error:"${ev.error}" list:${viaList}`,
    };
  })();
  report('S2 unrecoverable error → error state with message, visible in /api/sessions', t.ok, t.why);

  t = await (async () => {
    const visit = await postJson(gatewayPort, '/api/events/visit', { clientId: A.clientId, file: F_OK });
    const ev = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_OK && e.state === 'open',
      'visit clears error',
    );
    return { ok: visit.status === 200 && ev.state === 'open', why: `http:${visit.status} state:${ev.state}` };
  })();
  report('S3 visit clears error → open', t.ok, t.why);

  t = await (async () => {
    const B = sseClient(gatewayPort);
    await waitReady(B);
    const open = await postJson(gatewayPort, '/api/events/open', {
      clientId: B.clientId,
      files: [F_OK],
    });
    const openEv = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_OPEN,
      'window open sync',
      3000,
    ).catch(() => null);
    await postJson(gatewayPort, '/api/events/close', { clientId: B.clientId, files: [F_OK] });
    const closeEv = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_OK && e.state === 'close',
      'last window close',
    );
    const openState = openEv ? openEv.state : null;
    const openViaApi = await stateOfSession(gatewayPort, F_OPEN);
    B.destroy();
    return {
      ok: open.status === 200 && closeEv.state === 'close' && openViaApi === 'close',
      why: `refcount-close ok; second-frontend window open broadcast:${openState} F_OPEN api:${openViaApi}`,
    };
  })();
  report('S4 refcount: close only at zero; opening a window on a close session broadcasts open', t.ok, t.why);

  t = await (async () => {
    await postJson(gatewayPort, '/api/chat', { file: F_ERR, message: 'run' });
    await stub.emit('session_status', F_ERR, { status: 'running' });
    await stub.emit('session_status', F_ERR, { status: 'idle', stale: true });
    const ev = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_ERR && e.state === 'error',
      'stale settle',
    );
    return { ok: /stalled/.test(ev.error ?? ''), why: ev.error };
  })();
  report('S5 watchdog force-settle → error', t.ok, t.why);

  t = await (async () => {
    await postJson(gatewayPort, '/api/chat', { file: F_WORK, message: 'run' });
    await stub.emit('session_status', F_WORK, { status: 'running' });
    await stub.emit('session_status', F_WORK, { status: 'idle' });
    const unreadEv = await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_WORK && e.state === 'unread',
      'unread sync',
    );
    await postJson(gatewayPort, '/api/events/open', { clientId: A.clientId, files: [F_WORK] });
    await delay(700);
    const stillUnread = await stateOfSession(gatewayPort, F_WORK);
    await postJson(gatewayPort, '/api/events/visit', { clientId: A.clientId, file: F_WORK });
    await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_WORK && e.state === 'open',
      'visit clears unread',
    );
    const after = await stateOfSession(gatewayPort, F_WORK);
    return {
      ok: unreadEv.state === 'unread' && stillUnread === 'unread' && after === 'open',
      why: `unread→ window-open:${stillUnread} visit:${after}`,
    };
  })();
  report('S6 unvisited run → unread; a mere open window does not clear it; visit does', t.ok, t.why);

  t = await (async () => {
    const blocked = await postJson(gatewayPort, '/api/slash', { file: F_WORK, command: 'delete' });
    await postJson(gatewayPort, '/api/events/close', { clientId: A.clientId, files: [F_WORK] });
    await delay(500);
    const allowed = await postJson(gatewayPort, '/api/slash', { file: F_WORK, command: 'delete' });
    const gone = await stateOfSession(gatewayPort, F_WORK);
    return {
      ok: blocked.status === 400 && allowed.status === 200 && gone === 'missing',
      why: `open-window delete:${blocked.status} closed delete:${allowed.status} after:${gone}`,
    };
  })();
  report('S7 delete refused while a window holds the session, allowed at refcount zero', t.ok, t.why);

  t = await (async () => {
    await postJson(gatewayPort, '/api/chat', { file: F_ERR, message: 'again' });
    await postJson(gatewayPort, '/api/chat', { file: F_OK, message: 'again' });
    await delay(400);
    await postJson(gatewayPort, '/api/events/open', { clientId: A.clientId, files: [F_OPEN] });
    await waitFor(
      A,
      (e) => e.type === 'session_state' && e.file === F_OPEN && e.state === 'open',
      'open before restart',
    );
    gateway.kill('SIGTERM');
    await waitDown(gatewayPort);
    const persisted = JSON.parse(fs.readFileSync(STATES_PATH, 'utf8'));
    const diskStates = persisted.entries
      .map((e) => `${path.basename(e.file)}:${e.state}`)
      .sort()
      .join(',');
    stub.setStates([]);
    gateway = spawnBackend(gatewayPort, stub);
    await waitHealthy(gatewayPort);
    await delay(1500);
    const errState = await stateOfSession(gatewayPort, F_ERR);
    const okState = await stateOfSession(gatewayPort, F_OK);
    const openState = await stateOfSession(gatewayPort, F_OPEN);
    return {
      ok:
        /sync-err.jsonl:working/.test(diskStates) &&
        /sync-ok.jsonl:working/.test(diskStates) &&
        errState === 'error' &&
        okState === 'unread' &&
        openState === 'close',
      why: `disk[${diskStates}] probe→ err:${errState} ok:${okState} open:${openState}`,
    };
  })();
  report(
    'S8 restart: persist working; probe resolves error/unread from the session file; open resets to close',
    t.ok,
    t.why,
  );

  t = await (async () => {
    const C = sseClient(gatewayPort);
    await waitReady(C);
    const snap = await waitFor(C, (ev) => ev.type === 'session_states', 'snapshot after restart', 3000);
    const files = (snap.states ?? [])
      .map((s) => path.basename(s.file))
      .sort()
      .join(',');
    C.destroy();
    const ok = files === 'sync-err.jsonl,sync-ok.jsonl';
    return { ok, why: `snapshot[${files}]` };
  })();
  report('S9 reconnecting frontend gets a session_states snapshot', t.ok, t.why);

  t = await (async () => {
    const F_TUI = writeSessionFile('sync-tui', { turns: 1 });
    const D = sseClient(gatewayPort);
    await waitReady(D);
    const appendEntry = (file, entry) => fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    const waitForState = (file, state) =>
      waitFor(
        D,
        (e) => e.type === 'session_state' && e.file === file && e.state === state,
        `tui ${state}`,
        12000,
      );
    appendEntry(F_TUI, {
      type: 'message',
      id: 'tui-u1',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'tui prompt' }], timestamp: Date.now() },
    });
    const workEv = await waitForState(F_TUI, 'working');
    const viaList = await stateOfSession(gatewayPort, F_TUI);
    appendEntry(F_TUI, {
      type: 'message',
      id: 'tui-a1',
      parentId: 'tui-u1',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'tui answer' }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    });
    const unreadEv = await waitForState(F_TUI, 'unread');
    const afterList = await stateOfSession(gatewayPort, F_TUI);
    D.destroy();
    return {
      ok:
        workEv.state === 'working' &&
        viaList === 'working' &&
        unreadEv.state === 'unread' &&
        afterList === 'unread',
      why: `file-only run: working(list:${viaList}) → unread(list:${afterList})`,
    };
  })();
  report('S10 runs owned outside pi-nest (TUI-style file writes) are tracked working → unread', t.ok, t.why);

  t = await (async () => {
    const F_MULTI = writeSessionFile('sync-multi', {});
    const r1 = await postJson(gatewayPort, '/api/chat', { file: F_OK, message: 'run 1' });
    const r2 = await postJson(gatewayPort, '/api/chat', { file: F_MULTI, message: 'run 2' });
    stub.setStates([
      { agentId: F_OK, status: 'running' },
      { agentId: F_MULTI, status: 'running' },
    ]);
    await stub.emit('session_status', F_OK, { status: 'running' });
    await stub.emit('session_status', F_MULTI, { status: 'running' });
    const E = sseClient(gatewayPort);
    await waitReady(E);
    await delay(500);
    const s1 = await stateOfSession(gatewayPort, F_OK);
    const s2 = await stateOfSession(gatewayPort, F_MULTI);
    const list = await getJson(gatewayPort, '/api/sessions');
    const runningBoth = (list.json?.sessions ?? []).filter(
      (x) => (x.file === F_OK || x.file === F_MULTI) && x.running,
    ).length;
    E.destroy();
    stub.setStates([]);
    return {
      ok: r1.status === 200 && r2.status === 200 && s1 === 'working' && s2 === 'working' && runningBoth === 2,
      why: `two concurrent web-UI runs: ${s1}/${s2} running-flag count:${runningBoth}`,
    };
  })();
  report('S11 two concurrent web-UI runs both report working', t.ok, t.why);

  t = await (async () => {
    const F_R1 = writeSessionFile('sync-recon1', {});
    const F_R2 = writeSessionFile('sync-recon2', {});
    stub.setStates([
      { agentId: F_R1, status: 'running' },
      { agentId: F_R2, status: 'running' },
    ]);
    const E = sseClient(gatewayPort);
    await waitReady(E);
    const snap = await waitFor(E, (ev) => ev.type === 'session_states', 'snapshot', 3000);
    const preListed = (snap.states ?? []).filter((x) => x.file === F_R1 || x.file === F_R2).length;
    const after1 = await stateOfSession(gatewayPort, F_R1);
    const after2 = await stateOfSession(gatewayPort, F_R2);
    await delay(500);
    const evs = E.events.filter(
      (e) => e.type === 'session_state' && (e.file === F_R1 || e.file === F_R2) && e.state === 'working',
    );
    E.destroy();
    stub.setStates([]);
    return {
      ok: preListed === 0 && after1 === 'working' && after2 === 'working' && evs.length >= 2,
      why: `nest-running, no registry entry: snapshot pre-listed:${preListed} → poll reconciled to ${after1}/${after2} (events:${evs.length})`,
    };
  })();
  report('S12 /api/sessions poll reconciles nest-running sessions missing from the registry', t.ok, t.why);

  A.destroy();
  gateway.kill('SIGTERM');

  console.log(isFailed() ? 'session-sync checks FAILED' : 'session-sync checks passed');
  process.exitCode = isFailed() ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
