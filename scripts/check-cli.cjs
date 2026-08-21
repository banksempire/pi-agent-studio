const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PRODUCT_ROOT = path.join(__dirname, '..');
const SF_ROOT = path.join(path.dirname(PRODUCT_ROOT), 'StudioFramework');
const BIN = path.join(PRODUCT_ROOT, 'bin', 'studio.mjs');
const RUN_ID = `studio-cli-check-${process.pid}-${Date.now()}`;
const BASE = path.join(path.dirname(PRODUCT_ROOT), '.studio-check', RUN_ID);
const CFG = path.join(BASE, 'config');
const STATE = path.join(BASE, 'state');
const WT = path.join(BASE, 'wt');
const PAIR = path.join(WT, 'check');
const ID = 'check';
const RESERVED = [7492, 7493, 7494, 7495];

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
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

function studio(args, { env = {}, expect = null, label = '' } = {}) {
  const res = spawnSync('node', [BIN, ...args], {
    cwd: PRODUCT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PI_STUDIO_CONFIG_DIR: CFG,
      PI_STUDIO_STATE_DIR: STATE,
      PI_STUDIO_WORKTREES: WT,
      ...env,
    },
  });
  if (expect != null && res.status !== expect) {
    console.log(`--- studio ${args.join(' ')} ${label} ---`);
    console.log(res.stdout);
    console.error(res.stderr);
  }
  return res;
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res;
}

function pidfile(service) {
  const file = path.join(STATE, 'instances', ID, 'pids', `${service}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
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

async function main() {
  const { report, isFailed } = makeReporter();
  const nestPort = await freePortAbove(7600);
  const gwPort = await freePortAbove(7700);
  const webPort = await freePortAbove(7800);
  const env = { PI_NEST_PORT: String(nestPort), PI_STUDIO_PORT: String(gwPort) };

  fs.mkdirSync(WT, { recursive: true });
  sh('git', ['worktree', 'add', '--detach', path.join(PAIR, 'pi-agent-studio'), 'HEAD'], {
    cwd: PRODUCT_ROOT,
  });
  sh('git', ['worktree', 'add', '--detach', path.join(PAIR, 'StudioFramework'), 'HEAD'], {
    cwd: SF_ROOT,
  });
  sh('cp', ['-r', `${path.join(PRODUCT_ROOT, 'src')}/.`, path.join(PAIR, 'pi-agent-studio', 'src')]);
  sh('cp', [
    '-al',
    path.join(PRODUCT_ROOT, 'node_modules'),
    path.join(PAIR, 'pi-agent-studio', 'node_modules'),
  ]);
  sh('cp', ['-al', path.join(SF_ROOT, 'node_modules'), path.join(PAIR, 'StudioFramework', 'node_modules')]);

  try {
    const initRes = studio(
      ['init', '--pair-root', PAIR, '--id', ID, `--port`, `web=${webPort}`, '--no-install'],
      {
        expect: 0,
        label: 'init',
      },
    );
    report('studio init registers the pair', initRes.status === 0);

    const upRes = studio(['-i', ID, 'up'], { env, expect: 0, label: 'up' });
    report('studio up starts the stack', upRes.status === 0, upRes.status === 0 ? '' : upRes.stderr);

    const nestRec = pidfile('nest');
    const gwRec = pidfile('gateway');
    const webRec = pidfile('web');
    report(
      'ENV pins nest port (args > env > config)',
      nestRec?.port === nestPort,
      `${nestRec?.port} vs ${nestPort}`,
    );
    report('ENV pins gateway port', gwRec?.port === gwPort, `${gwRec?.port} vs ${gwPort}`);
    report('web port comes from instance config', webRec?.port === webPort, `${webRec?.port} vs ${webPort}`);

    const health = await getJson(gwPort, '/api/health');
    report('gateway healthy and wired to its nest', !!health?.ok && health?.nest === true);

    const chat = await getJson(gwPort, '/api/new-chat', 'POST', {});
    report(
      'sessions isolated in the pair (PI_NEST_SESSIONS)',
      typeof chat?.file === 'string' && chat.file.startsWith(path.join(PAIR, '.studio', 'sessions')),
      chat?.file ?? 'no file',
    );
    report(
      'pair sessions do not leak into the default root',
      typeof chat?.file === 'string' && !chat.file.includes(`${path.sep}.pi${path.sep}`),
      '',
    );

    const guardRes = studio(['-i', ID, 'restart', 'nest'], { expect: 5, label: 'guard' });
    report('nest restart refused without --yes (exit 5)', guardRes.status === 5, `exit=${guardRes.status}`);
    report('guard explains the refusal', /src\/pi-nest/.test(guardRes.stderr + guardRes.stdout), '');

    const oldPid = nestRec?.pid;
    const restartRes = studio(['-i', ID, 'restart', 'nest', '--yes'], { env, expect: 0, label: 'restart' });
    const newRec = pidfile('nest');
    report('nest restart succeeds with --yes', restartRes.status === 0, restartRes.stderr);
    report(
      'nest restart spawns a new pid',
      newRec?.pid != null && newRec.pid !== oldPid,
      `${oldPid} → ${newRec?.pid}`,
    );
    report(
      'nest restart reuses the internal port',
      newRec?.port === nestPort,
      `${newRec?.port} vs ${nestPort}`,
    );

    const downRes = studio(['-i', ID, 'down'], { expect: 0, label: 'down' });
    report('down stops gateway + web', downRes.status === 0, '');
    const nestAfter = pidfile('nest');
    const gwAfter = pidfile('gateway');
    report('down keeps nest alive (covenant)', nestAfter?.pid === newRec?.pid, '');
    report('gateway stopped', !gwAfter?.pid, '');

    const webUp = await getJson(webPort, '/').catch(() => null);
    report('web port released after down', webUp === null || webUp === undefined, '');

    const fullDown = studio(['-i', ID, 'down', '--with-nest', '--yes'], { expect: 0, label: 'full down' });
    report('down --with-nest stops everything', fullDown.status === 0, '');

    const rmRes = studio(['worktree', 'rm', ID, '--purge', '--yes'], { expect: 0, label: 'worktree rm' });
    report('worktree rm tears down the pair', rmRes.status === 0 && !fs.existsSync(PAIR), rmRes.stderr);
    report('instance record removed', !fs.existsSync(path.join(CFG, 'instances', `${ID}.json`)), '');
    report('sessions purged with the pair', !fs.existsSync(path.join(PAIR, '.studio')), '');

    return isFailed() ? 1 : 0;
  } finally {
    studio(['-i', ID, 'down', '--with-nest', '--yes']);
    sh('git', ['worktree', 'remove', '--force', path.join(PAIR, 'pi-agent-studio')], {
      cwd: PRODUCT_ROOT,
      allowFail: true,
    });
    sh('git', ['worktree', 'remove', '--force', path.join(PAIR, 'StudioFramework')], {
      cwd: SF_ROOT,
      allowFail: true,
    });
    sh('git', ['worktree', 'prune'], { cwd: PRODUCT_ROOT, allowFail: true });
    sh('git', ['worktree', 'prune'], { cwd: SF_ROOT, allowFail: true });
    fs.rmSync(BASE, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
