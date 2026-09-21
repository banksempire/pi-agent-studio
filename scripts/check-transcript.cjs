const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeStubClient } = require('./lib/stub-backend.cjs');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

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

function waitHttp(url, label, tries = 40) {
  return (async () => {
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
  })();
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, json: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const T0 = Date.parse('2026-09-21T06:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();

function writeFixtureSession() {
  const dir = path.join(SESSIONS_ROOT, '--tmp-transcript--');
  fs.mkdirSync(dir, { recursive: true });
  const id = '01a0test-0000-75c6-af26-f6ec5ae4544a';
  const entry = (n, extra) =>
    JSON.stringify({ id: `e${n}`, parentId: n > 1 ? `e${n - 1}` : null, timestamp: ts(n), ...extra });
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: ts(0), cwd: RUN_ROOT }),
    entry(1, {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'before compaction' }], timestamp: T0 + 1000 },
    }),
    entry(2, {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier answer' }],
        timestamp: T0 + 2000,
        stopReason: 'stop',
      },
    }),
    JSON.stringify({
      type: 'compaction',
      id: 'e3',
      parentId: 'e2',
      timestamp: ts(3),
      summary: '## Goal\ncompacted',
      firstKeptEntryId: 'e2',
      tokensBefore: 1000,
    }),
    entry(4, {
      type: 'message',
      message: {
        role: 'system',
        content: '',
        sections: { preamble: 'You are an expert coding assistant.', tools: '<tools>\n- read\n</tools>' },
        timestamp: T0 + 4000,
      },
    }),
    entry(5, {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'after compaction' }], timestamp: T0 + 5000 },
    }),
    entry(6, {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'later answer' }],
        timestamp: T0 + 6000,
        stopReason: 'stop',
      },
    }),
    entry(7, {
      type: 'message',
      message: { role: 'system', content: 'visible operator notice', timestamp: T0 + 7000 },
    }),
  ];
  const file = path.join(dir, 'post-compaction.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function unitAssertions(report) {
  const { toDisplayMessage } = await import(
    pathToFileURL(path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'sdk-bridge.mjs'))
  );
  const empty = toDisplayMessage({
    role: 'system',
    content: '',
    sections: { preamble: 'You are an expert coding assistant.', tools: '<tools></tools>' },
    timestamp: T0,
  });
  report(
    'unit: sections-only system prompt entry maps to no display row',
    empty === null,
    JSON.stringify(empty),
  );
  const texted = toDisplayMessage({ role: 'system', content: 'operator notice', timestamp: T0 });
  report(
    'unit: text-bearing system message survives with its text',
    !!texted && texted.role === 'system' && texted.text === 'operator notice',
    JSON.stringify(texted),
  );
  const user = toDisplayMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: T0 });
  report('unit: user messages unaffected', !!user && user.text === 'hi', JSON.stringify(user));
}

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-transcript' });
  sweepStaleStackProcesses('check-transcript:stack');
  const procs = [];
  installStackCleanup({
    procs,
    stamp: 'check-transcript:stack',
    browserRef: { current: null },
    label: 'check-transcript',
  });
  try {
    await unitAssertions(report);

    const backendPort = await freePort();
    console.log(`stack: backend :${backendPort}`);
    const stub = writeStubClient(RUN_ROOT);
    const fixture = writeFixtureSession();

    procs.push(
      spawnStackProc(spawn, 'check-transcript:stack', 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/check-transcript-backend.log', 'a'),
          fs.openSync('/tmp/check-transcript-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');

    const { status, json } = await getJson(
      `http://127.0.0.1:${backendPort}/api/sessions/messages?file=${encodeURIComponent(fixture)}`,
    );
    report('api: /api/sessions/messages returns 200', status === 200, `status=${status}`);
    const msgs = json.messages ?? [];
    const emptySystem = msgs.filter((m) => m.role === 'system' && !m.text);
    report(
      'regression: no empty system row in the transcript payload (post-compaction system prompt never ships)',
      emptySystem.length === 0,
      JSON.stringify(emptySystem),
    );
    const systemRows = msgs.filter((m) => m.role === 'system');
    report(
      'narrowness: exactly the text-bearing system notice remains',
      systemRows.length === 1 && systemRows[0].text === 'visible operator notice',
      JSON.stringify(systemRows),
    );
    const roles = msgs.map((m) => m.role);
    report(
      'shape: user/assistant/summary rows intact',
      JSON.stringify(roles) ===
        JSON.stringify(['user', 'assistant', 'summary', 'user', 'assistant', 'system']),
      JSON.stringify(roles),
    );
    const summaryRow = msgs.find((m) => m.role === 'summary');
    report(
      'shape: compaction still maps to the summary row',
      !!summaryRow && summaryRow.text.startsWith('## Goal'),
      JSON.stringify(summaryRow),
    );
  } catch (e) {
    report('suite completed', false, e instanceof Error ? e.message : String(e));
  }
  await delay(500);
  for (const p of procs) {
    try {
      if (p.exitCode === null) p.kill('SIGKILL');
    } catch {}
  }
  process.exit(isFailed() ? 1 : 0);
})();
