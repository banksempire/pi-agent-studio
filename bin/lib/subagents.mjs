import { backendLivePid, CliError, httpJson, postJson } from './stack.mjs';
import { formatBytes, formatDuration, okSym, printTable } from './ui.mjs';

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export async function cmdSubagents(out, instance, args) {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0] ?? 'ls';
  const live = await backendLivePid(instance);
  if (!live?.port) throw new CliError(`backend is not running for instance ${instance.id}`, 1);
  if (sub === 'ls') return ls(out, live.port, flags);
  if (sub === 'gc') return gc(out, live.port, flags);
  throw new CliError(`unknown subagents subcommand '${sub}' (ls | gc)`, 2);
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith('--')) {
      const body = t.slice(2);
      if (['session', 'before'].includes(body)) {
        if (i + 1 >= args.length) throw new CliError(`--${body} expects a value`, 2);
        flags[body] = args[++i];
        continue;
      }
      flags[body] = true;
    } else positional.push(t);
  }
  return { positional, flags };
}

async function ls(out, port, flags) {
  const query = flags.session ? `?session=${encodeURIComponent(flags.session)}` : '';
  const r = await httpJson(port, `/api/subagents${query}`, 5000);
  if (r.status !== 200) throw new CliError(`subagents ls failed (${r.status})`, 1);
  const runs = r.json?.runs ?? [];
  if (out.json) {
    out.raw(`${JSON.stringify({ runs })}\n`);
    return;
  }
  if (runs.length === 0) {
    out.line('no sub-agent runs on disk');
    return;
  }
  const rows = runs.map((run) => [
    run.parent.split('/').pop()?.replace('.jsonl', '').slice(0, 18),
    run.label,
    run.status,
    fmtTs(run.startedAt),
    run.finishedAt ? formatDuration(run.finishedAt - (run.startedAt ?? run.finishedAt)) : '-',
    formatBytes(run.bytes),
    run.error || run.resultPreview.replace(/\s+/g, ' ').slice(0, 48),
  ]);
  printTable(['SESSION', 'RUN', 'STATUS', 'STARTED', 'TOOK', 'SIZE', 'DETAIL'], rows);
}

async function gc(out, port, flags) {
  const body = {
    session: flags.session ?? null,
    before: flags.before ?? null,
    all: !!flags.all,
    dryRun: !!flags['dry-run'],
  };
  const r = await postJson(port, '/api/subagents/gc', body, 30000);
  if (r.status !== 200) throw new CliError(r.json?.error ?? `subagents gc failed (${r.status})`, 1);
  const { removed, bytes, dryRun } = r.json;
  if (out.json) {
    out.raw(`${JSON.stringify(r.json)}\n`);
    return;
  }
  const verb = dryRun ? 'would remove' : 'removed';
  out.line(
    `${okSym} ${verb} ${removed.length} sub-agent run(s), ${formatBytes(bytes)}${dryRun ? ' (dry run)' : ''}`,
  );
  for (const item of removed) {
    out.line(`  ${item.parent.slice(0, 18)}/${item.id}  ${item.label}  ${item.status}`);
  }
}
