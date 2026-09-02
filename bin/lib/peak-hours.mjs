import http from 'node:http';
import { pidfilePath } from './instances.mjs';
import { readPidfile } from './proc.mjs';
import { CliError, httpJson, pingBackend, postJson } from './stack.mjs';
import { paint, printTable } from './ui.mjs';

const ADD_USAGE = `usage: studio peak-hours add [options]

target (pick one):
  --provider <id>            every model of this provider in the live catalog
  --model <provider/model>   one model (or --provider <id> --model <id>)

window:
  --start <HH:MM>            window start on the --offset clock
  --end <HH:MM>              window end on the --offset clock (may wrap midnight)
  --offset <spec>            window timezone: UTC+8 | +8 | -5:30 | minutes
                             (default UTC)
  --weekdays <spec>          days the window applies to: mon-fri | mon,wed,fri |
                             1-5 | sun | weekend | all (default all)
                             — days are counted on the window's own clock, and
                             a window wrapping midnight needs its tail day too

options:
  --note <text>              note (max 200 chars)
  --disabled                 create disabled`;

const RM_USAGE = `usage: studio peak-hours rm <id>
       studio peak-hours rm --key <provider/model>
       studio peak-hours rm --provider <id>`;

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

function parseHm(value, flag) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) throw new CliError(`${flag}: expected HH:MM, got '${value}'`, 2);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new CliError(`${flag}: '${value}' is not a valid time`, 2);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseOffset(value) {
  const v = String(value ?? 'UTC').trim();
  if (/^(utc|z)$/i.test(v)) return 0;
  const m = /^(?:utc)?([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(v);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const h = Number(m[2]);
    const mm = m[3] === undefined ? 0 : Number(m[3]);
    if (h > 12 || mm > 59) return null;
    return sign * (h * 60 + mm);
  }
  if (/^[+-]?\d{1,4}$/.test(v)) return Number(v);
  return null;
}

function offsetLabel(minutes) {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return mm === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(mm).padStart(2, '0')}`;
}

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dowToken(token) {
  const t = String(token ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (/^[0-6]$/.test(t)) return Number(t);
  const name = DOW_NAMES.findIndex((n) => n === t || (t.length > 3 && n.startsWith(t)));
  return name >= 0 ? name : null;
}

function parseWeekdays(spec) {
  const s = String(spec ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === 'all' || s === 'daily' || s === 'everyday') return [0, 1, 2, 3, 4, 5, 6];
  if (s === 'weekend' || s === 'weekends') return [0, 6];
  const out = new Set();
  for (const part of s.split(',')) {
    const range = part.split('-');
    if (range.length === 2) {
      const a = dowToken(range[0]);
      const b = dowToken(range[1]);
      if (a === null || b === null) return null;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let d = lo; d <= hi; d++) out.add(d);
      continue;
    }
    const d = dowToken(part);
    if (d === null) return null;
    out.add(d);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

function weekdaysLabel(days) {
  const wd = [...(days ?? [])].sort((a, b) => a - b);
  if (wd.length === 0) return '—';
  if (wd.length === 7) return 'daily';
  const runs = [];
  let i = 0;
  while (i < wd.length) {
    let j = i;
    while (j + 1 < wd.length && wd[j + 1] === wd[j] + 1) j++;
    runs.push(j > i ? `${DOW_SHORT[wd[i]]}–${DOW_SHORT[wd[j]]}` : DOW_SHORT[wd[i]]);
    i = j + 1;
  }
  return runs.join(',');
}

function windowText(e) {
  return `${e.start} - ${e.end} ${offsetLabel(e.utcOffset)}`;
}

function utcText(e) {
  return `${e.startUtc} - ${e.endUtc} UTC`;
}

async function listEntries(port) {
  const r = await httpJson(port, '/api/peak-hours', 5000);
  if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
  return r.json?.entries ?? [];
}

async function targetsFor(port, flags) {
  const provider = flags.provider === true ? null : flags.provider ? String(flags.provider) : null;
  const model = flags.model === true ? null : flags.model ? String(flags.model) : null;
  if (!provider && !model) throw new CliError(`a target is required\n\n${ADD_USAGE}`, 2);
  if (model?.includes('/')) {
    const sep = model.indexOf('/');
    const mp = model.slice(0, sep);
    if (provider && provider !== mp) {
      throw new CliError(`--model '${model}' does not belong to --provider '${provider}'`, 2);
    }
    return [{ provider: mp, model: model.slice(sep + 1) }];
  }
  if (model && provider) return [{ provider, model }];
  if (model) throw new CliError('--model needs its provider: use <provider/model> or pass --provider', 2);
  const r = await httpJson(port, '/api/models', 8000);
  if (r.status !== 200) {
    throw new CliError(r.json?.error ?? `cannot load the model catalog (backend error ${r.status})`, 1);
  }
  const models = (r.json?.models ?? []).filter((m) => m.provider === provider);
  if (!models.length) throw new CliError(`provider '${provider}' has no models in the catalog`, 2);
  return models.map((m) => ({ provider, model: m.id }));
}

function requireId(rest) {
  const id = rest[0];
  if (!id) throw new CliError('peak-hours entry id required', 2);
  return id;
}

export async function cmdPeakHours(out, instance, args) {
  const { positional, flags } = parsePeakHoursArgs(args);
  const sub = positional[0] ?? 'list';
  const rest = positional.slice(1);

  if (sub === 'list' || sub === 'ls') {
    const port = await requireBackend(instance);
    let entries = await listEntries(port);
    if (flags.provider) entries = entries.filter((e) => e.provider === String(flags.provider));
    if (!entries.length) {
      out.line('no peak-hour windows — studio peak-hours add …');
      return;
    }
    if (out.json) {
      out.event({ entries });
      return;
    }
    printTable(
      ['ID', 'MODEL', 'WINDOW', 'UTC', 'DAYS', 'ON', 'NOTE'],
      entries.map((e) => [
        e.id,
        e.key,
        windowText(e),
        utcText(e),
        weekdaysLabel(e.weekdays),
        e.enabled ? 'yes' : 'off',
        e.note || '—',
      ]),
    );
    return;
  }

  if (sub === 'add') {
    const port = await requireBackend(instance);
    if (flags.start === undefined || flags.end === undefined) {
      throw new CliError(`--start and --end are required\n\n${ADD_USAGE}`, 2);
    }
    const start = parseHm(flags.start, '--start');
    const end = parseHm(flags.end, '--end');
    if (start === end) throw new CliError('--start and --end must differ', 2);
    const offset = parseOffset(flags.offset);
    if (offset === null) {
      throw new CliError(`--offset: cannot parse '${flags.offset}' (use UTC+8, +8, -5:30, or minutes)`, 2);
    }
    if (Math.abs(offset) > 720) throw new CliError('--offset: must stay within ±12 hours', 2);
    let weekdays = [0, 1, 2, 3, 4, 5, 6];
    if (flags.weekdays !== undefined && flags.weekdays !== true) {
      weekdays = parseWeekdays(flags.weekdays);
      if (!weekdays) {
        throw new CliError(
          `--weekdays: cannot parse '${flags.weekdays}' (use mon-fri, mon,wed,fri, 1-5, weekend or all)`,
          2,
        );
      }
    }
    const body = { start, end, utcOffset: offset, weekdays, note: flags.note ? String(flags.note) : '' };
    if (flags.disabled) body.enabled = false;
    const targets = await targetsFor(port, flags);
    const created = [];
    const skipped = [];
    const failed = [];
    for (const t of targets) {
      const r = await postJson(
        port,
        '/api/peak-hours',
        { ...body, provider: t.provider, model: t.model },
        8000,
      );
      const key = `${t.provider}/${t.model}`;
      if (r.status === 201) created.push(key);
      else if (r.status === 400 && /identical/.test(String(r.json?.error ?? ''))) skipped.push(key);
      else failed.push(`${key}: ${r.json?.error ?? `backend error ${r.status}`}`);
    }
    if (out.json) {
      out.event({ created, skipped, failed });
      return;
    }
    for (const k of created)
      out.line(
        `created ${paint('cyan', k)} — ${start} - ${end} ${offsetLabel(offset)} · ${weekdaysLabel(weekdays)}`,
      );
    for (const k of skipped) out.line(`skip     ${k} — identical window already exists`);
    for (const f of failed) out.line(`FAILED   ${f}`);
    out.line(`${created.length} created, ${skipped.length} skipped, ${failed.length} failed`);
    if (failed.length) throw new CliError('some peak-hour windows failed', 1);
    return;
  }

  if (sub === 'rm' || sub === 'delete') {
    const port = await requireBackend(instance);
    const entries = await listEntries(port);
    const id = rest[0];
    let victims;
    if (id && !id.startsWith('-')) {
      victims = entries.filter((e) => e.id === id);
      if (!victims.length) throw new CliError(`no peak-hours entry '${id}'`, 2);
    } else if (flags.key) {
      victims = entries.filter((e) => e.key === String(flags.key));
      if (!victims.length) throw new CliError(`no peak-hours entries for '${flags.key}'`, 2);
    } else if (flags.provider) {
      victims = entries.filter((e) => e.provider === String(flags.provider));
      if (!victims.length) throw new CliError(`no peak-hours entries for provider '${flags.provider}'`, 2);
    } else {
      throw new CliError(RM_USAGE, 2);
    }
    let removed = 0;
    const problems = [];
    for (const v of victims) {
      const r = await requestJson(port, 'DELETE', `/api/peak-hours/${encodeURIComponent(v.id)}`);
      if (r.status === 200) removed += 1;
      else problems.push(`${v.key}: ${r.json?.error ?? `backend error ${r.status}`}`);
    }
    if (out.json) {
      out.event({ removed, problems });
      return;
    }
    for (const p of problems) out.line(`FAILED   ${p}`);
    out.line(`deleted ${removed} window(s)${problems.length ? `, ${problems.length} failed` : ''}`);
    if (problems.length) throw new CliError('some peak-hour windows failed', 1);
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = requireId(rest);
    const port = await requireBackend(instance);
    const r = await requestJson(port, 'PATCH', `/api/peak-hours/${encodeURIComponent(id)}`, {
      enabled: sub === 'enable',
    });
    if (r.status !== 200) throw new CliError(r.json?.error ?? `backend error ${r.status}`, 1);
    const e = r.json.entry;
    out.line(`${sub}d ${paint('cyan', e.key)} — ${windowText(e)}`);
    return;
  }

  if (sub === 'help' || sub === '--help') {
    out.line(ADD_USAGE);
    out.line(RM_USAGE);
    return;
  }
  throw new CliError(
    `unknown peak-hours subcommand: ${sub}\nusage: studio peak-hours list|add|rm|enable|disable`,
    2,
  );
}

function parsePeakHoursArgs(rest) {
  const positional = [];
  const flags = {};
  const valueFlags = ['provider', 'model', 'start', 'end', 'offset', 'weekdays', 'note', 'key'];
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
