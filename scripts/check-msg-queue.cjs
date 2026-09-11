const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { writeStubClient } = require('./lib/stub-backend.cjs');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const SUITE_STAMP = 'msg-queue-check-stack';

const PRODUCT_ROOT = path.join(__dirname, '..');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-queue-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const DB_PATH = path.join(RUN_ROOT, 'studio.db');
const PROMPT_LOG = path.join(RUN_ROOT, 'prompts.jsonl');
const SDK_STATE_DIR = path.join(RUN_ROOT, 'sdk-state');
const SDK_PROMPT_LOG = path.join(SDK_STATE_DIR, 'prompts.jsonl');
const BACKEND_LOG = '/tmp/msg-queue-backend.log';
const HOLD_MS = 2000;

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

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

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

function postJson(port, p, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(out) });
          } catch {
            resolve({ status: res.statusCode, body: null });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function makeSession(name, root = SESSIONS_ROOT) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${name}.jsonl`);
  const base = Date.now() - 60_000;
  const lines = [
    JSON.stringify({ type: 'session', id: name, timestamp: new Date(base).toISOString(), cwd: RUN_ROOT }),
    JSON.stringify({
      type: 'message',
      id: `${name}-u0`,
      parentId: null,
      timestamp: new Date(base).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'q0' }], timestamp: base },
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-a0`,
      parentId: `${name}-u0`,
      timestamp: new Date(base).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a0' }],
        timestamp: base,
        stopReason: 'stop',
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function readLines(file, map) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map(map);
  } catch {
    return [];
  }
}

const readPrompts = () => readLines(PROMPT_LOG, (p) => p);
const readSdkPrompts = () => readLines(SDK_PROMPT_LOG, (p) => p);

async function waitPrompts(agentId, atLeast, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const hits = readPrompts().filter((p) => p.agentId === agentId);
    if (hits.length >= atLeast) return hits;
    await delay(250);
  }
  return readPrompts().filter((p) => p.agentId === agentId);
}

async function waitUp(port) {
  for (let i = 0; i < 90; i++) {
    try {
      const h = await getJson(port, '/api/health');
      if (h?.ok) return h;
    } catch {}
    await delay(250);
  }
  throw new Error('backend did not become healthy');
}

function baseEnv(port) {
  return {
    ...process.env,
    PI_STUDIO_PORT: String(port),
    PI_STUDIO_HOST: '127.0.0.1',
    PI_STUDIO_SESSIONS: SESSIONS_ROOT,
    PI_STUDIO_DB_PATH: DB_PATH,
    PI_STUDIO_CWD: RUN_ROOT,
    PI_STUDIO_QUEUE_HOLD_MS: String(HOLD_MS),
    PI_STUDIO_DRAIN_MS: '1500',
  };
}

function spawnClientBackend(port, stub) {
  return spawnStackProc(spawn, SUITE_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
    detached: true,
    cwd: PRODUCT_ROOT,
    env: {
      ...baseEnv(port),
      PI_STUDIO_CLIENT_MODULE: stub.stubPath,
      STUB_CONTROL_FILE: stub.controlPath,
      STUB_PROMPT_LOG: PROMPT_LOG,
    },
    stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
  });
}

function spawnSdkBackend(port) {
  return spawnStackProc(spawn, SUITE_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
    detached: true,
    cwd: PRODUCT_ROOT,
    env: {
      ...baseEnv(port),
      PI_SDK_DIR: STUB_SDK,
      STUB_STATE_DIR: SDK_STATE_DIR,
    },
    stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
  });
}

function uiQueueRows() {
  const db = new DatabaseSync(DB_PATH);
  const rows = db.prepare('SELECT session_file, message FROM ui_queue ORDER BY id').all();
  db.close();
  return rows;
}

(async () => {
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: SUITE_STAMP, browserRef, label: 'msg-queue' });
  try {
    assertMemoryHeadroom({ label: 'msg-queue' });
    sweepStaleStackProcesses(SUITE_STAMP, { label: 'msg-queue' });
    const backendPort = await freePort();
    console.log(`stack: backend :${backendPort}`);
    const stub = writeStubClient(RUN_ROOT);
    fs.rmSync(PROMPT_LOG, { force: true });
    const F = makeSession('mq-check');
    procs.push(spawnClientBackend(backendPort, stub));
    await waitUp(backendPort);

    const setStatus = async (st) => {
      stub.emit('session_status', F, { status: st });
      stub.setStates(st === 'running' ? [{ agentId: F, status: 'running' }] : []);
    };
    const waitStatus = async (want, tries = 60) => {
      for (let i = 0; i < tries; i++) {
        const r = await getJson(backendPort, '/api/agent-states');
        const st = (r?.states ?? []).find((s) => s.agentId === F);
        if (want === 'running' && st?.status === 'running') return true;
        if (want === 'idle' && st?.status !== 'running') return true;
        await delay(100);
      }
      return false;
    };
    const itemsOf = async () =>
      (await getJson(backendPort, `/api/queue?file=${encodeURIComponent(F)}`)).items;
    const enqueue = async (message, images) =>
      (await postJson(backendPort, '/api/queue', { file: F, message, ...(images ? { images } : {}) })).body;

    await setStatus('running');
    report('stub status lands on the gateway', await waitStatus('running'));
    await enqueue('first message');
    await enqueue('second message');
    await delay(800);
    let items = await itemsOf();
    let prompts = readPrompts().filter((p) => p.agentId === F);
    report(
      'running session: queued messages wait in the gateway, nothing sent',
      items.length === 2 && items[0].text === 'first message' && prompts.length === 0,
      `items:${JSON.stringify(items.map((m) => m.text))} prompts:${prompts.length}`,
    );

    await setStatus('idle');
    prompts = await waitPrompts(F, 1);
    await delay(600);
    const promptsAfterFirstIdle = readPrompts().filter((p) => p.agentId === F);
    items = await itemsOf();
    report(
      'session going idle flushes exactly the head message, without interrupting',
      promptsAfterFirstIdle.length === 1 &&
        promptsAfterFirstIdle[0].message === 'first message' &&
        promptsAfterFirstIdle[0].interrupt === false,
      JSON.stringify(promptsAfterFirstIdle),
    );
    report(
      'flushed item is removed from the gateway queue',
      items.length === 1 && items[0].text === 'second message',
    );

    await setStatus('running');
    await setStatus('idle');
    prompts = await waitPrompts(F, 2);
    await delay(600);
    const twice = readPrompts().filter((p) => p.agentId === F && p.message === 'second message');
    report(
      'next finish flushes the second message exactly once',
      twice.length === 1 && twice[0].interrupt === false,
      `deliveries:${twice.length}`,
    );
    await setStatus('idle');
    await delay(800);
    report(
      'repeated idle transitions with an empty queue never send',
      readPrompts().filter((p) => p.agentId === F).length === 2,
    );

    await setStatus('running');
    await waitStatus('running');
    const id1 = (await enqueue('to be edited')).items.at(-1).id;
    const id2 = (await enqueue('to be removed')).items.at(-1).id;
    const patch = await postJson(
      backendPort,
      `/api/queue/${id1}?file=${encodeURIComponent(F)}`,
      {
        message: 'was edited',
      },
      'PATCH',
    );
    const del = await postJson(backendPort, `/api/queue/${id2}?file=${encodeURIComponent(F)}`, {}, 'DELETE');
    report(
      'PATCH rewrites a queued message',
      patch.status === 200 && patch.body.items[0].text === 'was edited',
    );
    report('DELETE removes a queued message', del.status === 200 && del.body.items.length === 1);
    await setStatus('idle');
    prompts = await waitPrompts(F, 3);
    await delay(600);
    const edited = readPrompts().filter((p) => p.agentId === F && p.message === 'was edited');
    const removed = readPrompts().filter((p) => p.agentId === F && p.message === 'to be removed');
    report(
      'flush delivers the edited text and never the deleted message',
      edited.length === 1 && removed.length === 0,
      `edited:${edited.length} removed:${removed.length}`,
    );

    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await setStatus('running');
    await waitStatus('running');
    await enqueue('with picture', [{ data: PNG, mimeType: 'image/png' }]);
    const badMime = await postJson(backendPort, '/api/queue', {
      file: F,
      message: 'bad',
      images: [{ data: 'AAAA', mimeType: 'text/plain' }],
    });
    const tooMany = await postJson(backendPort, '/api/queue', {
      file: F,
      message: 'many',
      images: [1, 2, 3, 4, 5].map(() => ({ data: PNG, mimeType: 'image/png' })),
    });
    const empty = await postJson(backendPort, '/api/queue', { file: F, message: '   ' });
    report('gateway rejects bad-mime attachments', badMime.status === 400, JSON.stringify(badMime.body));
    report('gateway rejects more than 4 images', tooMany.status === 400);
    report('gateway rejects a textless imageless message', empty.status === 400);
    await setStatus('idle');
    prompts = await waitPrompts(F, 4);
    const withPic = readPrompts().find((p) => p.agentId === F && p.message === 'with picture');
    report(
      'queued image message is delivered with its image, without interrupting',
      !!withPic && withPic.images === 1 && withPic.interrupt === false,
      JSON.stringify(withPic),
    );

    await setStatus('running');
    await waitStatus('running');
    const holdResp = await postJson(backendPort, '/api/queue/hold', { file: F });
    report(
      'hold endpoint reports the configured TTL',
      holdResp.body.holdMs === HOLD_MS,
      JSON.stringify(holdResp.body),
    );
    await enqueue('held while editing');
    await setStatus('idle');
    await delay(1200);
    items = await itemsOf();
    prompts = readPrompts().filter((p) => p.agentId === F && p.message === 'held while editing');
    report(
      'editing hold: session idle does not flush a queue under edit',
      items.length === 1 && prompts.length === 0,
      `items:${items.length} prompts:${prompts.length}`,
    );
    await postJson(backendPort, '/api/queue/release', { file: F });
    prompts = await waitPrompts(F, 5);
    report(
      'release flushes immediately once editing is done',
      prompts.some((p) => p.message === 'held while editing' && p.interrupt === false),
    );

    await setStatus('running');
    await waitStatus('running');
    await postJson(backendPort, '/api/queue/hold', { file: F });
    await enqueue('released during a run');
    await postJson(backendPort, '/api/queue/release', { file: F });
    await delay(1200);
    items = await itemsOf();
    const runReleased = readPrompts().filter((p) => p.agentId === F && p.message === 'released during a run');
    report(
      'releasing while the session still runs keeps the message queued',
      items.length === 1 && runReleased.length === 0,
      `items:${items.length} prompts:${runReleased.length}`,
    );
    await setStatus('idle');
    prompts = await waitPrompts(F, 6);
    report(
      'the released message flushes when the run finishes',
      readPrompts().filter((p) => p.agentId === F && p.message === 'released during a run').length === 1,
    );

    await setStatus('running');
    await waitStatus('running');
    await postJson(backendPort, '/api/queue/hold', { file: F });
    await enqueue('held then abandoned');
    await setStatus('idle');
    await delay(1000);
    let abandoned = readPrompts().filter((p) => p.agentId === F && p.message === 'held then abandoned');
    report('abandoned hold still gates the queue right after idle', abandoned.length === 0);
    for (let i = 0; i < 40 && abandoned.length === 0; i++) {
      abandoned = readPrompts().filter((p) => p.agentId === F && p.message === 'held then abandoned');
      await delay(250);
    }
    report(
      'hold TTL expiry (browser gone mid-edit) lets the flush proceed',
      abandoned.length === 1 && abandoned[0].interrupt === false,
      `deliveries:${abandoned.length}`,
    );

    const F2 = makeSession('mq-delete');
    await postJson(backendPort, '/api/queue/hold', { file: F2 });
    await postJson(backendPort, '/api/queue', { file: F2, message: 'ghost item' });
    await delay(300);
    let all = await getJson(backendPort, '/api/queue');
    report('held queue keeps the item until the session is deleted', (all.queues[F2] ?? []).length === 1);
    const slashDel = await postJson(backendPort, '/api/slash', { file: F2, command: 'delete' });
    report(
      'session delete succeeds (no viewers, idle)',
      slashDel.status === 200 && slashDel.body.ok === true,
    );
    all = await getJson(backendPort, '/api/queue');
    report(
      'deleting a session clears its gateway queue',
      !all.queues[F2] || all.queues[F2].length === 0,
      JSON.stringify(Object.keys(all.queues)),
    );

    const health = await getJson(backendPort, '/api/health');
    report(
      'health reports the gateway queue size',
      typeof health.uiQueued === 'number',
      `uiQueued:${health.uiQueued}`,
    );

    const clientBackend = procs.pop();
    clientBackend.kill('SIGKILL');
    await delay(500);

    console.log('phase 2 — real journal + registry (stub SDK): crash durability');
    fs.rmSync(SDK_PROMPT_LOG, { force: true });
    const FB = makeSession('mq-durable');
    procs.push(spawnSdkBackend(backendPort));
    await waitUp(backendPort);
    await postJson(backendPort, '/api/queue', { file: FB, message: 'durable one' });
    for (let i = 0; i < 40; i++) {
      if (readSdkPrompts().some((p) => p.file === FB && p.message === 'durable one')) break;
      await delay(250);
    }
    let sdkHits = readSdkPrompts().filter((p) => p.file === FB && p.message === 'durable one');
    report(
      'queue flushes on its own with no browser attached at all',
      sdkHits.length === 1,
      `deliveries:${sdkHits.length}`,
    );
    let runningSeen = false;
    for (let i = 0; i < 60 && !runningSeen; i++) {
      const r = await getJson(backendPort, '/api/agent-states');
      runningSeen = (r?.states ?? []).some((s) => s.agentId === FB && s.status === 'running');
      await delay(100);
    }
    report('flushed message turned into a live run', runningSeen);
    await postJson(backendPort, '/api/queue', { file: FB, message: 'durable two' });
    await delay(400);
    items = (await getJson(backendPort, `/api/queue?file=${encodeURIComponent(FB)}`)).items;
    report(
      'second message waits while the flushed one still runs',
      items.length === 1 && items[0].text === 'durable two',
      JSON.stringify(items.map((m) => m.text)),
    );

    const victim = procs[procs.length - 1];
    victim.kill('SIGKILL');
    await delay(500);
    const rowsAfterCrash = uiQueueRows().filter((r) => r.session_file === FB);
    report(
      'SIGKILL leaves the queued messages durable in the ui_queue journal',
      rowsAfterCrash.length === 2,
      JSON.stringify(rowsAfterCrash.map((r) => r.message)),
    );

    procs.push(spawnSdkBackend(backendPort));
    await waitUp(backendPort);
    for (let i = 0; i < 80; i++) {
      sdkHits = readSdkPrompts().filter((p) => p.file === FB && p.message === 'durable two');
      if (sdkHits.length >= 1) break;
      await delay(250);
    }
    report(
      'restart: the undelivered tail is restored and flushed with no client attached',
      sdkHits.length === 1,
      `deliveries:${sdkHits.length}`,
    );
    const uiAfterBoot = uiQueueRows().filter((r) => r.session_file === FB);
    report(
      'restart: the in-flight head is reconciled out of ui_queue (registry owns it)',
      uiAfterBoot.length === 1 && uiAfterBoot[0].message === 'durable two',
      JSON.stringify(uiAfterBoot.map((r) => r.message)),
    );

    fs.writeFileSync(path.join(SDK_STATE_DIR, 'release'), '1');
    for (let i = 0; i < 80; i++) {
      sdkHits = readSdkPrompts().filter((p) => p.file === FB && p.message === 'durable two');
      if (sdkHits.length >= 1) break;
      await delay(250);
    }
    report(
      'restored message is delivered exactly once after the crash',
      sdkHits.length === 1,
      `deliveries:${sdkHits.length}`,
    );
    for (let i = 0; i < 80; i++) {
      const r = await getJson(backendPort, '/api/agent-states');
      const st = (r?.states ?? []).find((s) => s.agentId === FB);
      if (st?.status !== 'running') break;
      await delay(250);
    }
    await delay(500);
    const uiAtEnd = uiQueueRows().filter((r) => r.session_file === FB);
    report('ui_queue drains completely after delivery', uiAtEnd.length === 0, JSON.stringify(uiAtEnd));
    items = (await getJson(backendPort, `/api/queue?file=${encodeURIComponent(FB)}`)).items;
    report('gateway queue is empty at the end', items.length === 0);
  } catch (e) {
    report('suite crashed', false, e.message);
  } finally {
    for (const p of procs.splice(0).reverse()) {
      try {
        p.kill('SIGKILL');
      } catch {}
    }
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }

  if (failed) {
    console.log('\nMSG-QUEUE CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL MSG-QUEUE CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
