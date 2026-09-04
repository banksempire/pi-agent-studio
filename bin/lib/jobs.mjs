import http from 'node:http';
import path from 'node:path';
import { pidfilePath } from './instances.mjs';
import { readPidfile } from './proc.mjs';
import { CliError, httpJson, pingBackend, postJson } from './stack.mjs';
import { paint, printTable } from './ui.mjs';

const ADD_USAGE = `usage: studio jobs add <name> [options]

schedule (pick one):
  --at <time>       one-time job — ISO 8601, epoch-ms, or HH:MM (today, or
                    tomorrow if already past; server-local timezone)
  --cron <expr>     periodic job — 5-field cron in server-local time
                    (min hour dom month dow), e.g. "0 3 * * *" = daily 03:00
  --cron <expr> --nonpeak
                    off-peak job — same cadence, but each run waits until the
                    model is outside its peak windows (requires --model)

target (pick one):
  --session <file>  send to an existing session file
  --cwd <dir>       create a fresh session per run (default mode)
  --cwd <dir> --mode reuse   reuse one session per cwd

options:
  -m, --message <text>   message to send (required; "-" reads stdin)
  --model <id>           model preference for new sessions
  --think <level>        thinking level for new sessions
  --missed <policy>      missed periodic runs while backend was down:
                         coalesce (default, run once) | skip
  --by <name>            creator label (default: $USER)
  --disabled             create disabled`;

function requestJson(port, method, p, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { host: '127.0.0.1' };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: p, method, headers }, (res) => {
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
    req.end(payload ?? undefined);
  });
}

function parseAt(value) {
  if (/^\d{12,}$/.test(value)) return Number(value);
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(':').map(Number);
    if (h > 23 || m > 59) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

async function backendPortFor(instance) {
  const rec = readPidfile(pidfilePath(instance.id, 'backend'));
  return Number(rec?.port ?? process.env.PI_STUDIO_PORT ?? instance.backendPort ?? 7494);
}

async function requireBackend(instance) {
  const port = await backendPortFor(instance);
  const ping = await pingBackend(port, 2500);
  if (!ping.ok) {
    throw new CliError(`backend not healthy on :${port} — start the stack first: studio up`, 3);
  }
  return port;
}

function jobFromFlags(positional, flags) {
  const name = positional[0];
  if (!name) throw new CliError(ADD_USAGE, 2);
  const message = flags.m === true || flags.message === true ? null : String(flags.m ?? flags.message ?? '');
  if (message === '-') {
    throw new CliError('reading the message from stdin is not supported here; pass it inline', 2);
  }
  if (!message) throw new CliError(`--message is required\n\n${ADD_USAGE}`, 2);
  const at = flags.at ? parseAt(String(flags.at)) : null;
  if (flags.at && at === null) throw new CliError(`--at: cannot parse '${flags.at}'`, 2);
  const cron = flags.cron ? String(flags.cron) : null;
  if (!at && !cron) throw new CliError(`one of --at or --cron is required\n\n${ADD_USAGE}`, 2);
  const nonpeak = !!flags.nonpeak;
  if (nonpeak && !cron) throw new CliError(`--nonpeak requires --cron\n\n${ADD_USAGE}`, 2);
  if (nonpeak && !flags.model) {
    throw new CliError('--nonpeak requires --model (peak windows are per model)', 2);
  }
  const target = {};
  if (flags.session) target.mode = 'file';
  else if (flags.cwd) target.mode = flags.mode === 'reuse' ? 'reuse' : 'new';
  else throw new CliError(`one of --session or --cwd is required\n\n${ADD_USAGE}`, 2);
  if (flags.session) target.sessionFile = path.resolve(String(flags.session));
  if (flags.cwd) target.cwd = path.resolve(String(flags.cwd));
  return {
    name,
    scheduleType: cron ? (nonpeak ? 'nonpeak' : 'cron') : 'once',
    runAt: cron ? undefined : at,
    cron: cron ?? undefined,
    message,
    targetMode: target.mode,
    sessionFile: target.sessionFile,
    cwd: target.cwd,
    model: flags.model ? String(flags.model) : undefined,
    thinkLevel: flags.think ? String(flags.think) : undefined,
    missedPolicy: flags.missed ? String(flags.missed) : undefined,
    createdBy: flags.by ? String(flags.by) : (process.env.USER ?? 'cli'),
    enabled: flags.disabled ? false : undefined,
  };
}

function describeSchedule(job) {
  if (job.scheduleType === 'nonpeak') return `off-peak cron ${job.cron}`;
  if (job.scheduleType === 'cron') return `cron ${job.cron}`;
  return `once ${new Date(job.runAt).toLocaleString()}`;
}

function describeTarget(job) {
  const t = job.payload?.target ?? {};
  if (t.mode === 'file') return `session ${path.basename(t.sessionFile ?? '')}`;
  return `${t.mode} ${t.cwd ?? ''}`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function fmtRelative(ms, now = Date.now()) {
  if (!ms) return '—';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const human =
    mins < 1
      ? 'now'
      : mins < 60
        ? `${mins}m`
        : mins < 60 * 24
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / (60 * 24))}d`;
  return diff >= 0 ? `in ${human}` : `${human} ago`;
}

function requireId(positional) {
  const id = positional[0];
  if (!id) throw new CliError('job id required', 2);
  return id;
}

function jobUrl(id, suffix = '') {
  return `/api/jobs/${encodeURIComponent(id)}${suffix}`;
}

export async function cmdJobs(out, instance, args) {
  const { positional, flags } = parseJobsArgs(args);
  const sub = positional[0] ?? 'list';
  const rest = positional.slice(1);
  if (sub === 'list' || sub === 'ls') {
    const port = await requireBackend(instance);
    const r = await httpJson(port, '/api/jobs', 5000);
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    const jobs = r.json?.jobs ?? [];
    if (jobs.length === 0) {
      out.line('no scheduled jobs — studio jobs add <name> …');
      return;
    }
    if (out.json) {
      out.event({ jobs });
      return;
    }
    const now = Date.now();
    printTable(
      ['ID', 'NAME', 'SCHEDULE', 'TARGET', 'NEXT RUN', 'LAST', 'ON'],
      jobs.map((j) => [
        j.id,
        j.name,
        describeSchedule(j),
        describeTarget(j),
        j.enabled ? `${fmtTime(j.nextDue)} (${fmtRelative(j.nextDue, now)})` : '—',
        j.lastRun ? j.lastRun.status : '—',
        j.enabled ? 'yes' : 'off',
      ]),
    );
    return;
  }
  if (sub === 'add') {
    const port = await requireBackend(instance);
    const body = jobFromFlags(rest, flags);
    const r = await postJson(port, '/api/jobs', body, 8000);
    if (r.status !== 201) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    const j = r.json.job;
    out.line(`created job ${paint('cyan', j.id)} — ${j.name}`);
    out.line(`  ${describeSchedule(j)} → ${describeTarget(j)}`);
    out.line(`  next run ${fmtTime(j.nextDue)} (${fmtRelative(j.nextDue)})`);
    return;
  }
  if (sub === 'edit') {
    const id = requireId(rest);
    const port = await requireBackend(instance);
    const body = {};
    if (flags.m ?? flags.message) body.message = String(flags.m ?? flags.message);
    if (flags.name) body.name = String(flags.name);
    if (flags.at) {
      const at = parseAt(String(flags.at));
      if (at === null) throw new CliError(`--at: cannot parse '${flags.at}'`, 2);
      body.scheduleType = 'once';
      body.runAt = at;
    }
    if (flags.cron) {
      body.scheduleType = flags.nonpeak ? 'nonpeak' : 'cron';
      body.cron = String(flags.cron);
    }
    if (flags.nonpeak && !flags.cron) {
      if (!flags.model) throw new CliError('--nonpeak requires --model (peak windows are per model)', 2);
      body.scheduleType = 'nonpeak';
    }
    if (flags.anytime) body.scheduleType = 'cron';
    if (flags.session) {
      body.targetMode = 'file';
      body.sessionFile = path.resolve(String(flags.session));
    }
    if (flags.cwd) {
      body.cwd = path.resolve(String(flags.cwd));
      if (flags.mode === 'reuse') body.targetMode = 'reuse';
      else if (flags.mode === 'new' || !flags.session) body.targetMode = 'new';
    }
    if (flags.model !== undefined) body.model = flags.model ? String(flags.model) : null;
    if (flags.think !== undefined) body.thinkLevel = flags.think ? String(flags.think) : null;
    if (flags.missed) body.missedPolicy = String(flags.missed);
    if (Object.keys(body).length === 0) {
      throw new CliError('nothing to edit — pass --name/--message/--at/--cron/--session/--cwd/…', 2);
    }
    const r = await requestJson(port, 'PATCH', jobUrl(id), body);
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    const j = r.json.job;
    out.line(`updated job ${paint('cyan', j.id)} — ${j.name}`);
    out.line(`  ${describeSchedule(j)} → ${describeTarget(j)}`);
    if (j.enabled) out.line(`  next run ${fmtTime(j.nextDue)} (${fmtRelative(j.nextDue)})`);
    return;
  }
  if (sub === 'rm') {
    const id = requireId(rest);
    const port = await requireBackend(instance);
    const r = await requestJson(port, 'DELETE', jobUrl(id));
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    out.line(`deleted job ${id}`);
    return;
  }
  if (sub === 'run') {
    const id = requireId(rest);
    const port = await requireBackend(instance);
    const r = await postJson(port, jobUrl(id, '/run'), {}, 30000);
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    out.line(`job ${id} fired (run #${r.json.runId}) — delivering now`);
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = requireId(rest);
    const port = await requireBackend(instance);
    const r = await requestJson(port, 'PATCH', jobUrl(id), { enabled: sub === 'enable' });
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    const j = r.json.job;
    out.line(`${sub}d job ${paint('cyan', j.id)} — ${j.name}`);
    if (j.enabled) out.line(`  next run ${fmtTime(j.nextDue)} (${fmtRelative(j.nextDue)})`);
    return;
  }
  if (sub === 'runs') {
    const id = requireId(rest);
    const port = await requireBackend(instance);
    const limit = Number(flags.n ?? 20) || 20;
    const r = await httpJson(port, `${jobUrl(id, '/runs')}?limit=${limit}`, 5000);
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    const runs = r.json?.runs ?? [];
    if (runs.length === 0) {
      out.line('no runs yet');
      return;
    }
    if (out.json) {
      out.event({ runs });
      return;
    }
    printTable(
      ['RUN', 'STATUS', 'QUEUED', 'FINISHED', 'SESSION', 'ERROR'],
      runs.map((run) => [
        String(run.id),
        run.status,
        fmtTime(run.queuedAt),
        fmtTime(run.finishedAt),
        run.sessionFile ? path.basename(run.sessionFile) : '—',
        run.error.slice(0, 60),
      ]),
    );
    return;
  }
  if (sub === 'help' || sub === '--help') {
    out.line(ADD_USAGE);
    return;
  }
  throw new CliError(
    `unknown jobs subcommand: ${sub}\nusage: studio jobs list|add|edit|rm|run|enable|disable|runs`,
    2,
  );
}

function parseJobsArgs(rest) {
  const positional = [];
  const flags = {};
  const valueFlags = [
    'at',
    'cron',
    'session',
    'cwd',
    'mode',
    'm',
    'message',
    'model',
    'think',
    'missed',
    'by',
    'name',
    'n',
  ];
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
