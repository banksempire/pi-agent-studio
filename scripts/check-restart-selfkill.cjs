const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const SF_ROOT = path.join(path.dirname(PRODUCT_ROOT), 'StudioFramework');
const BIN = path.join(PRODUCT_ROOT, 'bin', 'studio.mjs');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const RUN_ID = `restart-selfkill-${process.pid}-${Date.now()}`;
const TMPROOT = path.join(os.tmpdir(), 'studio-restart-selfkill');
const BASE = path.join(TMPROOT, RUN_ID);
const CFG = path.join(BASE, 'config');
const STATE = path.join(BASE, 'state');
const WT = path.join(BASE, '.branch');
const PAIR = path.join(WT, 'selfkill');
const ID = 'selfkill';
const STUB_STATE_DIR = path.join(BASE, 'stub-state');
const DRAIN_MS = 6000;
const RESERVED = [7492, 7493, 7494];

for (const key of Object.keys(process.env)) {
  if (key.startsWith('PI_STUDIO_') || key === 'PI_API_PROXY') delete process.env[key];
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res;
}

function studioSync(args, env) {
  return sh('node', [BIN, ...args], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_CONFIG_DIR: CFG,
      PI_STUDIO_STATE_DIR: STATE,
      PI_STUDIO_WORKTREES: WT,
      ...env,
    },
  });
}

function studioAsync(args, env) {
  return spawn('node', [BIN, ...args], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_CONFIG_DIR: CFG,
      PI_STUDIO_STATE_DIR: STATE,
      PI_STUDIO_WORKTREES: WT,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function bindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function freePortAbove(min) {
  for (let p = min; p < min + 400; p++) {
    if (RESERVED.includes(p)) continue;
    if (await bindable(p)) return p;
  }
  throw new Error('no free port for check');
}

function getJson(port, p, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function bgPost(port, p, body) {
  const req = http.request(
    { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  req.end(JSON.stringify(body));
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await getJson(port, '/api/health');
      if (h?.ok && !h.draining) return h;
    } catch {}
    await delay(250);
  }
  return null;
}

async function waitRunning(port, file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await getJson(port, '/api/agent-states');
      const st = (r?.states ?? []).find((s) => s.agentId === file);
      if (st && st.status === 'running') return true;
    } catch {}
    await delay(200);
  }
  return false;
}

function pidfile(service) {
  const file = path.join(PAIR, '.studio', 'state', 'pids', `${service}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function writeSessionFile(name) {
  const dir = path.join(PAIR, '.studio', 'sessions', '--selfkill--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'session',
      id: name,
      parentId: null,
      timestamp: new Date(1780000000000).toISOString(),
      cwd: BASE,
    }),
    JSON.stringify({
      type: 'message',
      id: 'seed-u1',
      parentId: name,
      timestamp: new Date(1780000060000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'seed question' }], timestamp: 1780000060000 },
    }),
    JSON.stringify({
      type: 'message',
      id: 'seed-a1',
      parentId: 'seed-u1',
      timestamp: new Date(1780000061000).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'seed answer' }],
        timestamp: 1780000061000,
        stopReason: 'stop',
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function main() {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'restart-selfkill' });
  sweepStaleStackProcesses('studio-restart-selfkill', { label: 'restart-selfkill' });

  const procs = [];
  const cleanupRef = installStackCleanup({
    procs,
    stamp: 'studio-restart-selfkill',
    label: 'restart-selfkill',
  });
  const backendPort = await freePortAbove(8000);

  try {
    fs.mkdirSync(WT, { recursive: true });
    sh('git', ['worktree', 'add', '--detach', path.join(PAIR, 'pi-agent-studio'), 'HEAD'], {
      cwd: PRODUCT_ROOT,
    });
    sh('git', ['worktree', 'add', '--detach', path.join(PAIR, 'StudioFramework'), 'HEAD'], {
      cwd: SF_ROOT,
    });
    sh('cp', ['-r', `${path.join(PRODUCT_ROOT, 'src')}/.`, path.join(PAIR, 'pi-agent-studio', 'src')]);
    sh('cp', ['-r', `${path.join(PRODUCT_ROOT, 'bin')}/.`, path.join(PAIR, 'pi-agent-studio', 'bin')]);

    const webPort = await freePortAbove(8400);
    studioSync(['init', '--pair-root', PAIR, '--id', ID, '--port', `web=${webPort}`, '--no-install']);
    const env = {
      PI_STUDIO_PORT: String(backendPort),
      PI_STUDIO_DRAIN_MS: String(DRAIN_MS),
      PI_SDK_DIR: STUB_SDK,
      STUB_STATE_DIR,
    };
    fs.rmSync(path.join(STUB_STATE_DIR, 'release'), { force: true });
    studioSync(['-i', ID, 'up', 'backend'], env);
    const upHealth = await waitHealthy(backendPort, 20000);
    report('stack boots (stub sdk backend)', !!upHealth, '');

    const chatFile = writeSessionFile('selfkill-chat');
    bgPost(backendPort, '/api/chat', { file: chatFile, message: 'hang this generation please' });
    const running = await waitRunning(backendPort, chatFile, 10000);
    report('in-flight prompt hangs (drain will wait)', running, '');

    const oldPid = pidfile('backend')?.pid;
    const cli = studioAsync(['-i', ID, 'restart', 'backend', '--yes'], env);
    procs.push(cli);
    await delay(900);
    const cliAlive = cli.exitCode === null;
    process.kill(cli.pid, 'SIGKILL');
    report('restart CLI was mid-drain when killed', cliAlive, '');

    const back = await waitHealthy(backendPort, DRAIN_MS + 60000);
    const newPid = pidfile('backend')?.pid;
    report(
      'backend comes back after the restart CLI dies mid-drain (finisher)',
      !!back && !!newPid && newPid !== oldPid,
      `old=${oldPid} new=${newPid}`,
    );

    fs.writeFileSync(path.join(STUB_STATE_DIR, 'release'), '1');
    await delay(1500);
    const happy = studioSync(['-i', ID, 'restart', 'backend', '--yes'], env);
    const happyHealth = await waitHealthy(backendPort, 20000);
    const happyPid = pidfile('backend')?.pid;
    await delay(3000);
    const stableAfter = pidfile('backend')?.pid;
    report(
      'normal restart still works and stays up (no finisher double-flip)',
      happy.status === 0 && !!happyHealth && !!stableAfter && stableAfter === happyPid,
      `exit=${happy.status} pid ${happyPid}→${stableAfter}`,
    );

    studioSync(['-i', ID, 'down'], env);
  } finally {
    try {
      studioSync(['-i', ID, 'kill', 'backend'], {});
    } catch {}
    try {
      sh('git', ['worktree', 'remove', '--force', path.join(PAIR, 'pi-agent-studio')], {
        cwd: PRODUCT_ROOT,
        allowFail: true,
      });
      sh('git', ['worktree', 'remove', '--force', path.join(PAIR, 'StudioFramework')], {
        cwd: SF_ROOT,
        allowFail: true,
      });
    } catch {}
    fs.rmSync(TMPROOT, { recursive: true, force: true });
    cleanupRef();
  }

  if (isFailed()) {
    console.log('\nRESTART-SELFKILL CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL RESTART-SELFKILL CHECKS PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
