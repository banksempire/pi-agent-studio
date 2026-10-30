import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { errSym, warnSym } from './ui.mjs';

export function forceRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    if (!fs.existsSync(p)) return;
  } catch {}
  const stack = [p];
  while (stack.length) {
    const dir = stack.pop();
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else {
        try {
          fs.rmSync(full, { force: true });
        } catch {}
      }
    }
  }
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

export function modulesStats(root) {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) stack.push(path.join(dir, ent.name));
      else {
        files += 1;
        try {
          bytes += fs.lstatSync(path.join(dir, ent.name)).size;
        } catch {}
      }
    }
  }
  return { files, bytes };
}

export function modulesComplete(src, dst) {
  try {
    if (!fs.existsSync(dst)) return false;
    const a = modulesStats(src);
    const b = modulesStats(dst);
    return a.files > 0 && a.files === b.files && a.bytes === b.bytes;
  } catch {
    return false;
  }
}

function copyTreeJs(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTreeJs(s, d);
    else if (ent.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

function privatizeHiddenLockfile(dst) {
  const lock = path.join(dst, '.package-lock.json');
  if (!fs.existsSync(lock)) return;
  const tmp = `${lock}.private-${process.pid}`;
  try {
    fs.copyFileSync(lock, tmp);
    fs.renameSync(tmp, lock);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

export function copyModulesFrom(srcRepo, dstRepo, out = null) {
  const src = path.join(srcRepo, 'node_modules');
  const dst = path.join(dstRepo, 'node_modules');
  if (!fs.existsSync(src)) return 'skipped';
  if (fs.existsSync(dst)) {
    if (modulesComplete(src, dst)) {
      privatizeHiddenLockfile(dst);
      return 'skipped';
    }
    out?.line(`${warnSym} incomplete node_modules at ${dst} — recopying`);
    forceRm(dst);
  }
  const attempts = [
    () => {
      try {
        execFileSync('cp', ['-al', src, dst], { stdio: 'ignore' });
      } catch {}
    },
    () => {
      try {
        fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      } catch {}
    },
    () => copyTreeJs(src, dst),
  ];
  let ok = false;
  for (const attempt of attempts) {
    forceRm(dst);
    try {
      attempt();
    } catch {}
    ok = modulesComplete(src, dst);
    if (ok) break;
  }
  if (!ok) {
    forceRm(dst);
    out?.line(
      `${errSym} node_modules copy from ${src} did not complete — run npm install in ${dstRepo} before 'up'`,
    );
    return 'failed';
  }
  privatizeHiddenLockfile(dst);
  return 'copied';
}
