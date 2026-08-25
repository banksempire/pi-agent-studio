import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import {
  appendAudit,
  BACKEND_WATCH_PATHS,
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
import { errSym, formatBytes, formatDuration, okSym, paint, printTable, warnSym } from './ui.mjs';

const DRAIN_MS_DEFAULT = 45_000;
const drainGrace = () => Number(process.env.PI_STUDIO_DRAIN_MS ?? DRAIN_MS_DEFAULT) + 20_000;
const GRACE = { web: 5000, backend: drainGrace() };

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function pingBackend(port, timeoutMs = 2000) {
  const r = await httpJson(port, '/api/health', timeoutMs);
  return { ok: r.status === 200 && r.json?.ok === true };
}

export async function listStatesSafe(port) {
  const r = await httpJson(port, '/api/agent-states', 2500);
  return r.status === 200 && Array.isArray(r.json?.states) ? r.json.states : null;
}

export function postJson(port, p, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: p,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(out);
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
    req.end(payload);
  });
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

async function waitUntil(fn, timeoutMs, label, pid = null) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (pid != null && !alive(pid)) {
      throw new CliError(`${label} exited during startup`, 3);
    }
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
  if (process.env.PI_STUDIO_SESSIONS) return path.resolve(process.env.PI_STUDIO_SESSIONS);
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
      let best = null;
      let bestLen = -1;
      for (const inst of listInstances().map((id) => loadInstance(id))) {
        const root = path.resolve(inst?.pairRoot ?? '');
        if (
          root &&
          (proc.cwd === root || proc.cwd.startsWith(`${root}${path.sep}`)) &&
          root.length > bestLen
        ) {
          best = inst;
          bestLen = root.length;
        }
      }
      if (best && insts.some((i) => i.id === best.id)) {
        instanceId = best.id;
        via = 'cwd';
      }
    }
    if (!instanceId) {
      const gwEnv = Number(proc.environ.PI_STUDIO_PORT ?? 0);
      const proxyEnv = portFromProxy(proc.environ);
      for (const inst of insts) {
        const rec = readPidfile(pidfilePath(inst.id, 'backend'));
        const matches =
          proc.service === 'backend' &&
          ((gwEnv && gwEnv === (inst.backendPort ?? rec?.port)) ||
            (proxyEnv && proxyEnv === (inst.backendPort ?? rec?.port)));
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
  const expected = service === 'backend' ? instance.backendPort : instance.webPort;
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
  if (service === 'backend') {
    const r = await httpJson(port, '/api/health');
    return { ok: r.status === 200 && r.json?.ok === true, json: r.json };
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
  if (service === 'backend' && process.env.PI_STUDIO_PORT) return Number(process.env.PI_STUDIO_PORT);
  if (service === 'web' && process.env.PI_STUDIO_WEB_PORT) {
    return Number(process.env.PI_STUDIO_WEB_PORT);
  }
  const pin = service === 'backend' ? instance.backendPort : instance.webPort;
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

async function tryAdopt(out, instance, service) {
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

async function ensureBackend(out, instance, { sessionsDir, used, ports, spawned }) {
  const adopted = await tryAdopt(out, instance, 'backend');
  if (adopted) {
    ports.backend = adopted.port;
    return;
  }
  const port = await resolveServicePort(instance, 'backend', {}, used);
  used.add(port);
  const repo = instanceRepoRoot(instance);
  const statesPath = instanceStatesPath(instance);
  const env = {
    PI_STUDIO_HOST: process.env.PI_STUDIO_HOST ?? '127.0.0.1',
    PI_STUDIO_PORT: String(port),
    PI_STUDIO_SESSIONS: sessionsDir,
    PI_STUDIO_CWD: instance.cwd ?? instance.pairRoot,
    PI_STUDIO_SPILL_PATH: path.join(instanceStateDir(instance.id), 'backend-spill.json'),
    PI_STUDIO_DB_PATH: path.join(instanceStateDir(instance.id), 'studio.db'),
  };
  if (statesPath) env.PI_STUDIO_STATES_PATH = statesPath;
  const pid = spawnDetached({
    cmd: 'node',
    args: ['--heapsnapshot-near-heap-limit=2', 'src/pi-studio/server/index.mjs'],
    cwd: repo,
    env,
    logFile: logPath(instance.id, 'backend'),
    pidfile: pidfilePath(instance.id, 'backend'),
    record: { service: 'backend', instance: instance.id, port, sessionsDir },
  });
  spawned.push(pid);
  out.event({
    event: 'starting',
    instance: instance.id,
    service: 'backend',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/backend`)}  starting pid ${pid} :${port}`,
  });
  await waitUntil(
    async () => (await serviceHealth('backend', port)).ok,
    15000,
    `${instance.id}/backend`,
    pid,
  );
  ports.backend = port;
  out.event({
    event: 'up',
    instance: instance.id,
    service: 'backend',
    pid,
    port,
    message: `${paint('cyan', `${instance.id}/backend`)}  ${okSym} /api/health ok :${port}`,
  });
}

async function ensureWeb(out, instance, { used, ports, spawned, opts }) {
  const adopted = await tryAdopt(out, instance, 'web');
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
  if (!ports.backend) {
    const rec = readPidfile(pidfilePath(instance.id, 'backend'));
    const backendPort = Number(rec?.port ?? process.env.PI_STUDIO_PORT ?? instance.backendPort ?? 0);
    if (!backendPort) {
      throw new CliError(
        `backend port unknown for ${instance.id} — start the pair first: studio up backend`,
        2,
      );
    }
    const health = await serviceHealth('backend', backendPort);
    if (!health.ok) {
      throw new CliError(
        `backend not healthy on :${backendPort} — start the pair first: studio up backend`,
        3,
      );
    }
    ports.backend = backendPort;
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
    env: { PI_API_PROXY: `http://127.0.0.1:${ports.backend}` },
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
  await waitUntil(async () => (await serviceHealth('web', port)).ok, 15000, `${instance.id}/web`, pid);
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
    const rec = readPidfile(pidfilePath(id, 'backend'));
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
      throw new CliError(`unknown service '${opts.service}' (backend | web)`, 2);
    }
    const only = opts.service ?? null;
    const spawned = [];
    out.event({ event: 'begin', instance: instance.id });
    try {
      if (!only || only === 'backend') {
        await ensureBackend(out, instance, { sessionsDir, used, ports, spawned });
      }
      if (!only || only === 'web') {
        await ensureWeb(out, instance, { used, ports, spawned, opts });
      }
    } catch (e) {
      for (const pid of spawned.reverse()) {
        appendAudit(instance.id, {
          action: 'terminate',
          reason: 'up-failure',
          pid,
          caller: process.argv.slice(1).join(' '),
        });
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
  if (rec?.pid != null && !alive(rec.pid)) clearPidfile(file);
}

export function backendLivePid(instance) {
  const rec = readPidfile(pidfilePath(instance.id, 'backend'));
  if (rec?.pid && alive(rec.pid)) return rec;
  const attributed = attributeProcesses([instance]);
  const mine = attributed.rows.find((r) => r.instanceId === instance.id && r.service === 'backend');
  if (mine) {
    return { pid: mine.pid, port: mine.ports[0] ?? null, adopted: true };
  }
  return null;
}

export async function guardBackend(out, instance, { yes = false, action = 'restart' }) {
  const live = await backendLivePid(instance);
  if (!live) return;
  const states = live.port ? await listStatesSafe(live.port) : null;
  const busy = (states ?? []).filter((s) => s.status === 'running' || s.queueDepth > 0);
  if (action === 'restart') {
    const repo = instanceRepoRoot(instance);
    const newest = Math.max(...BACKEND_WATCH_PATHS.map((rel) => newestMtime(path.join(repo, rel))));
    const startMs = procStartMs(live.pid);
    if (newest > 0 && startMs != null && newest <= startMs) {
      if (!yes) {
        out.line(
          `  ${warnSym} no changes under ${BACKEND_WATCH_PATHS.join(' | ')} since backend started (started ${new Date(startMs).toLocaleString()}, last edit ${new Date(newest).toLocaleString()})`,
        );
        throw new CliError('refused: backend code unchanged since start (--yes overrides)', 5);
      }
    }
    if (busy.length > 0) {
      const drainMs = Number(process.env.PI_STUDIO_DRAIN_MS ?? 45_000);
      out.line(
        `  ${warnSym} draining ${busy.length} busy agent(s) before restart (grace ${Math.round(drainMs / 1000)}s; running prompts abort at the deadline and queued ones are spilled and restored)`,
      );
    }
    return;
  }
  if (yes) return;
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
    if (!okToKill) throw new CliError('refused: live agents on backend', 5);
  }
}

async function stopService(out, instance, service, attributed, { immediate = false } = {}) {
  const status = serviceStatus(instance, service, attributed);
  const targets = status.primary ? [status.primary, ...status.extras] : status.mine;
  if (targets.length === 0) {
    const skipFile = pidfilePath(instance.id, service);
    const rec0 = readPidfile(skipFile);
    if (rec0?.port) {
      writePidfile(skipFile, { service, instance: instance.id, port: rec0.port, stoppedAt: Date.now() });
    } else {
      clearPidfile(skipFile);
    }
    out.event({
      event: 'skip',
      instance: instance.id,
      service,
      message: `${paint('cyan', `${instance.id}/${service}`)}  not running`,
    });
    return;
  }
  for (const t of targets) {
    appendAudit(instance.id, {
      action: 'terminate',
      reason: immediate ? 'kill' : 'stop',
      service,
      pid: t.pid,
      caller: process.argv.slice(1).join(' '),
    });
    const stopped = await terminate(t.pid, GRACE[service] ?? 8000, immediate);
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
    if (explicit === 'backend') {
      targets = ['backend'];
    } else if (explicit) {
      targets = [explicit];
    } else {
      targets = ['web', 'backend'];
    }
    if (targets.includes('backend')) {
      await guardBackend(out, instance, { yes: opts.yes, action: 'stop' });
    }
    const attributed = attributeProcesses([instance]);
    for (const service of ['web', 'backend'].filter((s) => targets.includes(s))) {
      await stopService(out, instance, service, attributed, { immediate: opts.force });
    }
  });
}

export async function cmdRestart(out, instance, opts = {}) {
  const service = opts.service;
  if (!service) throw new CliError('restart requires a service: backend | web', 2);
  if (service === 'backend') {
    GRACE.backend = drainGrace();
    await guardBackend(out, instance, { yes: opts.yes, action: 'restart' });
  }
  await cmdDown(out, instance, { service, force: opts.force, cascade: false, yes: true });
  await cmdUp(out, instance, opts);
}

export async function cmdKill(out, instance, opts = {}) {
  const service = opts.service;
  if (!service) throw new CliError('kill requires a service: backend | web', 2);
  return withLock(instanceStateDir(instance.id), async () => {
    const targets = [service];
    if (targets.includes('backend')) {
      await guardBackend(out, instance, { yes: opts.yes, action: 'kill' });
    }
    const attributed = attributeProcesses([instance]);
    for (const s of targets) {
      await stopService(out, instance, s, attributed, { immediate: true });
    }
  });
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
      if (service === 'backend' && state === 'up') {
        const parts = [];
        const states = await listStatesSafe(status.port);
        if (states) {
          const running = states.filter((s) => s.status === 'running').length;
          parts.push(
            `${states.length} agent${states.length === 1 ? '' : 's'}${running ? ` (${running} running)` : ''}`,
          );
        }
        if (health.json) {
          const mem = health.json.mem ?? {};
          if (mem.rss != null) parts.push(`rss ${formatBytes(mem.rss)}`);
          if (health.json.sseClients != null) parts.push(`${health.json.sseClients} sse`);
        }
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
      const sym = s.state === 'up' ? okSym : s.state === 'stopped' ? paint('gray', '·') : warnSym;
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
  const live = await backendLivePid(instance);
  if (!live?.port) throw new CliError(`backend is not running for instance ${instance.id}`, 1);
  const states = await listStatesSafe(live.port);
  if (states == null) throw new CliError(`backend unreachable on :${live.port}`, 1);
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
  printTable(['AGENT', 'STATUS', 'QUEUE', 'RUNNING', 'LAST EVENT', 'ERROR'], rows);
}

export async function cmdAbort(out, instance, agentId) {
  const live = await backendLivePid(instance);
  if (!live?.port) throw new CliError(`backend is not running for instance ${instance.id}`, 1);
  const r = await postJson(live.port, '/api/abort', { file: agentId });
  if (r.status !== 200) throw new CliError(`abort failed (${r.status})`, 1);
  out.line(`${okSym} abort sent: ${agentId}`);
}

export async function cmdLogs(out, instance, opts = {}) {
  const services = opts.service ? [opts.service] : SERVICE_NAMES;
  const files = services.map((s) => ({ service: s, file: logPath(instance.id, s) }));
  const n = opts.lines ?? 40;
  for (const f of files) {
    if (!fs.existsSync(f.file)) continue;
    const lines = fs.readFileSync(f.file, 'utf8').split('\n').filter(Boolean);
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
