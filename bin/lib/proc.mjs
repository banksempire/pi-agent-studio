import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function alive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
  } catch (e) {
    return e?.code === 'EPERM';
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0];
    return state !== 'Z';
  } catch {
    return true;
  }
}

export function readPidfile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writePidfile(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

export function clearPidfile(file) {
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function readCmdline(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
  return raw.toString().split('\0').filter(Boolean);
}

export function readEnviron(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/environ`);
  const out = {};
  for (const entry of raw.toString().split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

export function procCwd(pid) {
  return fs.realpathSync(`/proc/${pid}/cwd`);
}

let bootTimeMsCache = null;
function bootTimeMs() {
  if (bootTimeMsCache != null) return bootTimeMsCache;
  for (const line of fs.readFileSync('/proc/stat', 'utf8').split('\n')) {
    const m = line.match(/^btime (\d+)$/);
    if (m) {
      bootTimeMsCache = Number(m[1]) * 1000;
      break;
    }
  }
  return bootTimeMsCache ?? 0;
}

export function procStartMs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2);
    const parts = tail.split(/\s+/);
    const starttime = Number(parts[19]);
    return bootTimeMs() + (starttime * 1000) / 100;
  } catch {
    return null;
  }
}

function viteArgMatches(arg) {
  return (
    arg === 'vite' ||
    arg.endsWith('/.bin/vite') ||
    arg.endsWith('/vite/bin/vite.js') ||
    arg === '.bin/vite' ||
    /pi-agent-studio\/node_modules\/.bin\/vite$/.test(arg)
  );
}

function viteConfigMatches(arg) {
  return arg === 'vite.config.ts' || /(^|\/)pi-agent-studio\/vite\.config\.ts$/.test(arg);
}

export function serviceOfCmdline(argv, cwd = null) {
  if (argv.some((a) => a.endsWith('pi-nest/src/index.mjs'))) return 'backend';
  if (argv.some((a) => a.endsWith('src/pi-studio/server/index.mjs'))) return 'backend';
  if (argv.some(viteArgMatches) && argv.some(viteConfigMatches)) {
    if (cwd && path.basename(cwd) === 'pi-agent-studio') return 'web';
    if (cwd && /(^|\/)pi-agent-studio$/.test(path.dirname(cwd))) return 'web';
    if (argv.some((a) => /pi-agent-studio\/(vite\.config\.ts|node_modules)/.test(a))) return 'web';
  }
  return null;
}

export function listServiceProcesses() {
  const out = [];
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const pidDir of pids) {
    const pid = Number(pidDir);
    if (pid === process.pid) continue;
    let argv;
    try {
      argv = readCmdline(pidDir);
    } catch {
      continue;
    }
    if (argv.length < 2) continue;
    let cwd = null;
    try {
      cwd = procCwd(pidDir);
    } catch {}
    const service = serviceOfCmdline(argv, cwd);
    if (!service) continue;
    let environ = {};
    try {
      environ = readEnviron(pidDir);
    } catch {}
    out.push({ pid, service, argv, cwd, environ });
  }
  return out;
}

export function listenPortsByPid() {
  const inodePort = new Map();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '0A') continue;
      const port = Number.parseInt(cols[1].split(':')[1], 16);
      if (Number.isFinite(port)) inodePort.set(cols[9], port);
    }
  }
  const byPid = new Map();
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return byPid;
  }
  for (const pidDir of pids) {
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pidDir}/fd`);
    } catch {
      continue;
    }
    const ports = new Set();
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync(`/proc/${pidDir}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && inodePort.has(m[1])) ports.add(inodePort.get(m[1]));
    }
    if (ports.size > 0) byPid.set(Number(pidDir), ports);
  }
  return byPid;
}

export async function pickFreePort(host = '127.0.0.1', avoid = new Set(), tries = 64) {
  for (let i = 0; i < tries; i++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, host, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    if (!avoid.has(port)) return port;
  }
  throw new Error('no free port found');
}

export function pidHoldingPort(listeners, port) {
  for (const [pid, ports] of listeners) {
    if (ports.has(Number(port))) return pid;
  }
  return null;
}

export function spawnDetached({ cmd, args, cwd, env = {}, logFile, pidfile, record }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  writePidfile(pidfile, {
    pid: child.pid,
    pgid: child.pid,
    startedAt: Date.now(),
    argv: [cmd, ...args],
    cwd,
    ...record,
  });
  return child.pid;
}

export async function terminate(pid, graceMs = 8000, immediate = false) {
  if (!alive(pid)) return true;
  const killGroup = (sig) => {
    try {
      process.kill(-Number(pid), sig);
      return;
    } catch {
      try {
        process.kill(Number(pid), sig);
      } catch {}
    }
  };
  killGroup('SIGTERM');
  const grace = immediate ? 400 : graceMs;
  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(120);
  }
  killGroup('SIGKILL');
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return true;
    await delay(100);
  }
  return !alive(pid);
}

export function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const base = path.basename(cur);
      if (base === 'node_modules' || base === '.git' || base === 'dist') continue;
      let entries;
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

const BROWSER_ORPHAN_NAMES = new Set([
  'headless_shell',
  'headless_shell_old',
  'chromium',
  'chrome',
  'chrome_crashpad_handler',
]);

export function listOrphanBrowserProcesses() {
  const out = [];
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  for (const pidDir of pids) {
    const pid = Number(pidDir);
    if (pid === process.pid) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pidDir}/stat`, 'utf8');
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const parts = stat.slice(close + 2).split(' ');
    const state = parts[0];
    const ppid = Number(parts[1]);
    if (state === 'Z' || ppid !== 1) continue;
    let name = '';
    try {
      name = fs.readFileSync(`/proc/${pidDir}/comm`, 'utf8').trim();
    } catch {}
    if (!BROWSER_ORPHAN_NAMES.has(name)) {
      try {
        name = path.basename(readCmdline(pidDir)[0] ?? '');
      } catch {
        continue;
      }
      if (!BROWSER_ORPHAN_NAMES.has(name)) continue;
    }
    out.push({ pid, name, state, ppid });
  }
  return out;
}

export async function withLock(dir, fn) {
  const lockDir = path.join(dir, 'lock');
  fs.mkdirSync(dir, { recursive: true });
  const holder = path.join(lockDir, 'pid');
  if (fs.existsSync(lockDir)) {
    const held = Number(readPidfile(holder)?.pid ?? 0);
    if (held && alive(held) && held !== process.pid) {
      throw new Error(`another studio command is running for this instance (pid ${held})`);
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  fs.mkdirSync(lockDir);
  writePidfile(holder, { pid: process.pid, startedAt: Date.now() });
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  }
}
