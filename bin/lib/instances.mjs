import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SF_ROOT = path.join(path.dirname(PRODUCT_ROOT), 'StudioFramework');
export const RESERVED_PORTS = [7492, 7494];
export const SERVICE_NAMES = ['backend', 'web'];
export const BACKEND_WATCH_PATHS = ['src/pi-nest', 'src/pi-studio/server'];

export function mainPairRoot() {
  return path.dirname(PRODUCT_ROOT);
}

export function configDir() {
  if (process.env.PI_STUDIO_CONFIG_DIR) return process.env.PI_STUDIO_CONFIG_DIR;
  return path.join(mainPairRoot(), '.studio', 'config');
}

export function stateRoot() {
  if (process.env.PI_STUDIO_STATE_DIR) return process.env.PI_STUDIO_STATE_DIR;
  return path.join(mainPairRoot(), '.studio', 'state');
}

export function worktreesRoot() {
  if (process.env.PI_STUDIO_WORKTREES) return process.env.PI_STUDIO_WORKTREES;
  const main = loadInstance('main');
  const pairRoot = main?.pairRoot ?? path.dirname(PRODUCT_ROOT);
  return path.join(pairRoot, '.branch');
}

export function instancesDir() {
  return path.join(configDir(), 'instances');
}

let configMigrated = false;
function maybeMigrateConfig() {
  if (configMigrated) return;
  configMigrated = true;
  if (process.env.PI_STUDIO_CONFIG_DIR) return;
  const legacy = path.join(os.homedir(), '.config', 'pi-agent-studio', 'instances');
  const target = instancesDir();
  try {
    if (!fs.existsSync(legacy) || fs.existsSync(target)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const f of fs.readdirSync(legacy)) {
      if (f.endsWith('.json')) fs.cpSync(path.join(legacy, f), path.join(target, f));
    }
  } catch {}
}

let stateMigrated = false;
function maybeMigrateState() {
  if (stateMigrated) return;
  stateMigrated = true;
  if (process.env.PI_STUDIO_STATE_DIR) return;
  const legacy = path.join(os.homedir(), '.local', 'state', 'pi-agent-studio');
  const target = stateRoot();
  try {
    if (!fs.existsSync(legacy) || fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(legacy, target, { recursive: true });
  } catch {}
}

export function instanceStateDir(id) {
  if (id === 'main') {
    maybeMigrateState();
    return path.join(stateRoot(), 'instances', 'main');
  }
  const inst = loadInstance(id);
  if (inst?.pairRoot) return path.join(inst.pairRoot, '.studio', 'state');
  return path.join(stateRoot(), 'instances', id);
}

export function pidfilePath(id, service) {
  return path.join(instanceStateDir(id), 'pids', `${service}.json`);
}

export function logPath(id, service) {
  return path.join(instanceStateDir(id), 'logs', `${service}.log`);
}

export function auditPath(id) {
  return id ? path.join(instanceStateDir(id), 'audit.log') : path.join(stateRoot(), 'audit.log');
}

export function appendAudit(id, meta) {
  try {
    fs.mkdirSync(path.dirname(auditPath(id)), { recursive: true });
    fs.appendFileSync(auditPath(id), `${JSON.stringify({ ts: new Date().toISOString(), ...meta })}\n`);
  } catch {}
}

export function defaultSessionsDir() {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

export function isMain(instance) {
  return instance?.id === 'main';
}

export function instanceSessionsDir(instance) {
  if (instance.sessionsDir) return instance.sessionsDir;
  if (isMain(instance)) return defaultSessionsDir();
  return path.join(instance.pairRoot, '.studio', 'sessions');
}

export function instanceStatesPath(instance) {
  if (instance.statesPath) return instance.statesPath;
  if (isMain(instance)) return null;
  return path.join(instance.pairRoot, '.studio', 'studio-session-states.json');
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validId(id) {
  return ID_RE.test(id);
}

export function listInstances() {
  maybeMigrateConfig();
  const dir = instancesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter(validId)
    .sort();
}

export function loadInstance(id) {
  maybeMigrateConfig();
  if (!validId(id)) return null;
  const file = path.join(instancesDir(), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rec && rec.backendPort == null && rec.gatewayPort != null) rec.backendPort = rec.gatewayPort;
    return rec;
  } catch {
    return null;
  }
}

export function saveInstance(record) {
  if (!validId(record.id)) throw new Error(`invalid instance id: ${record.id}`);
  fs.mkdirSync(instancesDir(), { recursive: true });
  const file = path.join(instancesDir(), `${record.id}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, `${JSON.stringify({ createdAt: Date.now(), ...prev, ...record }, null, 2)}\n`);
}

export function removeInstance(id) {
  const file = path.join(instancesDir(), `${id}.json`);
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function instanceRepoRoot(instance) {
  return path.join(instance.pairRoot, 'pi-agent-studio');
}

export function ensureMain() {
  const existing = loadInstance('main');
  if (existing) return existing;
  const pairRoot = path.dirname(PRODUCT_ROOT);
  if (!fs.existsSync(path.join(pairRoot, 'pi-agent-studio'))) return null;
  if (!fs.existsSync(path.join(pairRoot, 'StudioFramework'))) return null;
  const gitPath = path.join(pairRoot, 'pi-agent-studio', '.git');
  try {
    if (!fs.statSync(gitPath).isDirectory()) return null;
  } catch {
    return null;
  }
  const record = {
    id: 'main',
    pairRoot,
    branch: 'main',
    webPort: 7492,
    backendPort: 7494,
    host: '0.0.0.0',
    createdAt: Date.now(),
  };
  saveInstance(record);
  return record;
}

export function instanceForCwd(cwd) {
  let bestId = null;
  let bestLen = -1;
  for (const id of listInstances()) {
    const inst = loadInstance(id);
    if (!inst?.pairRoot) continue;
    const root = path.resolve(inst.pairRoot);
    if (cwd === root || cwd.startsWith(`${root}${path.sep}`)) {
      if (root.length > bestLen) {
        bestLen = root.length;
        bestId = id;
      }
    }
  }
  if (bestId) return loadInstance(bestId);
  const productPair = path.dirname(PRODUCT_ROOT);
  if (cwd === productPair || cwd.startsWith(`${productPair}${path.sep}`)) {
    return ensureMain();
  }
  return null;
}

export function webPortsInUse(exceptId) {
  const used = new Map();
  for (const id of listInstances()) {
    const inst = loadInstance(id);
    if (id !== exceptId && inst?.webPort) used.set(inst.webPort, id);
  }
  return used;
}
