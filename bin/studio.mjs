import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMain, instanceForCwd, listInstances, loadInstance } from './lib/instances.mjs';
import { cmdJobs } from './lib/jobs.mjs';
import * as manage from './lib/manage.mjs';
import {
  CliError,
  cmdAbort,
  cmdAgents,
  cmdDown,
  cmdFinishRestart,
  cmdKill,
  cmdLogs,
  cmdRestart,
  cmdStatus,
  cmdUp,
} from './lib/stack.mjs';
import { makeOut } from './lib/ui.mjs';

const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

const USAGE = `studio — manage pi-agent-studio stacks (backend · web)

usage: studio [-i <instance>] <command> [options]

commands:
  up [service]              start the stack (backend → web), health-gated;
                            adopts already-running services
  down [service]            stop the stack; 'down backend' also stops web —
                            the stack is the resource unit (restart backend
                            does not cascade); backend stops gracefully
                            (drains agents, spills queued prompts)
  restart <service>         stop + start one service; restart backend is
                            graceful: in-flight prompts drain (abort at the
                            deadline), queued prompts spill to disk and are
                            restored on boot; refused without --yes when no
                            backend code changed since start
  kill <service> [--force]  hard stop (SIGTERM → short grace → SIGKILL);
                            guarded while agents are live
  status                    stack overview for all instances (or -i <id>)
  logs [service] [-f] [-n N]  tail managed service logs
  agents                    live agents on this instance's backend
  abort <agent-id>          abort one agent
  jobs list                 scheduled jobs on this instance's backend
  jobs add <name> …         add a job (--at <time> | --cron <expr>, --message,
                            --session <file> | --cwd <dir> [--mode new|reuse],
                            --model, --think, --missed coalesce|skip)
  jobs edit <id> …          update a job (--name/--message/--at/--cron/--cwd/…)
  jobs rm <id>              delete a job and its run history
  jobs run <id>             fire a job now (manual run, schedule untouched)
  jobs enable|disable <id>  toggle a job
  jobs runs <id> [-n N]     run history for a job
  doctor [--fix]            diagnostics; --fix clears stale pidfiles + orphans,
                            installs the git guard hooks when missing
  guard [install|status]    install/inspect core.hooksPath on both repos
                            (pre-commit: main-branch rule + biome gate;
                            pre-push: typecheck)
  clean [--snapshots] [--pidfiles] [--instances]
  open                      open this instance's web URL
  init                      register the pair root in cwd as an instance
  worktree add <id> [--from <ref>] [--new]   git worktree pair + init
  worktree rm <id> [--purge]                down + remove worktree pair + instance
  instance ls | show <id> | set <id> k=v | rm <id>

options:
  -i, --instance <id>       select instance (default: detected from cwd, else main)
  --port web=7500           ephemeral port override (web|backend)
  PI_STUDIO_STRICT=1        env flag: up/down/restart/kill refuse to run on
                            defaults — an explicit -i <id> is required
                            (agent/dev-mode guard against touching main
                            by accident)
  --port web=7500           ephemeral port override (web|backend)
  --sessions <dir>          sessions dir override
  --host <host>             web bind host override
  --json                    machine-readable output (ndjson events for up)
  -q, --quiet               suppress human output
  --yes                     skip guard prompts (backend restart/kill)

config precedence: CLI args > environment (PI_STUDIO_*) > instance
config (<pair-root>/.studio/config/instances/) > built-in defaults`;

function parseRest(rest, valueFlags = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if ((t.startsWith('--') || t.startsWith('-')) && t.length > 1 && !/^-\d+$/.test(t)) {
      const body = t.replace(/^--?/, '');
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (valueFlags.includes(body)) {
        if (i + 1 >= rest.length) throw new CliError(`--${body} expects a value`, 2);
        flags[body] = rest[++i];
        continue;
      }
      flags[body] = true;
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

function portSpec(value) {
  const out = {};
  if (!value) return out;
  for (const part of String(value).split(',')) {
    const [k, p] = part.split('=');
    if (k && p && Number.isFinite(Number(p))) out[k.trim()] = Number(p);
  }
  return out;
}

const STRICT = /^(1|true|yes)$/.test(String(process.env.PI_STUDIO_STRICT ?? '').toLowerCase());

function strictRefuse(command) {
  throw new CliError(
    `strict mode is on (PI_STUDIO_STRICT=1): '${command}' needs an explicit target — pass -i <instance>`,
    2,
  );
}

function resolveInstance(id) {
  if (id) {
    const inst = loadInstance(id) ?? (id === 'main' ? ensureMain() : null);
    if (!inst) throw new CliError(`instance '${id}' not found — studio instance ls`, 2);
    return inst;
  }
  const inst = instanceForCwd(process.cwd());
  if (!inst) {
    throw new CliError('no instance for this directory — pass -i <id> or run studio init', 2);
  }
  return inst;
}

async function main() {
  const argv = process.argv.slice(2);
  let instanceId = null;
  let json = false;
  let quiet = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-i' || t === '--instance') instanceId = argv[++i];
    else if (t.startsWith('--instance=')) instanceId = t.slice(11);
    else if (t === '--json') json = true;
    else if (t === '-q' || t === '--quiet') quiet = true;
    else if (t === '-h' || t === '--help' || t === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else if (t === '--version' || t === 'version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    } else rest.push(t);
  }
  if (rest.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return 2;
  }
  const out = makeOut({ json, quiet });
  const command = rest[0];
  const args = rest.slice(1);

  switch (command) {
    case 'up': {
      const { positional, flags } = parseRest(args, ['port', 'sessions', 'host', 'lines']);
      if (STRICT && !instanceId) strictRefuse('up');
      const inst = resolveInstance(instanceId);
      const opts = {
        service: positional[0] ?? null,
        port: portSpec(flags.port),
        sessions: flags.sessions,
        host: flags.host,
        yes: !!flags.yes,
      };
      await cmdUp(out, inst, opts);
      return 0;
    }
    case 'down': {
      const { positional, flags } = parseRest(args, []);
      if (STRICT && !instanceId) strictRefuse('down');
      const inst = resolveInstance(instanceId);
      await cmdDown(out, inst, {
        service: positional[0] ?? null,
        withNest: !!flags['with-nest'],
        force: !!flags.force,
        yes: !!flags.yes,
      });
      return 0;
    }
    case '__finish-restart': {
      const { flags } = parseRest(args, ['old-pid', 'deadline-ms']);
      if (STRICT && !instanceId) strictRefuse('__finish-restart');
      const inst = resolveInstance(instanceId);
      await cmdFinishRestart(inst, {
        oldPid: Number(flags['old-pid'] ?? 0) || 0,
        deadlineMs: Number(flags['deadline-ms'] ?? 0) || 0,
      });
      return 0;
    }
    case 'restart':
    case 'kill': {
      const { positional, flags } = parseRest(args, ['port', 'sessions', 'host']);
      if (STRICT && !instanceId) strictRefuse(command);
      const inst = resolveInstance(instanceId);
      const service = positional[0];
      if (!service) throw new CliError(`${command} requires a service: backend | web`, 2);
      const opts = {
        service,
        force: !!flags.force,
        yes: !!flags.yes,
        port: portSpec(flags.port),
        host: flags.host,
      };
      if (command === 'restart') await cmdRestart(out, inst, opts);
      else await cmdKill(out, inst, opts);
      return 0;
    }
    case 'status': {
      let insts;
      if (instanceId) {
        insts = [resolveInstance(instanceId)];
      } else {
        ensureMain();
        insts = listInstances()
          .map((id) => loadInstance(id))
          .filter(Boolean);
      }
      await cmdStatus(out, insts);
      return 0;
    }
    case 'logs': {
      const { positional, flags } = parseRest(args, ['lines', 'n']);
      const inst = resolveInstance(instanceId);
      await cmdLogs(out, inst, {
        service: positional[0] ?? null,
        follow: !!flags.f || !!flags.follow,
        lines: Number(flags.lines ?? flags.n ?? 40),
      });
      return 0;
    }
    case 'agents': {
      const inst = resolveInstance(instanceId);
      await cmdAgents(out, inst);
      return 0;
    }
    case 'abort': {
      const { positional } = parseRest(args, []);
      const inst = resolveInstance(instanceId);
      if (!positional[0]) throw new CliError('abort requires an agent id', 2);
      await cmdAbort(out, inst, positional[0]);
      return 0;
    }
    case 'jobs': {
      const inst = resolveInstance(instanceId);
      await cmdJobs(out, inst, args);
      return 0;
    }
    case 'guard': {
      const { positional } = parseRest(args, []);
      await manage.cmdGuard(out, { action: positional[0] ?? 'status' });
      return 0;
    }
    case 'doctor': {
      const { flags } = parseRest(args, []);
      const inst = instanceId ? resolveInstance(instanceId) : null;
      await manage.cmdDoctor(out, { instance: inst?.id ?? null, fix: !!flags.fix });
      return process.exitCode ?? 0;
    }
    case 'clean': {
      const { flags } = parseRest(args, []);
      await manage.cmdClean(out, {
        snapshots: !!flags.snapshots,
        pidfiles: !!flags.pidfiles,
        instances: !!flags.instances,
      });
      return 0;
    }
    case 'open': {
      const inst = resolveInstance(instanceId);
      await manage.cmdOpen(out, inst);
      return 0;
    }
    case 'init': {
      const { flags } = parseRest(args, ['pair-root', 'port', 'host', 'sessions', 'id']);
      await manage.cmdInit(out, {
        pairRoot: flags['pair-root'],
        id: flags.id,
        port: portSpec(flags.port),
        host: flags.host,
        sessions: flags.sessions,
        force: !!flags.force,
        noInstall: !!flags['no-install'],
      });
      return 0;
    }
    case 'worktree': {
      const { positional, flags } = parseRest(args, ['from', 'sf-from', 'port', 'host', 'sessions']);
      const sub = positional[0];
      if (sub === 'add') {
        await manage.cmdWorktreeAdd(out, {
          id: positional[1],
          from: flags.from,
          sfFrom: flags['sf-from'],
          newBranch: !!flags.new,
          port: portSpec(flags.port),
          host: flags.host,
          sessions: flags.sessions,
          noInstall: !!flags['no-install'],
        });
        return 0;
      }
      if (sub === 'rm') {
        await manage.cmdWorktreeRm(out, {
          id: positional[1],
          purge: !!flags.purge,
          yes: !!flags.yes,
          force: !!flags.force,
        });
        return 0;
      }
      throw new CliError('usage: studio worktree add|rm …', 2);
    }
    case 'instance': {
      const { positional } = parseRest(args, []);
      const sub = positional[0];
      if (sub === 'ls') {
        await manage.cmdInstanceLs(out);
        return 0;
      }
      if (sub === 'show') {
        if (!positional[1]) throw new CliError('usage: studio instance show <id>', 2);
        await manage.cmdInstanceShow(out, positional[1]);
        return 0;
      }
      if (sub === 'set') {
        if (positional.length < 3) throw new CliError('usage: studio instance set <id> key=value …', 2);
        await manage.cmdInstanceSet(out, positional[1], positional.slice(2));
        return 0;
      }
      if (sub === 'rm') {
        if (!positional[1]) throw new CliError('usage: studio instance rm <id>', 2);
        await manage.cmdInstanceRm(out, positional[1]);
        return 0;
      }
      throw new CliError('usage: studio instance ls|show|set|rm', 2);
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }
}

process.on('SIGINT', () => {
  process.exit(130);
});

main().catch((e) => {
  const code = e instanceof CliError ? e.exitCode : 1;
  process.stderr.write(`\u001b[31merror:\u001b[0m ${e.message}\n`);
  process.exit(code);
});
