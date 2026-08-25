const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const PRODUCT_ROOT = path.join(__dirname, '..');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-restart-'));
const SESSIONS_ROOT = path.join(TMP, 'sessions');
const DB_PATH = path.join(TMP, 'studio.db');
const SPILL_PATH = path.join(TMP, 'backend-spill.json');
const STATES_PATH = path.join(TMP, 'studio-session-states.json');
const STUB_STATE_DIR = path.join(TMP, 'stub-state');
const BACKEND_LOG = path.join(TMP, 'backend.log');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

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

function makeSession(name, extraEntries = []) {
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
  const file = path.join(SESSIONS_ROOT, `${name}.jsonl`);
  const base = Date.now() - 60_000;
  const lines = [
    JSON.stringify({ type: 'session', id: name, timestamp: new Date(base).toISOString(), cwd: TMP }),
    ...extraEntries,
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function userEntry(id, text, ts) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts },
  });
}

function assistantEntry(id, text, ts, stopReason) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: ts, stopReason },
  });
}

function spawnBackend(port) {
  const child = spawn('node', ['src/pi-studio/server/index.mjs'], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_PORT: String(port),
      PI_STUDIO_HOST: '127.0.0.1',
      PI_STUDIO_SESSIONS: SESSIONS_ROOT,
      PI_STUDIO_CWD: TMP,
      PI_STUDIO_DB_PATH: DB_PATH,
      PI_STUDIO_SPILL_PATH: SPILL_PATH,
      PI_STUDIO_STATES_PATH: STATES_PATH,
      PI_STUDIO_DRAIN_MS: '1500',
      PI_SDK_DIR: STUB_SDK,
      STUB_STATE_DIR,
    },
    stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
  });
  return child;
}

async function waitUp(port) {
  for (let i = 0; i < 90; i++) {
    try {
      const h = await getJson(port, '/api/health');
      if (h?.ok && h.journal?.recovery) return h;
    } catch {}
    await delay(250);
  }
  throw new Error('backend did not become healthy');
}

async function waitIdle(port, file) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await getJson(port, '/api/agent-states');
      const st = (r?.states ?? []).find((s) => s.agentId === file);
      if (st && st.status === 'idle') return true;
    } catch {}
    await delay(250);
  }
  return false;
}

function readPrompts() {
  const log = path.join(STUB_STATE_DIR, 'prompts.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function settleAll() {
  fs.writeFileSync(path.join(STUB_STATE_DIR, 'release'), '1');
}

async function settleAndWait(port, file) {
  settleAll();
  const ok = await waitIdle(port, file);
  fs.rmSync(path.join(STUB_STATE_DIR, 'release'), { force: true });
  return ok;
}

function journalRows() {
  const db = new DatabaseSync(DB_PATH);
  const rows = db
    .prepare("SELECT session_file, message, status FROM queue_items WHERE status IN ('queued','inflight')")
    .all();
  db.close();
  return rows;
}

function seedInflight(file, message, startedAt) {
  const db = new DatabaseSync(DB_PATH);
  db.prepare(
    "INSERT INTO queue_items (session_file, message, images, status, started_at) VALUES (?, ?, '[]', 'inflight', ?)",
  ).run(file, message, startedAt);
  db.close();
}

function exitCode(child, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve(signal ?? code);
    });
  });
}

async function main() {
  fs.mkdirSync(STUB_STATE_DIR, { recursive: true });
  const port = await freePort();
  const S1 = makeSession('graceful-chat');
  const S2 = makeSession('kill9-chat');
  const S3 = makeSession('advanced-chat');

  let backend = spawnBackend(port);
  await waitUp(port);

  const bgPost = (file, message) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
      },
    );
    req.on('error', () => {});
    req.end(JSON.stringify({ file, message }));
  };

  bgPost(S1, 'write a very long essay');
  await delay(1500);
  let h = await getJson(port, '/api/health');
  report('S1 prompt in flight is journaled', h.journal.pending === 1, `pending=${h.journal.pending}`);

  backend.kill('SIGTERM');
  const s1exit = await exitCode(backend);
  const s1rows = journalRows();
  report(
    'S1 graceful drain exits 0 and keeps the interrupted row durable',
    s1exit === 0 && s1rows.length === 1 && s1rows[0].status === 'inflight',
    `exit=${s1exit} rows=${JSON.stringify(s1rows)}`,
  );

  fs.appendFileSync(S1, `${assistantEntry('a-aborted', 'partial essay text', Date.now(), 'aborted')}\n`);
  backend = spawnBackend(port);
  h = await waitUp(port);
  const s1prompts = readPrompts().filter((p) => p.file === S1);
  report(
    'S1 recovery resumes once and nudges to continue the on-disk partial',
    h.journal.recovery.resumed === 1 &&
      s1prompts.length === 2 &&
      s1prompts[1].message.includes('cut off mid-generation') &&
      s1prompts[1].message.includes('Continue exactly where it stopped'),
    `recovery=${JSON.stringify(h.journal.recovery)} prompts=${s1prompts.length}`,
  );
  await settleAndWait(port, S1);
  report('S1 resumed prompt settles and clears the journal', journalRows().length === 0);

  bgPost(S2, 'raft history please');
  await delay(1500);
  backend.kill('SIGKILL');
  await exitCode(backend);
  const s2rows = journalRows();
  report(
    'S2 SIGKILL leaves the interrupted row in WAL',
    s2rows.length === 1 && s2rows[0].status === 'inflight',
  );

  backend = spawnBackend(port);
  h = await waitUp(port);
  const s2prompts = readPrompts().filter((p) => p.file === S2);
  report(
    'S2 recovery after SIGKILL resumes with the no-reply nudge',
    h.journal.recovery.resumed === 1 &&
      s2prompts.length === 2 &&
      s2prompts[1].message.includes('restarted before you produced any reply'),
    `recovery=${JSON.stringify(h.journal.recovery)}`,
  );
  await settleAndWait(port, S2);
  report('S2 resumed prompt settles and clears the journal', journalRows().length === 0);

  backend.kill('SIGTERM');
  await exitCode(backend);
  const now = Date.now();
  fs.appendFileSync(S3, `${userEntry('u-old', 'original task', now - 5000)}\n`);
  fs.appendFileSync(S3, `${userEntry('u-new', 'typed in the TUI while gateway down', now + 60_000)}\n`);
  seedInflight(S3, 'stale interrupted prompt', now - 4000);
  backend = spawnBackend(port);
  h = await waitUp(port);
  const s3prompts = readPrompts().filter((p) => p.file === S3);
  report(
    'S3 session advanced while down: row skipped, no prompt re-sent',
    h.journal.recovery.skipped === 1 && s3prompts.length === 0 && journalRows().length === 0,
    `recovery=${JSON.stringify(h.journal.recovery)}`,
  );

  backend.kill('SIGTERM');
  await exitCode(backend);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? 'backend restart journal check: FAIL' : 'backend restart journal check: OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
