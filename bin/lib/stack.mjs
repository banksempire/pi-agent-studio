import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { PiNestClient } from '../../src/pi-nest/src/client.mjs';
import {
  instanceRepoRoot,
  instanceSessionsDir,
  instanceStateDir,
  instanceStatesPath,
  listInstances,
  loadInstance,
  logPath,
  pidfilePath,
  RESERVED_PORTS,
  SERVICE_NAMES,
  webPortsInUse,
} from './instances.mjs';
import {
  alive,
  clearPidfile,
  delay,
  listenPortsByPid,
  listServiceProcesses,
  newestMtime,
  pickFreePort,
  pidHoldingPort,
  procStartMs,
  readPidfile,
  spawnDetached,
  terminate,
  withLock,
  writePidfile,
} from './proc.mjs';
import { errSym, formatBytes, formatDuration, okSym, paint, warnSym } from './ui.mjs';

const GRACE = { web: 5000, gateway: 8000, nest: 10000 };

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function nestClient(port, host = '127.0.0.1') {
  return new PiNestClient({ host, port: Number(port) });
}

export async function pingNest(port, timeoutMs = 2000) {
  const client = nestClient(port);
  try {
    const res = await Promise.race([
      client.ping(),
      delay(timeoutMs).then(() => {
        throw new Error('timeout');
      }),
    ]);
    return { ok: !!res?.ok };
  } catch {
    return { ok: false };
  } finally {
    client.close();
  }
}

export async function listStatesSafe(port) {
  const client = nestClient(port);
  try {
    const res = await Promise.race([
      client.listStates(),
      delay(2500).then(() => {
        throw new Error('timeout');
      }),
    ]);
    return res?.states ?? [];
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export function httpJson(port, pathname = '/api/health', timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: Number(port), path: pathname }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
  });
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      lastErr = e;
    }
    await delay(250);
  }
  throw new CliError(`${label} not healthy after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ''}`, 3);
}

export function resolveSessionsDir(instance, opts = {}) {
  if (opts.sessions) return path.resolve(opts.sessions);
  const env = process.env.PI_NEST_SESSIONS ?? process.env.PI_STUDIO_SESSIONS;
  if (env) return path.resolve(env);
  return instanceSessionsDir(instance);
}

export async function confirm(question, defYes = false) {
  let inFd;
  let outFd;
  try {
    inFd = fs.openSync('/dev/tty', 'r');
    outFd = fs.openSync('/dev/tty', 'w');
  } catch {
    return false;
  }
  const rl = readline.createInterface({
    input: fs.createReadStream('/dev/tty', { fd: inFd }),
    output: fs.createWriteStream('/dev/tty', { fd: outFd }),
  });
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      resolve('');
    }, 60000);
    rl.on('error', () => {
      clearTimeout(timer);
      resolve('');
      rl.close();
    });
    rl.question(`${question} [${defYes ? 'Y/n' : 'y/N'}] `, (ans) => {
      clearTimeout(timer);
      resolve(ans);
    });
  });
  try {
    rl.close();
  } catch {}
  const t = answer.trim().toLowerCase();
  if (t === '') return defYes;
  return t === 'y' || t === 'yes';
}

function portFromProxy(env) {
  const m = (env.PI_API_PROXY ?? '').match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function attributeProcesses(instances = null) {
  const insts = (instances ?? listInstances().map((id) => loadInstance(id))).filter(Boolean);
  const listeners = listenPortsByPid();
  const rows = [];
  for (const proc of listServiceProcesses()) {
    let instanceId = null;
    let via = null;
    for (const inst of insts) {
      const rec = readPidfile(pidfilePath(inst.id, proc.service));
      if (rec?.pid === proc.pid) {
        instanceId = inst.id;
        via = 'pidfile';
        break;
      }
    }
    if (!instanceId && proc.cwd) {
      for (const inst of insts) {
        const root = path.resolve(inst.pairRoot ?? '');
        if (root && (proc.cwd === root || proc.cwd.startsWith(`${root}${path.sep}`))) {
          instanceId = inst.id;
          via = 'cwd';
          break;
        }
      }
    }
    if (!instanceId) {
      const nestEnv = Number(proc.environ.PI_NEST_PORT ?? 0);
      const gwEnv = Number(proc.environ.PI_STUDIO_PORT ?? 0);
      const proxyEnv = portFromProxy(proc.environ);
      for (const inst of insts) {
        const nestRec = readPidfile(pidfilePath(inst.id, 'nest'));
        const gwRec = readPidfile(pidfilePath(inst.id, 'gateway'));
        const matches =
          (proc.service === 'nest' && nestEnv && nestEnv === (inst.nestPort ?? nestRec?.port)) ||
          (proc.service === 'gateway' &&
            ((gwEnv && gwEnv === (inst.gatewayPort ?? gwRec?.port)) ||
              (proxyEnv && proxyEnv === (inst.gatewayPort ?? gwRec?.port))));
        if (matches) {
          instanceId = inst.id;
          via = 'environ';
          break;
        }
      }
    }
    const ports = listeners.get(proc.pid) ?? new Set();
    rows.push({ ...proc, instanceId, via, ports: [...ports].sort((a, b) => a - b) });
  }
  return { rows, listeners };
}

export function serviceStatus(instance, service, attributed) {
  const pidRec = readPidfile(pidfilePath(instance.id, service));
  const mine = attributed.rows.filter((r) => r.instanceId === instance.id && r.service === service);
  const primary = pidRec?.pid ? mine.find((r) => r.pid === pidRec.pid) : null;
  const extras = mine.filter((r) => r !== primary);
  const expected =
    service === 'nest' ? instance.nestPort : service === 'gateway' ? instance.gatewayPort : instance.webPort;
  let port = pidRec?.port ?? null;
  if (primary) {
    port = primary.ports[0] ?? port;
  } else if (mine.length > 0) {
    const holder = mine.find((r) => expected && r.ports.includes(Number(expected)));
    port = holder?.ports[0] ?? mine[0].ports[0] ?? port;
  }
  let state = 'stopped';
  if (primary) {
    state = 'up';
  } else if (mine.length > 0) {
    state = 'orphan';
  }
  return { service, state, pid: primary?.pid ?? pidRec?.pid ?? null, port, primary, extras, mine };
}

async function serviceHealth(service, port) {
  if (!port) return { ok: false };
  if (service === 'nest') return pingNest(port);
  if (service === 'gateway') {
    const r = await httpJson(port, '/api/health');
    return { ok: r.status === 200 && r.json?.ok === true, nest: r.json?.nest === true, json: r.json };
  }
  const r = await httpJson(port, '/', 3000);
  return { ok: r.status === 200 };
}

function resolveWebHost(instance, opts = {}) {
  return opts.host ?? process.env.PI_STUDIO_WEB_HOST ?? instance.host ?? '0.0.0.0';
}

async function resolveServicePort(instance, service, opts, used) {
  const argPort = Number(opts.port?.[service] ?? 0);
  if (argPort) return argPort;
  if (service === 'nest' && process.env.PI_NEST_PORT) return Number(process.env.PI_NEST_PORT);
  if (service === 'gateway' && process.env.PI_STUDIO_PORT) return Number(process.env.PI_STUDIO_PORT);
  if (service === 'web' && process.env.PI_STUDIO_WEB_PORT) {
    return Number(process.env.PI_STUDIO_WEB_PORT);
  }
  const pin =
    service === 'nest' ? instance.nestPort : service === 'gateway' ? instance.gatewayPort : instance.webPort;
  if (pin) return Number(pin);
  if (service === 'web') {
    throw new CliError(`instance ${instance.id} has no web port — run studio init`, 2);
  }
  const rec = readPidfile(pidfilePath(instance.id, service));
  if (rec?.port && !used.has(rec.port)) {
    const holder = pidHoldingPort(listenPortsByPid(), rec.port);
    if (!holder) return Number(rec.port);
  }
  return pickFreePort('127.0.0.1', used);
}

async function tryAdopt(out, instance, service, ports) {
  const attributed = attributeProcesses([instance]);
  const status = serviceStatus(instance, service, attributed);
  const candidates = status.primary
    ? [status.primary, ...status.extras]
    : attributed.rows.filter((r) => r.instanceId === instance.id && r.service === service);
  for (const cand of candidates) {
    const port = cand.ports[0];
    if (!port) continue;
    const health = await serviceHealth(service, port);
    if (!health.ok) continue;
    if (service === 'gateway') {
      const gwNest = Number(cand.environ.PI_NEST_PORT ?? 0) || 7495;
      if (ports.nest && gwNest !== ports.nest) continue;
      if (!health.nest) continue;
    }
    if (service === 'web' && port !== instance.webPort) continue;
    writePidfile(pidfilePath(instance.id, service), {
      pid: cand.pid,
      pgid: cand.pid,
      startedAt: procStartMs(cand.pid) ?? Date.now(),
      service,
      instance: instance.id,
      port,
      adopted: true,
      argv: cand.argv,
      cwd: cand.cwd,
    });
    out.event({
      event: status.primary ? 'up' : 'adopted',
      instance: instance.id,
      service,
      pid: cand.pid,
      port,
      message: `${paint('cyan', `${instance.id}/${service}`)}  ${okSym} already up (pid ${cand.pid}, :${port})`,
    });
    return { pid: cand.pid, port };
  }
  return null;
}

async function ensureNest(out, instance, { sessionsDir, used, ports, spawned }) {
  const adopted = await tryAdopt(out, instance, 'nest', ports);
  if (adopted) {
    ports.nest = adopted.port;
    return;
  }
  const port = await resolveServicePort(instance, 'nest', {}, used);
  used.add(port);
  const repo = instanceRepoRoot(instance);
  const pid = spawnDetached({
    cmd: 'node',
    args: ['src/pi-nest/src/index.mjs'],
    cwd: repo,
    env: {
      PI_NEST_HOST: '127.0.0.1',
      PI_NEST_PORT: String(port),
      PI_NEST_SESSIONS: sessionsDir,
    },
    logFile: logPath(instance.id, 'nest'),
    pidfile: pidfilePath(instance.id, 'nest'),
    record: { service: 'nest', instance: instance.id, port, sessionsDir },
  });
  spawned.push(pid);
  out.event({
    event: 'starting',
    instance: instance.id,
    service: 'nest',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/nest`)}  starting pid ${pid} :${port}`,
  });
  await waitUntil(async () => (await pingNest(port, 1500)).ok, 10000, `${instance.id}/nest`);
  ports.nest = port;
  out.event({
    event: 'up',
    instance: instance.id,
    service: 'nest',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/nest`)}  ${okSym} ping ok :${port}`,
  });
}

async function ensureGateway(out, instance, { sessionsDir, used, ports, spawned }) {
  const adopted = await tryAdopt(out, instance, 'gateway', ports);
  if (adopted) {
    ports.gateway = adopted.port;
    return;
  }
  const port = await resolveServicePort(instance, 'gateway', {}, used);
  used.add(port);
  const repo = instanceRepoRoot(instance);
  const statesPath = instanceStatesPath(instance);
  const env = {
    PI_STUDIO_HOST: process.env.PI_STUDIO_HOST ?? '127.0.0.1',
    PI_STUDIO_PORT: String(port),
    PI_STUDIO_SESSIONS: sessionsDir,
    PI_NEST_HOST: '127.0.0.1',
    PI_NEST_PORT: String(ports.nest),
    PI_STUDIO_CWD: instance.cwd ?? instance.pairRoot,
  };
  if (statesPath) env.PI_STUDIO_STATES_PATH = statesPath;
  const pid = spawnDetached({
    cmd: 'node',
    args: ['--heapsnapshot-near-heap-limit=2', 'src/pi-studio/server/index.mjs'],
    cwd: repo,
    env,
    logFile: logPath(instance.id, 'gateway'),
    pidfile: pidfilePath(instance.id, 'gateway'),
    record: { service: 'gateway', instance: instance.id, port, sessionsDir },
  });
  spawned.push(pid);
  out.event({
    event: 'starting',
    instance: instance.id,
    service: 'gateway',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/gateway`)}  starting pid ${pid} :${port}`,
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await httpJson(port, '/api/health', 1500);
    if (r.status === 200 && r.json?.ok && r.json.nest) {
      ports.gateway = port;
      out.event({
        event: 'up',
        instance: instance.id,
        service: 'gateway',
        pid,
        port,
        message: `${paint('cyan', `${instance.id}/gateway`)}  ${okSym} /api/health ok, nest:true :${port}`,
      });
      return;
    }
    if (!alive(pid)) break;
    await delay(250);
  }
  throw new CliError(`${instance.id}/gateway not healthy after 10000ms`, 3);
}

async function ensureWeb(out, instance, { used, ports, spawned, opts }) {
  const adopted = await tryAdopt(out, instance, 'web', ports);
  if (adopted) {
    ports.web = adopted.port;
    return;
  }
  const port = await resolveServicePort(instance, 'web', opts, used);
  used.add(port);
  const holderPid = pidHoldingPort(listenPortsByPid(), port);
  if (holderPid) {
    throw new CliError(`web port ${port} is held by foreign pid ${holderPid}`, 4);
  }
  const host = resolveWebHost(instance, opts);
  const repo = instanceRepoRoot(instance);
  const pid = spawnDetached({
    cmd: 'node',
    args: [
      path.join('node_modules', '.bin', 'vite'),
      '--config',
      'vite.config.ts',
      '--host',
      host,
      '--port',
      String(port),
      '--strictPort',
    ],
    cwd: repo,
    env: { PI_API_PROXY: `http://127.0.0.1:${ports.gateway}` },
    logFile: logPath(instance.id, 'web'),
    pidfile: pidfilePath(instance.id, 'web'),
    record: { service: 'web', instance: instance.id, port, host },
  });
  spawned.push(pid);
  out.event({
    event: 'starting',
    instance: instance.id,
    service: 'web',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/web`)}  starting pid ${pid} :${port}`,
  });
  await waitUntil(async () => (await serviceHealth('web', port)).ok, 15000, `${instance.id}/web`);
  ports.web = port;
  out.event({
    event: 'up',
    instance: instance.id,
    service: 'web',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/web`)}  ${okSym} http://127.0.0.1:${port}`,
  });
}

async function assertSessionsDirUnique(instance, sessionsDir) {
  for (const id of listInstances()) {
    if (id === instance.id) continue;
    const other = loadInstance(id);
    if (!other) continue;
    const rec = readPidfile(pidfilePath(id, 'nest'));
    const otherSessions = rec?.sessionsDir ?? instanceSessionsDir(other);
    if (rec && alive(rec.pid) && path.resolve(otherSessions) === path.resolve(sessionsDir)) {
      throw new CliError(
        `sessions dir ${sessionsDir} is already used by live instance '${id}' — refusing to share`,
        1,
      );
    }
  }
}

export async function cmdUp(out, instance, opts = {}) {
  return withLock(instanceStateDir(instance.id), async () => {
    const repo = instanceRepoRoot(instance);
    if (!fs.existsSync(repo)) {
      throw new CliError(`instance ${instance.id}: repo not found at ${repo}`, 1);
    }
    if (!fs.existsSync(path.join(repo, 'node_modules', '.bin', 'vite'))) {
      throw new CliError(
        `instance ${instance.id}: node_modules missing in ${repo} — run npm install (or studio init)`,
        1,
      );
    }
    const sessionsDir = resolveSessionsDir(instance, opts);
    fs.mkdirSync(sessionsDir, { recursive: true });
    await assertSessionsDirUnique(instance, sessionsDir);
    const used = new Set(RESERVED_PORTS);
    for (const p of webPortsInUse(instance.id).keys()) used.add(p);
    const ports = {};
    if (opts.service && !SERVICE_NAMES.includes(opts.service)) {
      throw new CliError(`unknown service '${opts.service}' (nest | gateway | web)`, 2);
    }
    const only = opts.service ?? null;
    const nestRec = readPidfile(pidfilePath(instance.id, 'nest'));
    const gwRec = readPidfile(pidfilePath(instance.id, 'gateway'));
    if (!only || only === 'nest') {
      if (!ports.nest) ports.nest = nestRec?.port ?? instance.nestPort ?? 7495;
    } else {
      ports.nest = Number(
        opts.port?.nest ?? process.env.PI_NEST_PORT ?? instance.nestPort ?? nestRec?.port ?? 7495,
      );
    }
    if (!only || only === 'gateway') {
      if (!ports.gateway) ports.gateway = gwRec?.port ?? instance.gatewayPort;
    } else if (only === 'web') {
      ports.gateway = Number(
        opts.port?.gateway ?? process.env.PI_STUDIO_PORT ?? instance.gatewayPort ?? gwRec?.port ?? 0,
      );
    }
    const spawned = [];
    out.event({ event: 'begin', instance: instance.id });
    try {
      if (!only || only === 'nest' || only === 'gateway') {
        await ensureNest(out, instance, { sessionsDir, used, ports, spawned });
      }
      if (!only || only === 'gateway') {
        await ensureGateway(out, instance, { sessionsDir, used, ports, spawned });
      }
      if (!only || only === 'web') {
        await ensureWeb(out, instance, { used, ports, spawned, opts });
      }
    } catch (e) {
      for (const pid of spawned.reverse()) {
        await terminate(pid, 1500);
      }
      for (const svc of SERVICE_NAMES) clearPidfileIfDead(instance.id, svc);
      throw e;
    }
    out.event({ event: 'done', instance: instance.id, ports });
  });
}

function clearPidfileIfDead(id, service) {
  const file = pidfilePath(id, service);
  const rec = readPidfile(file);
  if (rec && !alive(rec.pid)) clearPidfile(file);
}

export async function nestLivePid(instance) {
  const rec = readPidfile(pidfilePath(instance.id, 'nest'));
  if (rec?.pid && alive(rec.pid)) return rec;
  const attributed = attributeProcesses([instance]);
  const mine = attributed.rows.find((r) => r.instanceId === instance.id && r.service === 'nest');
  if (mine) {
    return { pid: mine.pid, port: mine.ports[0] ?? null, adopted: true };
  }
  return null;
}

export async function guardNest(out, instance, { yes = false, action = 'restart' }) {
  const live = await nestLivePid(instance);
  if (!live) return;
  if (yes) return;
  const repo = instanceRepoRoot(instance);
  const states = live.port ? await listStatesSafe(live.port) : null;
  const busy = (states ?? []).filter((s) => s.status === 'running' || s.queueDepth > 0);
  if (busy.length > 0) {
    for (const s of busy) {
      const dur = s.runningSinceMs > 0 ? formatDuration(Date.now() - s.runningSinceMs) : '';
      out.line(
        `  ${warnSym} ${path.basename(s.agentId)} ${s.status}${dur ? ` ${dur}` : ''} queue=${s.queueDepth}`,
      );
    }
    const okToKill = await confirm(
      `${action} kills ${busy.length} live agent(s) in ${instance.id}. Continue?`,
      false,
    );
    if (!okToKill) throw new CliError('refused: live agents on nest', 5);
  }
  const newest = newestMtime(path.join(repo, 'src', 'pi-nest'));
  const startMs = procStartMs(live.pid);
  if (action === 'restart' && newest > 0 && startMs != null && newest <= startMs) {
    out.line(
      `  ${warnSym} no changes under src/pi-nest since nest started (started ${new Date(startMs).toLocaleString()}, last edit ${new Date(newest).toLocaleString()})`,
    );
    const okAnyway = await confirm(`${action} nest anyway?`, false);
    if (!okAnyway) throw new CliError('refused: nest code unchanged since start', 5);
  }
}

async function stopService(out, instance, service, { immediate = false } = {}) {
  const attributed = attributeProcesses([instance]);
  const status = serviceStatus(instance, service, attributed);
  const targets = status.primary ? [status.primary, ...status.extras] : status.mine;
  if (targets.length === 0) {
    clearPidfile(pidfilePath(instance.id, service));
    out.event({
      event: 'skip',
      instance: instance.id,
      service,
      message: `${paint('cyan', `${instance.id}/${service}`)}  not running`,
    });
    return;
  }
  for (const t of targets) {
    const stopped = await terminate(t.pid, GRACE[service], immediate);
    out.event({
      event: stopped ? 'stopped' : 'failed',
      instance: instance.id,
      service,
      pid: t.pid,
      message: `${paint('cyan', `${instance.id}/${service}`)}  ${stopped ? okSym : errSym} stopped pid ${t.pid}`,
    });
  }
  const file = pidfilePath(instance.id, service);
  const rec = readPidfile(file);
  if (rec?.port) {
    writePidfile(file, { service, instance: instance.id, port: rec.port, stoppedAt: Date.now() });
  } else {
    clearPidfile(file);
  }
}

export async function cmdDown(out, instance, opts = {}) {
  return withLock(instanceStateDir(instance.id), async () => {
    const explicit = opts.service ?? null;
    let targets;
    if (explicit === 'nest') {
      targets = ['nest'];
    } else if (explicit === 'gateway') {
      targets = opts.cascade === false ? ['gateway'] : ['gateway', 'nest'];
    } else if (explicit) {
      targets = [explicit];
    } else {
      targets = ['web', 'gateway', 'nest'];
    }
    if (targets.includes('nest')) {
      await guardNest(out, instance, { yes: opts.yes, action: 'stop' });
    }
    for (const service of ['web', 'gateway', 'nest'].filter((s) => targets.includes(s))) {
      await stopService(out, instance, service, { immediate: opts.force });
    }
  });
}

export async function cmdRestart(out, instance, opts = {}) {
  const service = opts.service;
  if (!service) throw new CliError('restart requires a service: nest | gateway | web', 2);
  if (service === 'nest') {
    await guardNest(out, instance, { yes: opts.yes, action: 'restart' });
    await cmdDown(out, instance, { service, force: opts.force, yes: true });
  } else {
    await cmdDown(out, instance, { service, force: opts.force, cascade: false });
  }
  await cmdUp(out, instance, opts);
}

export async function cmdKill(out, instance, opts = {}) {
  const service = opts.service;
  if (!service) throw new CliError('kill requires a service: nest | gateway | web', 2);
  return withLock(instanceStateDir(instance.id), async () => {
    const targets = service === 'gateway' ? ['gateway', 'nest'] : [service];
    if (targets.includes('nest')) {
      await guardNest(out, instance, { yes: opts.yes, action: 'stop' });
    }
    for (const s of targets) {
      await stopService(out, instance, s, { immediate: true });
    }
  });
}

export async function stackOverview(instance) {
  const attributed = attributeProcesses([instance]);
  const services = {};
  for (const service of SERVICE_NAMES) {
    const status = serviceStatus(instance, service, attributed);
    const health = status.port ? await serviceHealth(service, status.port) : { ok: false };
    let state = status.state;
    if (state === 'up' && !health.ok) state = 'degraded';
    services[service] = {
      state,
      pid: status.pid,
      port: status.port,
      health,
      extras: status.extras.map((e) => e.pid),
    };
  }
  return services;
}

export async function cmdStatus(out, instances) {
  const attributed = attributeProcesses();
  const result = [];
  for (const instance of instances) {
    const services = {};
    for (const service of SERVICE_NAMES) {
      const status = serviceStatus(instance, service, attributed);
      const health = status.port ? await serviceHealth(service, status.port) : { ok: false };
      let state = status.state;
      if (state === 'up' && !health.ok) state = 'degraded';
      let detail = '';
      if (service === 'nest' && state === 'up') {
        const states = await listStatesSafe(status.port);
        if (states) {
          const running = states.filter((s) => s.status === 'running').length;
          detail = `${states.length} agent${states.length === 1 ? '' : 's'}${running ? ` (${running} running)` : ''} ${warnSym} restart is destructive`;
        }
      }
      if (service === 'gateway' && state === 'up' && health.json) {
        const mem = health.json.mem ?? {};
        const parts = [];
        if (mem.rss != null) parts.push(`rss ${formatBytes(mem.rss)}`);
        if (health.json.sseClients != null) parts.push(`${health.json.sseClients} sse`);
        detail = parts.join(' · ');
      }
      if (service === 'web' && state === 'up') {
        detail = `http://${resolveWebHost(instance) === '0.0.0.0' ? '127.0.0.1' : resolveWebHost(instance)}:${status.port}`;
      }
      if (status.extras.length > 0) {
        detail = `${detail}${detail ? ' ' : ''}${warnSym} ${status.extras.length} stray`;
      }
      services[service] = { state, pid: status.pid, port: status.port, detail };
    }
    result.push({ instance, services });
  }
  const orphans = attributed.rows.filter((r) => r.instanceId === null);
  const extraByInstance = {};
  for (const r of attributed.rows) {
    if (!r.instanceId) continue;
    const rec = readPidfile(pidfilePath(r.instanceId, r.service));
    if (rec?.pid !== r.pid) {
      extraByInstance[r.instanceId] = (extraByInstance[r.instanceId] ?? 0) + 1;
    }
  }
  if (out.json) {
    out.raw(
      `${JSON.stringify({
        instances: result.map(({ instance, services }) => ({
          id: instance.id,
          pairRoot: instance.pairRoot,
          branch: instance.branch ?? null,
          services,
        })),
        orphans: orphans.map((o) => ({ pid: o.pid, service: o.service, ports: o.ports, cwd: o.cwd })),
        strays: extraByInstance,
      })}\n`,
    );
    return;
  }
  for (const { instance, services } of result) {
    out.line(paint('bold', `instance ${instance.id}`) + paint('gray', `  ${instance.pairRoot}`));
    for (const service of SERVICE_NAMES) {
      const s = services[service];
      const sym =
        s.state === 'up'
          ? okSym
          : s.state === 'stopped'
            ? paint('gray', '·')
            : s.state === 'degraded'
              ? warnSym
              : warnSym;
      out.line(
        `  ${sym} ${service.padEnd(8)} ${s.state.padEnd(8)} ${s.pid ? `pid ${String(s.pid).padEnd(7)}` : '        '.padEnd(11)} ${s.port ? `:${s.port}` : ''}  ${s.detail}`,
      );
    }
  }
  const strayTotal = Object.values(extraByInstance).reduce((a, b) => a + b, 0);
  if (orphans.length > 0 || strayTotal > 0) {
    out.line('');
    out.line(
      `${warnSym} ${orphans.length} unattributed + ${strayTotal} stray process(es) → studio doctor [--fix]`,
    );
  }
}

export async function cmdAgents(out, instance) {
  const live = await nestLivePid(instance);
  if (!live?.port) throw new CliError(`nest is not running for instance ${instance.id}`, 1);
  const states = await listStatesSafe(live.port);
  if (states == null) throw new CliError(`nest unreachable on :${live.port}`, 1);
  if (out.json) {
    out.raw(`${JSON.stringify({ instance: instance.id, states })}\n`);
    return;
  }
  if (states.length === 0) {
    out.line('no live agents');
    return;
  }
  const rows = states.map((s) => [
    s.agentId,
    s.status || '-',
    String(s.queueDepth),
    s.runningSinceMs > 0 ? formatDuration(Date.now() - s.runningSinceMs) : '',
    s.lastEventAtMs > 0 ? `${formatDuration(Date.now() - s.lastEventAtMs)} ago` : '',
    s.lastError || '',
  ]);
  const { printTable } = await import('./ui.mjs');
  printTable(['AGENT', 'STATUS', 'QUEUE', 'RUNNING', 'LAST EVENT', 'ERROR'], rows);
}

export async function cmdAbort(out, instance, agentId) {
  const live = await nestLivePid(instance);
  if (!live?.port) throw new CliError(`nest is not running for instance ${instance.id}`, 1);
  const client = nestClient(live.port);
  try {
    await client.abort({ agentId });
    out.line(`${okSym} abort sent: ${agentId}`);
  } finally {
    client.close();
  }
}

export async function cmdLogs(out, instance, opts = {}) {
  const services = opts.service ? [opts.service] : SERVICE_NAMES;
  const files = services.map((s) => ({ service: s, file: logPath(instance.id, s) }));
  for (const f of files) {
    if (!fs.existsSync(f.file)) continue;
    const lines = fs.readFileSync(f.file, 'utf8').split('\n').filter(Boolean);
    const n = opts.lines ?? 40;
    const tail = lines.slice(-n);
    for (const line of tail) {
      out.raw(`${services.length > 1 ? paint('gray', `[${f.service}] `) : ''}${line}\n`);
    }
  }
  if (!opts.follow) return;
  const offsets = new Map(
    files.map((f) => [f.service, fs.existsSync(f.file) ? fs.statSync(f.file).size : 0]),
  );
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      for (const f of files) {
        let st;
        try {
          st = fs.statSync(f.file);
        } catch {
          continue;
        }
        const off = offsets.get(f.service) ?? 0;
        if (st.size > off) {
          const fd = fs.openSync(f.file, 'r');
          const buf = Buffer.alloc(st.size - off);
          fs.readSync(fd, buf, 0, buf.length, off);
          fs.closeSync(fd);
          offsets.set(f.service, st.size);
          const text = buf.toString();
          out.raw(
            text
              .split('\n')
              .filter(Boolean)
              .map((l) => `${services.length > 1 ? paint('gray', `[${f.service}] `) : ''}${l}`)
              .join('\n'),
          );
          if (text.endsWith('\n')) out.raw('\n');
        } else if (st.size < off) {
          offsets.set(f.service, 0);
        }
      }
    }, 500);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.on('SIGINT', stop);
  });
}
