const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

const codes = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
  bold: 1,
};

export function paint(color, text) {
  if (!colorEnabled) return `${text}`;
  return `\u001b[${codes[color] ?? 0}m${text}\u001b[0m`;
}

export const okSym = paint('green', '✓');
export const warnSym = paint('yellow', '⚠');
export const errSym = paint('red', '✗');

export function makeOut({ json = false, quiet = false } = {}) {
  return {
    json,
    quiet,
    line(text = '') {
      if (json || quiet) return;
      process.stdout.write(`${text}\n`);
    },
    raw(text = '') {
      process.stdout.write(text);
    },
    event(obj) {
      if (json) {
        process.stdout.write(`${JSON.stringify(obj)}\n`);
        return;
      }
      if (quiet) return;
      if (obj.message) process.stdout.write(`${obj.message}\n`);
    },
    fail(text) {
      process.stderr.write(`${paint('red', `error: ${text}`)}\n`);
    },
  };
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function formatDuration(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => `${r[i] ?? ''}`.length)));
  const fmt = (cells) =>
    cells
      .map((c, i) => `${c ?? ''}`.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  process.stdout.write(`${paint('bold', fmt(headers))}\n`);
  for (const r of rows) process.stdout.write(`${fmt(r)}\n`);
}
