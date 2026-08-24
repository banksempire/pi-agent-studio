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
const WT = path.join(BASE, '.branch');
const PAIR = path.join(WT, 'check');
const ID = 'check';
const RESERVED = [7492, 7493, 7494, 7495];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env });

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
  const file = path.join(PAIR, '.studio', 'state', 'pids', `${service}.json`);
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

  const CHECK_ROOT = path.join(path.dirname(PRODUCT_ROOT), '.studio-check');
  if (fs.existsSync(CHECK_ROOT)) {
    let swept = 0;
    for (const pidDir of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      let cwd = null;
      try {
        cwd = fs.readlinkSync(`/proc/${pidDir}/cwd`);
      } catch {
        continue;
      }
      if (cwd?.startsWith(`${CHECK_ROOT}${path.sep}`)) {
        try {
          process.kill(Number(pidDir), 'SIGKILL');
          swept += 1;
        } catch {}
      }
    }
    fs.rmSync(CHECK_ROOT, { recursive: true, force: true });
    sh('git', ['worktree', 'prune'], { cwd: PRODUCT_ROOT, allowFail: true });
    sh('git', ['worktree', 'prune'], { cwd: SF_ROOT, allowFail: true });
    if (swept > 0) console.log(`  swept ${swept} leftover process(es) from a prior/killed run`);
  }
  fs.mkdirSync(WT, { recursive: true });

  const HOOKS = path.join(PRODUCT_ROOT, 'hooks');
  const scratch = path.join(BASE, 'guard-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], scratch);
  run('git', ['config', 'user.email', 'check@studio.local'], scratch);
  run('git', ['config', 'user.name', 'studio-check'], scratch);
  run('git', ['config', 'core.hooksPath', HOOKS], scratch);
  fs.writeFileSync(path.join(scratch, 'code.ts'), 'x\n');
  run('git', ['add', '.'], scratch);
  const g1 = run('git', ['commit', '-qm', 'probe'], scratch);
  report(
    'guard blocks non-docs commit outside .branch',
    g1.status !== 0 && /refusing commit on main/.test(g1.stderr),
    '',
  );
  const g2 = run('git', ['commit', '-qm', 'probe'], scratch, { ...process.env, STUDIO_ALLOW_MAIN: '1' });
  report('STUDIO_ALLOW_MAIN overrides the main rule', g2.status === 0, g2.stderr);
  fs.writeFileSync(path.join(scratch, 'notes.md'), 'x\n');
  run('git', ['add', '.'], scratch);
  const g3 = run('git', ['commit', '-qm', 'docs'], scratch);
  report('docs-only commits allowed on main', g3.status === 0, g3.stderr);
  run('git', ['checkout', '-q', '-b', 'feat'], scratch);
  fs.writeFileSync(path.join(scratch, 'feat.ts'), 'x\n');
  run('git', ['add', '.'], scratch);
  run('git', ['commit', '-qm', 'feat'], scratch, { ...process.env, STUDIO_ALLOW_MAIN: '1' });
  run('git', ['checkout', '-q', 'main'], scratch);
  const g4 = run('git', ['merge', '--no-ff', '-qm', 'merge feat', 'feat'], scratch);
  report('merge commits allowed on main (release path)', g4.status === 0, g4.stderr);

  const branchRepo = path.join(BASE, '.branch', 'demo-repo');
  fs.mkdirSync(branchRepo, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], branchRepo);
  run('git', ['config', 'user.email', 'check@studio.local'], branchRepo);
  run('git', ['config', 'user.name', 'studio-check'], branchRepo);
  run('git', ['config', 'core.hooksPath', HOOKS], branchRepo);
  fs.writeFileSync(path.join(branchRepo, 'code.ts'), 'x\n');
  run('git', ['add', '.'], branchRepo);
  const g5 = run('git', ['commit', '-qm', 'probe'], branchRepo);
  report('commits inside .branch/* allowed', g5.status === 0, g5.stderr);

  const mainPair = path.dirname(PRODUCT_ROOT);
  const envProbe = spawnSync(
    'node',
    [
      '--input-type=module',
      `-e`,
      `import { configDir, stateRoot } from ${JSON.stringify(
        `file://${path.join(PRODUCT_ROOT, 'bin', 'lib', 'instances.mjs')}`,
      )}; console.log(configDir()); console.log(stateRoot());`,
    ],
    {
      encoding: 'utf8',
      env: (() => {
        const e = { ...process.env };
        delete e.PI_STUDIO_CONFIG_DIR;
        delete e.PI_STUDIO_STATE_DIR;
        return e;
      })(),
    },
  );
  const [defConfig, defState] = (envProbe.stdout ?? '').split('\n');
  report(
    'default registry/state live under <workdir>/.studio (restart-persistent)',
    envProbe.status === 0 &&
      defConfig === path.join(mainPair, '.studio', 'config') &&
      defState === path.join(mainPair, '.studio', 'state'),
    `${defConfig ?? envProbe.stderr?.split('\n')[0] ?? 'no output'}`,
  );

  sh('git', ['worktree', 'add', '--detach', path.join(PAIR, 'pi-agent-studio'), 'HEAD'], {
    cwd: PRODUCT_ROOT,
  });
  sh('git', ['worktree', 'add', '--detach', path.join(PAIR, 'StudioFramework'), 'HEAD'], {
    cwd: SF_ROOT,
  });
  sh('cp', ['-r', `${path.join(PRODUCT_ROOT, 'src')}/.`, path.join(PAIR, 'pi-agent-studio', 'src')]);

  try {
    const initRes = studio(
      ['init', '--pair-root', PAIR, '--id', ID, `--port`, `web=${webPort}`, '--no-install'],
      {
        expect: 0,
        label: 'init',
      },
    );
    report('studio init registers the pair', initRes.status === 0);
    report(
      'init hardlink-copies node_modules (zero-friction branch setup)',
      fs.existsSync(path.join(PAIR, 'pi-agent-studio', 'node_modules', '.bin', 'vite')),
      '',
    );

    const pairRepo = path.join(PAIR, 'pi-agent-studio');
    const hookGit = ['-c', `core.hooksPath=${path.join(PRODUCT_ROOT, 'hooks')}`];
    fs.writeFileSync(path.join(pairRepo, 'lintprobe.mjs'), 'const x = "double";\n');
    sh('git', [...hookGit, 'add', 'lintprobe.mjs'], { cwd: pairRepo });
    const b1 = run('git', [...hookGit, 'commit', '-qm', 'lint probe'], pairRepo);
    report(
      'pre-commit blocks lint errors (biome gate)',
      b1.status !== 0 && /biome|lint/.test(b1.stdout + b1.stderr),
      b1.stdout.slice(0, 80),
    );
    fs.writeFileSync(path.join(pairRepo, 'lintprobe.mjs'), "export const x = 'single';\n");
    sh('git', [...hookGit, 'add', 'lintprobe.mjs'], { cwd: pairRepo });
    const b2 = run('git', [...hookGit, 'commit', '-qm', 'lint probe fixed'], pairRepo);
    report('pre-commit passes when biome-clean', b2.status === 0, b2.stderr);

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
    report(
      'all branch state lives in the branch folder',
      fs.existsSync(path.join(PAIR, '.studio', 'state', 'pids', 'nest.json')) &&
        fs.existsSync(path.join(PAIR, '.studio', 'state', 'logs', 'nest.log')),
      '',
    );
    report('nothing leaks into the machine state dir', !fs.existsSync(path.join(STATE, 'instances', ID)), '');

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

    const restart2 = studio(['-i', ID, 'restart', 'nest', '--yes'], { expect: 0, label: 'restart-no-env' });
    const rec2 = pidfile('nest');
    report(
      'internal port survives without ENV (tombstone reuse)',
      restart2.status === 0 && rec2?.port === nestPort,
      `${rec2?.port} vs ${nestPort}`,
    );
    let health2 = null;
    for (let i = 0; i < 12 && health2?.nest !== true; i++) {
      health2 = await getJson(gwPort, '/api/health').catch(() => null);
      if (health2?.nest !== true) await delay(500);
    }
    report(
      'gateway still wired to its nest after tombstone restart',
      health2?.ok === true && health2?.nest === true,
    );

    const gwPidBefore = pidfile('gateway')?.pid;
    const gwRestart = studio(['-i', ID, 'restart', 'gateway'], { expect: 0, label: 'restart gateway' });
    report(
      'restart gateway leaves its nest pair running',
      gwRestart.status === 0 && pidfile('nest')?.pid === rec2?.pid,
      `${pidfile('nest')?.pid} vs ${rec2?.pid}`,
    );
    report(
      'restart gateway respawns only the gateway',
      pidfile('gateway')?.pid != null && pidfile('gateway').pid !== gwPidBefore,
      `${gwPidBefore} → ${pidfile('gateway')?.pid}`,
    );
    let health3 = null;
    for (let i = 0; i < 12 && health3?.nest !== true; i++) {
      health3 = await getJson(gwPort, '/api/health').catch(() => null);
      if (health3?.nest !== true) await delay(500);
    }
    report('gateway healthy after its own restart', health3?.ok === true && health3?.nest === true);

    const downRes = studio(['-i', ID, 'down'], { expect: 0, label: 'down' });
    report('down tears down the full stack (no --yes needed, no agents)', downRes.status === 0, '');
    report('down stops the nest pair', !pidfile('nest')?.pid, '');
    report('down stops the gateway', !pidfile('gateway')?.pid, '');

    const webUp = await getJson(webPort, '/').catch(() => null);
    report('web port released after down', webUp === null || webUp === undefined, '');

    const pairUp = studio(['-i', ID, 'up', 'gateway'], { env, expect: 0, label: 'up gateway' });
    report(
      'up gateway brings up its nest pair',
      pairUp.status === 0 && pidfile('nest')?.pid != null,
      pairUp.stderr,
    );
    report('up gateway does not start web', !pidfile('web')?.pid, '');
    let health4 = null;
    for (let i = 0; i < 12 && health4?.nest !== true; i++) {
      health4 = await getJson(gwPort, '/api/health').catch(() => null);
      if (health4?.nest !== true) await delay(500);
    }
    report('gateway+nest pair healthy after up gateway', health4?.ok === true && health4?.nest === true);

    const killGw = studio(['-i', ID, 'kill', 'gateway'], { expect: 0, label: 'kill gateway' });
    report(
      'kill gateway stops the nest pair too',
      killGw.status === 0 && !pidfile('gateway')?.pid && !pidfile('nest')?.pid,
      '',
    );

    const webAlone = studio(['-i', ID, 'up', 'web'], { expect: 3, label: 'up web alone' });
    report(
      'up web refuses without a live gateway',
      webAlone.status === 3 && /gateway/.test(webAlone.stderr),
      `exit=${webAlone.status}`,
    );

    const rmRes = studio(['worktree', 'rm', ID, '--purge', '--yes'], { expect: 0, label: 'worktree rm' });
    report('worktree rm tears down the pair', rmRes.status === 0 && !fs.existsSync(PAIR), rmRes.stderr);
    report('instance record removed', !fs.existsSync(path.join(CFG, 'instances', `${ID}.json`)), '');
    report('sessions purged with the pair', !fs.existsSync(path.join(PAIR, '.studio')), '');

    return isFailed() ? 1 : 0;
  } finally {
    studio(['-i', ID, 'down', '--yes']);
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
    if (!process.env.KEEPDIR) fs.rmSync(BASE, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
