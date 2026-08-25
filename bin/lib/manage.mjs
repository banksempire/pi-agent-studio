import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  appendAudit,
  instanceRepoRoot,
  instanceSessionsDir,
  instanceStateDir,
  listInstances,
  loadInstance,
  PRODUCT_ROOT,
  pidfilePath,
  RESERVED_PORTS,
  removeInstance,
  SF_ROOT,
  saveInstance,
  validId,
  webPortsInUse,
  worktreesRoot,
} from './instances.mjs';
import { alive, clearPidfile, pidHoldingPort, readPidfile, terminate } from './proc.mjs';
import {
  attributeProcesses,
  CliError,
  cmdDown,
  httpJson,
  listStatesSafe,
  pingBackend,
  serviceStatus,
} from './stack.mjs';
import { errSym, formatBytes, okSym, paint, printTable, warnSym } from './ui.mjs';

function git(args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new CliError(`git ${args.join(' ')} failed in ${cwd}: ${e.stderr ?? e.message}`, 1);
  }
}

function removeWorktreeDir(gitRoot, wtPath) {
  try {
    git(['worktree', 'remove', wtPath], gitRoot);
    return;
  } catch {
    git(['worktree', 'remove', '--force', wtPath], gitRoot, { allowFail: true });
    git(['worktree', 'prune'], gitRoot, { allowFail: true });
  }
}

function currentBranch(repo) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { allowFail: true });
}

function branchExists(repo, branch) {
  return !!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { allowFail: true });
}

function portBindable(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function autoWebPort(host = '0.0.0.0') {
  const used = webPortsInUse(null);
  for (let p = 7500; p < 7600; p++) {
    if (RESERVED_PORTS.includes(p) || used.has(p)) continue;
    if (await portBindable(p, host)) return p;
  }
  throw new CliError('no free web port found in 7500-7599', 1);
}

function validatePair(pairRoot) {
  const repo = path.join(pairRoot, 'pi-agent-studio');
  const sf = path.join(pairRoot, 'StudioFramework');
  if (!fs.existsSync(path.join(repo, 'package.json'))) {
    throw new CliError(`${repo} is not a pi-agent-studio checkout`, 2);
  }
  if (!fs.existsSync(path.join(sf, 'package.json'))) {
    throw new CliError(`${sf} is not a StudioFramework checkout (the @sf alias needs it as sibling)`, 2);
  }
  return { repo, sf };
}

function copyModulesFrom(srcRepo, dstRepo) {
  const src = path.join(srcRepo, 'node_modules');
  const dst = path.join(dstRepo, 'node_modules');
  if (fs.existsSync(dst) || !fs.existsSync(src)) return false;
  try {
    execFileSync('cp', ['-al', src, dst], { stdio: 'ignore' });
    return true;
  } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    try {
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function npmInstallIfMissing(dir, { skip = false } = {}) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return false;
  if (skip) {
    return true;
  }
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  return false;
}

export async function cmdInit(out, opts = {}) {
  let pairRoot = opts.pairRoot ? path.resolve(opts.pairRoot) : null;
  if (!pairRoot) {
    const cwd = process.cwd();
    if (
      path.basename(cwd) === 'pi-agent-studio' &&
      fs.existsSync(path.join(path.dirname(cwd), 'StudioFramework'))
    ) {
      pairRoot = path.dirname(cwd);
    } else if (
      fs.existsSync(path.join(cwd, 'pi-agent-studio')) &&
      fs.existsSync(path.join(cwd, 'StudioFramework'))
    ) {
      pairRoot = cwd;
    } else {
      throw new CliError(
        'run inside a pair root (dir with pi-agent-studio/ + StudioFramework/) or pass --pair-root',
        2,
      );
    }
  }
  const id = opts.id ?? path.basename(pairRoot);
  if (!validId(id)) throw new CliError(`invalid instance id: ${id}`, 2);
  validatePair(pairRoot);
  const existing = loadInstance(id);
  if (existing && !opts.force) {
    throw new CliError(`instance '${id}' already exists (use --force to re-register)`, 2);
  }
  const repo = path.join(pairRoot, 'pi-agent-studio');
  const branch = currentBranch(repo) ?? 'unknown';
  const host = opts.host ?? process.env.PI_STUDIO_WEB_HOST ?? '0.0.0.0';
  const webPort = Number(opts.port?.web ?? process.env.PI_STUDIO_WEB_PORT ?? 0) || (await autoWebPort(host));
  const used = webPortsInUse(id);
  if (used.has(webPort)) {
    throw new CliError(`web port ${webPort} already used by instance '${used.get(webPort)}'`, 4);
  }
  if (webPort !== 7492 && RESERVED_PORTS.includes(webPort)) {
    throw new CliError(`web port ${webPort} is reserved (7492/7494/7495 belong to main)`, 4);
  }
  const sessionsDir = opts.sessions
    ? path.resolve(opts.sessions)
    : path.join(pairRoot, '.studio', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const copiedPa = copyModulesFrom(PRODUCT_ROOT, repo);
  const copiedSf = copyModulesFrom(SF_ROOT, path.join(pairRoot, 'StudioFramework'));
  if (copiedPa || copiedSf) out.line(`${okSym} node_modules hardlink-copied (no install needed)`);
  const skippedPa = await npmInstallIfMissing(repo, { skip: opts.noInstall });
  const skippedSf = await npmInstallIfMissing(path.join(pairRoot, 'StudioFramework'), {
    skip: opts.noInstall,
  });
  saveInstance({
    id,
    pairRoot,
    branch,
    webPort,
    host,
    sessionsDir,
    createdAt: Date.now(),
  });
  out.line(`${okSym} instance ${paint('bold', id)} → ${pairRoot}`);
  out.line(`    branch ${branch} · web :${webPort} (${host}) · sessions ${sessionsDir}`);
  out.line(`    start with: studio -i ${id} up`);
  if (skippedPa || skippedSf) {
    out.line(`${warnSym} node_modules missing and --no-install given — run npm install before 'up'`);
  }
}

export async function cmdWorktreeAdd(out, opts = {}) {
  const id = opts.id;
  if (!id || !validId(id)) throw new CliError('worktree add requires an instance id', 2);
  const root = path.join(worktreesRoot(), id);
  if (fs.existsSync(root)) throw new CliError(`${root} already exists`, 2);
  if (loadInstance(id)) throw new CliError(`instance '${id}' already exists`, 2);
  if (opts.newBranch && branchExists(PRODUCT_ROOT, id)) {
    throw new CliError(`branch '${id}' already exists — drop --new or remove the branch`, 2);
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const ref = opts.from ?? (branchExists(PRODUCT_ROOT, id) ? id : 'main');
  const paArgs = ['worktree', 'add'];
  if (opts.newBranch) paArgs.push('-b', id, path.join(root, 'pi-agent-studio'), ref);
  else paArgs.push(path.join(root, 'pi-agent-studio'), ref);
  try {
    git(paArgs, PRODUCT_ROOT);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    git(['worktree', 'prune'], PRODUCT_ROOT, { allowFail: true });
    throw e;
  }
  try {
    const sfBranch = branchExists(SF_ROOT, id) ? id : null;
    if (sfBranch) {
      git(['worktree', 'add', path.join(root, 'StudioFramework'), sfBranch], SF_ROOT);
    } else {
      git(['worktree', 'add', '-b', id, path.join(root, 'StudioFramework'), opts.sfFrom ?? 'main'], SF_ROOT);
    }
  } catch (e) {
    git(['worktree', 'remove', '--force', path.join(root, 'pi-agent-studio')], PRODUCT_ROOT, {
      allowFail: true,
    });
    fs.rmSync(root, { recursive: true, force: true });
    git(['worktree', 'prune'], PRODUCT_ROOT, { allowFail: true });
    git(['worktree', 'prune'], SF_ROOT, { allowFail: true });
    throw e;
  }
  out.line(`${okSym} worktree pair ${root}`);
  await cmdInit(out, { ...opts, pairRoot: root, id, force: false });
}

export async function cmdWorktreeRm(out, opts = {}) {
  const id = opts.id;
  const inst = loadInstance(id);
  if (!inst) throw new CliError(`instance '${id}' not found`, 2);
  if (id === 'main') throw new CliError('main cannot be removed as a worktree', 2);
  await cmdDown(out, inst, { yes: opts.yes, force: opts.force });
  removeWorktreeDir(PRODUCT_ROOT, path.join(inst.pairRoot, 'pi-agent-studio'));
  removeWorktreeDir(SF_ROOT, path.join(inst.pairRoot, 'StudioFramework'));
  removeInstance(id);
  git(['worktree', 'prune'], PRODUCT_ROOT, { allowFail: true });
  git(['worktree', 'prune'], SF_ROOT, { allowFail: true });
  fs.rmSync(instanceStateDir(id), { recursive: true, force: true });
  if (opts.purge) fs.rmSync(path.join(inst.pairRoot, '.studio'), { recursive: true, force: true });
  try {
    fs.rmdirSync(inst.pairRoot);
  } catch {}
  out.line(`${okSym} removed worktree pair + instance ${id}${opts.purge ? ' (sessions purged)' : ''}`);
}

export async function cmdInstanceLs(out) {
  const rows = [];
  const attributed = attributeProcesses();
  for (const id of listInstances()) {
    const inst = loadInstance(id);
    let upCount = 0;
    for (const svc of ['backend', 'web']) {
      if (serviceStatus(inst, svc, attributed).state !== 'stopped') upCount += 1;
    }
    rows.push([
      id,
      inst.branch ?? '',
      String(inst.webPort ?? ''),
      `${upCount}/2`,
      inst.pairRoot ?? '',
      id === 'main' ? paint('gray', 'product') : '',
    ]);
  }
  if (out.json) {
    out.raw(
      `${JSON.stringify(Object.fromEntries(rows.map((r) => [r[0], { branch: r[1], webPort: r[2], up: r[3], pairRoot: r[4] }])))}\n`,
    );
    return;
  }
  if (rows.length === 0) {
    out.line('no instances (run studio init or studio worktree add)');
    return;
  }
  printTable(['INSTANCE', 'BRANCH', 'WEB', 'UP', 'PAIR ROOT', ''], rows);
}

export async function cmdInstanceShow(out, id) {
  const inst = loadInstance(id);
  if (!inst) throw new CliError(`instance '${id}' not found`, 2);
  if (out.json) {
    out.raw(`${JSON.stringify(inst)}\n`);
    return;
  }
  for (const [k, v] of Object.entries(inst)) out.line(`  ${k.padEnd(12)} ${v}`);
  out.line(`  sessionsDir  ${instanceSessionsDir(inst)}`);
}

export async function cmdInstanceSet(out, id, pairs) {
  const inst = loadInstance(id);
  if (!inst) throw new CliError(`instance '${id}' not found`, 2);
  const numeric = ['webPort', 'gatewayPort', 'nestPort'];
  const allowed = [...numeric, 'host', 'sessionsDir', 'statesPath', 'branch', 'pairRoot', 'cwd'];
  const next = { ...inst };
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) throw new CliError(`expected key=value, got '${pair}'`, 2);
    const key = pair.slice(0, i);
    let value = pair.slice(i + 1);
    if (!allowed.includes(key))
      throw new CliError(`unknown key '${key}' (allowed: ${allowed.join(', ')})`, 2);
    if (numeric.includes(key)) {
      value = Number(value);
      if (!Number.isFinite(value)) throw new CliError(`${key} must be a number`, 2);
      if (key === 'webPort' && value !== 7492 && RESERVED_PORTS.includes(value) && id !== 'main') {
        throw new CliError(`web port ${value} is reserved (7492/7494/7495 belong to main)`, 4);
      }
      const used = webPortsInUse(id);
      if (key === 'webPort' && used.has(value)) {
        throw new CliError(`web port ${value} already used by instance '${used.get(value)}'`, 4);
      }
    }
    next[key] = value === '' ? null : value;
  }
  saveInstance(next);
  out.line(`${okSym} instance ${id} updated`);
}

export async function cmdInstanceRm(out, id) {
  const inst = loadInstance(id);
  if (!inst) throw new CliError(`instance '${id}' not found`, 2);
  if (id === 'main') throw new CliError('main cannot be removed', 2);
  for (const svc of ['backend', 'web']) {
    const rec = readPidfile(pidfilePath(id, svc));
    if (rec?.pid && alive(rec.pid)) {
      throw new CliError(`instance '${id}' still has a live ${svc} — run studio -i ${id} down first`, 1);
    }
  }
  removeInstance(id);
  fs.rmSync(instanceStateDir(id), { recursive: true, force: true });
  out.line(`${okSym} instance ${id} removed`);
}

function heapSnapshots(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^Heap-\d+\.heapsnapshot$/.test(f));
  } catch {
    return [];
  }
}

async function doctorInstance(inst, results) {
  const prefix = inst.id;
  const push = (name, level, detail) => results.push({ scope: prefix, name, level, detail });
  if (!fs.existsSync(inst.pairRoot)) {
    push('pair root', 'err', `${inst.pairRoot} missing`);
    return;
  }
  try {
    validatePair(inst.pairRoot);
    push('pair layout', 'ok', '');
  } catch (e) {
    push('pair layout', 'err', e.message);
    return;
  }
  const repo = instanceRepoRoot(inst);
  if (!fs.existsSync(path.join(repo, 'node_modules'))) push('node_modules', 'err', `missing in ${repo}`);
  else push('node_modules', 'ok', '');
  if (!fs.existsSync(path.join(inst.pairRoot, 'StudioFramework', 'node_modules'))) {
    push('sf node_modules', 'warn', `missing in ${inst.pairRoot}/StudioFramework`);
  }
  const branch = currentBranch(repo);
  if (inst.branch && branch && branch !== inst.branch && branch !== 'unknown') {
    push('branch drift', 'warn', `recorded ${inst.branch}, checked out ${branch}`);
  }
  for (const svc of ['backend', 'web']) {
    const rec = readPidfile(pidfilePath(inst.id, svc));
    if (!rec?.pid) continue;
    if (!alive(rec.pid)) {
      push(`pidfile ${svc}`, 'warn', `stale (pid ${rec.pid} dead)`);
    }
  }
  const attributed = attributeProcesses([inst]);
  for (const svc of ['backend', 'web']) {
    const rec = readPidfile(pidfilePath(inst.id, svc));
    const mine = attributed.rows.filter((r) => r.instanceId === inst.id && r.service === svc);
    const primary = mine.find((r) => r.pid === rec?.pid);
    const extras = mine.filter((r) => r !== primary);
    if (extras.length > 0) {
      push(
        `stray ${svc}`,
        'warn',
        `${extras.length} extra process(es): ${extras.map((e) => `pid ${e.pid}${e.ports.length ? ` :${e.ports.join(',')}` : ''}`).join(', ')}`,
      );
    }
    if (svc === 'web' && !primary && inst.webPort) {
      const holderPid = pidHoldingPort(attributed.listeners, inst.webPort);
      const holder = attributed.rows.find((r) => r.pid === holderPid);
      if (holderPid && holder?.instanceId !== inst.id) {
        push('web port', 'err', `:${inst.webPort} held by foreign pid ${holderPid}`);
      }
    }
  }
  const backendRec = readPidfile(pidfilePath(inst.id, 'backend')) ?? {};
  if (alive(backendRec.pid)) {
    const ping = await pingBackend(backendRec.port ?? inst.backendPort ?? 7494);
    push('backend ping', ping.ok ? 'ok' : 'err', ping.ok ? '' : `unreachable on :${backendRec.port}`);
    if (ping.ok) {
      const states = await listStatesSafe(backendRec.port);
      if (states) push('backend agents', 'info', `${states.length} open`);
    }
    const r = await httpJson(backendRec.port ?? inst.backendPort ?? 7494);
    if (r.status !== 200 || !r.json?.ok) push('backend health', 'err', `:${backendRec.port} not healthy`);
    else {
      const mem = r.json.mem ?? {};
      const heapPct = mem.heapLimit ? (mem.heapUsed / mem.heapLimit) * 100 : 0;
      if (heapPct >= 85 || (mem.rss ?? 0) >= 1.7 * 1024 * 1024 * 1024) {
        push(
          'backend health',
          'warn',
          `rss ${formatBytes(mem.rss)} · heap ${heapPct.toFixed(0)}% near ceiling`,
        );
      } else {
        push('backend health', 'ok', `rss ${formatBytes(mem.rss)} · ${r.json.sseClients ?? 0} sse clients`);
      }
    }
  }
  const snaps = heapSnapshots(repo);
  if (snaps.length > 0) {
    const bytes = snaps.reduce((a, f) => a + fs.statSync(path.join(repo, f)).size, 0);
    push('heap snapshots', 'warn', `${snaps.length} file(s), ${formatBytes(bytes)} in ${repo}`);
  }
}

function guardHooksDir() {
  return path.join(PRODUCT_ROOT, 'hooks');
}

export async function cmdGuard(out, { action = 'status' } = {}) {
  const hooksDir = guardHooksDir();
  if (action === 'install') {
    for (const f of ['pre-commit', 'pre-push']) {
      const p = path.join(hooksDir, f);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
    for (const repo of [PRODUCT_ROOT, SF_ROOT]) {
      git(['config', 'core.hooksPath', hooksDir], repo);
      out.line(`${okSym} ${path.basename(repo)} → core.hooksPath ${hooksDir}`);
    }
    return;
  }
  for (const repo of [PRODUCT_ROOT, SF_ROOT]) {
    const cur = git(['config', 'core.hooksPath'], repo, { allowFail: true });
    out.line(`${path.basename(repo)}: ${cur ?? '(not set) — studio guard install'}`);
  }
}

function guardCheck(results) {
  const hooksDir = guardHooksDir();
  let missing = false;
  for (const repo of [PRODUCT_ROOT, SF_ROOT]) {
    const cur = git(['config', 'core.hooksPath'], repo, { allowFail: true });
    if (cur === hooksDir) {
      results.push({ scope: 'guard', name: path.basename(repo), level: 'ok', detail: 'hooks active' });
    } else {
      missing = true;
      results.push({
        scope: 'guard',
        name: path.basename(repo),
        level: 'warn',
        detail: 'core.hooksPath not set — studio guard install',
      });
    }
  }
  return missing;
}

export async function cmdDoctor(out, opts = {}) {
  const results = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  results.push({
    scope: 'env',
    name: 'node version',
    level: nodeMajor >= 18 ? 'ok' : 'err',
    detail: nodeMajor >= 18 ? `${nodeMajor}.x` : `node ${nodeMajor}.x too old (need >= 18)`,
  });
  const guardMissing = guardCheck(results);
  const ids = opts.instance ? [opts.instance] : listInstances();
  const insts = ids.map((id) => loadInstance(id)).filter(Boolean);
  for (const inst of insts) await doctorInstance(inst, results);
  const attributed = attributeProcesses();
  const unattributed = attributed.rows.filter((r) => !r.instanceId);
  const scopedRoot = opts.instance && insts[0]?.pairRoot ? path.resolve(insts[0].pairRoot) : null;
  for (const u of unattributed) {
    results.push({
      scope: 'orphans',
      name: u.service,
      level: 'warn',
      detail: `pid ${u.pid}${u.ports.length ? ` :${u.ports.join(',')}` : ''} cwd ${u.cwd ?? '?'}`,
    });
  }
  const seen = new Map();
  for (const inst of insts) {
    const dir = path.resolve(instanceSessionsDir(inst));
    if (seen.has(dir)) {
      results.push({
        scope: 'cross',
        name: 'sessions dir',
        level: 'err',
        detail: `${dir} shared by ${seen.get(dir)} and ${inst.id}`,
      });
    } else seen.set(dir, inst.id);
  }
  const portSeen = new Map();
  for (const inst of insts) {
    if (!inst.webPort) continue;
    if (portSeen.has(inst.webPort)) {
      results.push({
        scope: 'cross',
        name: 'web port',
        level: 'err',
        detail: `:${inst.webPort} used by ${portSeen.get(inst.webPort)} and ${inst.id}`,
      });
    } else portSeen.set(inst.webPort, inst.id);
  }
  for (const id of listInstances()) {
    const inst = loadInstance(id);
    if (id !== 'main' && inst?.pairRoot && !fs.existsSync(inst.pairRoot)) {
      results.push({
        scope: 'cross',
        name: 'dead instance',
        level: 'warn',
        detail: `${id}: pair root ${inst.pairRoot} gone → studio clean --instances`,
      });
    }
  }
  if (opts.fix) {
    let fixed = 0;
    if (guardMissing) {
      await cmdGuard(out, { action: 'install' });
      fixed += 1;
    }
    for (const svc of ['backend', 'web']) {
      for (const inst of insts) {
        const rec = readPidfile(pidfilePath(inst.id, svc));
        if (rec && !alive(rec.pid)) {
          clearPidfile(pidfilePath(inst.id, svc));
          fixed += 1;
        }
      }
    }
    const isolatedRegistry = !!(process.env.PI_STUDIO_CONFIG_DIR || process.env.PI_STUDIO_STATE_DIR);
    for (const u of unattributed) {
      if (isolatedRegistry) {
        out.line(
          `${warnSym} orphan ${u.service} pid ${u.pid} left alone (isolated registry — belongs to another instance set)`,
        );
        continue;
      }
      if (scopedRoot && !(u.cwd && (u.cwd === scopedRoot || u.cwd.startsWith(`${scopedRoot}${path.sep}`)))) {
        out.line(
          `${warnSym} orphan ${u.service} pid ${u.pid} left alone (outside ${opts.instance} — run doctor without -i to sweep)`,
        );
        continue;
      }
      out.line(`${warnSym} killing orphan ${u.service} pid ${u.pid}`);
      appendAudit(null, {
        action: 'terminate',
        reason: 'doctor-orphan-sweep',
        service: u.service,
        pid: u.pid,
        caller: process.argv.slice(1).join(' '),
      });
      await terminate(u.pid, 3000);
      fixed += 1;
    }
    for (const inst of insts) {
      const attributed2 = attributeProcesses([inst]);
      for (const svc of ['backend', 'web']) {
        const rec = readPidfile(pidfilePath(inst.id, svc));
        const expected = svc === 'backend' ? inst.backendPort : inst.webPort;
        const mine = attributed2.rows.filter((r) => r.instanceId === inst.id && r.service === svc);
        const primary =
          mine.find((r) => r.pid === rec?.pid) ??
          mine.find((r) => expected && r.ports.includes(Number(expected))) ??
          mine[0];
        for (const extra of mine) {
          if (extra === primary) continue;
          out.line(`${warnSym} killing stray ${inst.id}/${svc} pid ${extra.pid}`);
          appendAudit(inst.id, {
            action: 'terminate',
            reason: 'doctor-stray-sweep',
            service: svc,
            pid: extra.pid,
            caller: process.argv.slice(1).join(' '),
          });
          await terminate(extra.pid, 3000);
          fixed += 1;
        }
      }
    }
    out.line(`${okSym} applied ${fixed} fix(es)`);
  }
  if (out.json) {
    out.raw(`${JSON.stringify({ results })}\n`);
    return;
  }
  for (const r of results) {
    const sym = r.level === 'ok' ? okSym : r.level === 'err' ? errSym : warnSym;
    const scope = r.level === 'info' ? paint('gray', `[${r.scope}]`) : `[${r.scope}]`;
    out.line(`  ${sym} ${scope} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const errs = results.filter((r) => r.level === 'err').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  out.line(paint('gray', `  ${errs} error(s), ${warns} warning(s)`));
  if (errs > 0 && !opts.fix) process.exitCode = 1;
}

export async function cmdClean(out, opts = {}) {
  const doSnaps = opts.snapshots;
  const doPidfiles = opts.pidfiles;
  const doInstances = opts.instances;
  const all = !doSnaps && !doPidfiles && !doInstances;
  let count = 0;
  if (doPidfiles || all) {
    for (const id of listInstances()) {
      for (const svc of ['backend', 'web', 'nest', 'gateway']) {
        const file = pidfilePath(id, svc);
        const rec = readPidfile(file);
        if (rec?.pid && !alive(rec.pid)) {
          clearPidfile(file);
          count += 1;
        }
      }
    }
  }
  if (doSnaps || all) {
    const dirs = [PRODUCT_ROOT, ...listInstances().map((id) => instanceRepoRoot(loadInstance(id)))];
    for (const dir of dirs) {
      for (const f of heapSnapshots(dir)) {
        fs.rmSync(path.join(dir, f));
        count += 1;
      }
    }
  }
  if (doInstances) {
    for (const id of listInstances()) {
      const inst = loadInstance(id);
      if (id !== 'main' && inst?.pairRoot && !fs.existsSync(inst.pairRoot)) {
        removeInstance(id);
        fs.rmSync(instanceStateDir(id), { recursive: true, force: true });
        count += 1;
      }
    }
  }
  out.line(`${okSym} cleaned ${count} item(s)`);
}

export async function cmdOpen(out, instance) {
  const host = instance.host === '0.0.0.0' || !instance.host ? '127.0.0.1' : instance.host;
  const url = `http://${host}:${instance.webPort}/`;
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
  child.once('error', () => out.line(url));
  out.line(`${okSym} ${url}`);
}
