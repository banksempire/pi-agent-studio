const fs = require('node:fs');

const CGROUP_V2 = '/sys/fs/cgroup/memory.current';
const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V2_STAT = '/sys/fs/cgroup/memory.stat';

function livePids() {
  const out = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    out.push(Number(entry));
  }
  return out;
}

function pidEnvContains(pid, marker) {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    return env.includes(marker);
  } catch {
    return false;
  }
}

function sweepStaleStackProcesses(marker, { label = 'suite' } = {}) {
  const me = process.pid;
  let killed = 0;
  for (const pid of livePids()) {
    if (pid === me) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmdline) continue;
    if (!pidEnvContains(pid, marker) && !cmdline.includes(marker)) continue;
    try {
      process.kill(pid, 0);
      process.kill(pid, 9);
      killed += 1;
    } catch {}
  }
  if (killed > 0) {
    console.log(`  [${label}] swept ${killed} stale process(es) from a previous run`);
  }
  return killed;
}

function cgroupMemory() {
  try {
    const total = Number(fs.readFileSync(CGROUP_V2, 'utf8'));
    const maxRaw = fs.readFileSync(CGROUP_V2_MAX, 'utf8').trim();
    const max = maxRaw === 'max' ? null : Number(maxRaw);
    const stat = {};
    for (const line of fs.readFileSync(CGROUP_V2_STAT, 'utf8').split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) stat[parts[0]] = Number(parts[1]);
    }
    const held = (stat.anon ?? 0) + (stat.kernel ?? 0);
    const reclaimable = Math.max(0, total - held);
    return {
      used: Math.min(held, total),
      total,
      reclaimable,
      max,
      ratio: max ? Math.min(held, total) / max : 0,
    };
  } catch {
    return { used: 0, total: 0, reclaimable: 0, max: null, ratio: 0 };
  }
}

function assertMemoryHeadroom({ threshold = 0.75, label = 'suite' } = {}) {
  const m = cgroupMemory();
  if (m.max && m.ratio > threshold) {
    console.error(
      `[${label}] refusing to start: cgroup held memory at ${(m.ratio * 100).toFixed(0)}% ` +
        `(${(m.used / 1048576).toFixed(0)}MB of ${(m.max / 1048576).toFixed(0)}MB anon+kernel, ` +
        `${(m.reclaimable / 1048576).toFixed(0)}MB auto-reclaimable cache not counted, ` +
        `threshold ${(threshold * 100).toFixed(0)}%). ` +
        `Sweep stale stack processes first (studio doctor --fix) — an OOM kill here takes down the product stacks.`,
    );
    process.exit(3);
  }
  return m;
}

function spawnStackProc(spawn, stamp, cmd, args, opts = {}) {
  return spawn(cmd, args, {
    ...opts,
    env: { ...opts.env, SF_SUITE_STACK_STAMP: stamp },
  });
}

function installStackCleanup({ procs, stamp, browserRef, label = 'suite' }) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      browserRef?.current?.close?.();
    } catch {}
    for (const p of procs) {
      if (!p || p.exitCode !== null) continue;
      try {
        p.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => {
      for (const p of procs) {
        if (!p || p.exitCode !== null) continue;
        try {
          p.kill(9);
        } catch {}
      }
      sweepStaleStackProcesses(stamp, { label });
    }, 1500).unref();
  };
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.on('exit', cleanup);
  return cleanup;
}

module.exports = {
  assertMemoryHeadroom,
  cgroupMemory,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
};
