const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DISPLAY = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_DISPLAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Field {
  values: boolean[];
  star: boolean;
}

interface CronParts {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export type CronCheck = { ok: true } | { ok: false; error: string };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function resolveToken(token: string, names: string[] | undefined): number | null {
  const t = token.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  if (!names) return null;
  const i = names.indexOf(t.toLowerCase());
  return i === -1 ? null : i;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: string[],
): { ok: true; field: Field } | { ok: false; error: string } {
  const values = new Array<boolean>(max - min + 1).fill(false);
  let star = false;
  for (const itemRaw of raw.split(',')) {
    const item = itemRaw.trim();
    if (!item) return { ok: false, error: `'${itemRaw}' is empty` };
    const slash = item.indexOf('/');
    const rangePart = slash === -1 ? item : item.slice(0, slash);
    const stepPart = slash === -1 ? '' : item.slice(slash + 1);
    let step = 1;
    if (stepPart !== '') {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) return { ok: false, error: `bad step '/${stepPart}'` };
    }
    let lo: number | null = min;
    let hi: number | null = max;
    if (rangePart !== '*') {
      const dash = rangePart.indexOf('-');
      if (dash === -1) {
        lo = resolveToken(rangePart, names);
        hi = lo;
      } else {
        lo = resolveToken(rangePart.slice(0, dash), names);
        hi = resolveToken(rangePart.slice(dash + 1), names);
      }
      if (lo === null || hi === null || lo < min || hi > max || lo > hi) {
        return { ok: false, error: `'${rangePart}' is not a valid ${min}-${max} value or range` };
      }
    } else if (stepPart === '') {
      star = true;
    }
    for (let v = lo; v <= hi; v += step) values[v - min] = true;
  }
  return { ok: true, field: { values, star } };
}

function parseCron(expr: string): { ok: true; parts: CronParts } | { ok: false; error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: 'expected 5 space-separated fields: min hour day-of-month month day-of-week' };
  }
  const minute = parseField(fields[0], 0, 59);
  if (!minute.ok) return minute;
  const hour = parseField(fields[1], 0, 23);
  if (!hour.ok) return hour;
  const dom = parseField(fields[2], 1, 31);
  if (!dom.ok) return dom;
  const month = parseField(fields[3], 1, 12, MONTH_NAMES);
  if (!month.ok) return month;
  const dow = parseField(fields[4], 0, 7, DOW_NAMES);
  if (!dow.ok) return dow;
  for (let v = 0; v <= 7; v++) if (dow.field.values[v]) dow.field.values[v % 7] = true;
  return {
    ok: true,
    parts: { minute: minute.field, hour: hour.field, dom: dom.field, month: month.field, dow: dow.field },
  };
}

export function checkCron(expr: string): CronCheck {
  const r = parseCron(expr);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

function dayMatches(p: CronParts, d: Date): boolean {
  const domOk = p.dom.values[d.getDate() - 1];
  const dowOk = p.dow.values[d.getDay()];
  if (!p.dom.star && !p.dow.star) return domOk || dowOk;
  return domOk && dowOk;
}

export function nextCronRuns(expr: string, count = 3, from: number = Date.now()): number[] {
  const parsed = parseCron(expr);
  if (!parsed.ok) return [];
  const p = parsed.parts;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const out: number[] = [];
  let guard = 535_000;
  while (out.length < count && guard-- > 0) {
    if (!p.month.values[d.getMonth()] || !dayMatches(p, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (p.hour.values[d.getHours()] && p.minute.values[d.getMinutes()]) out.push(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

function setIndices(values: boolean[], offset = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i]) out.push(i + offset);
  return out;
}

function groups(indices: number[]): Array<[number, number]> {
  const g: Array<[number, number]> = [];
  for (const v of indices) {
    const last = g[g.length - 1];
    if (last && last[1] === v - 1) last[1] = v;
    else g.push([v, v]);
  }
  return g;
}

function formatGroups(g: Array<[number, number]>, fmt: (n: number) => string): string {
  return g.map(([a, b]) => (a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`)).join(', ');
}

export function describeCron(expr: string): string {
  const parsed = parseCron(expr);
  if (!parsed.ok) return '';
  const p = parsed.parts;
  const fields = expr.trim().split(/\s+/);
  const minutes = setIndices(p.minute.values);
  const hours = setIndices(p.hour.values);
  const stepMinuteMatch = fields[0].match(/^\*\/(\d+)$/);

  let time = '';
  if ((p.minute.star && p.hour.star) || (minutes.length === 60 && hours.length === 24)) {
    time = 'Every minute';
  } else if (stepMinuteMatch && hours.length === 24) {
    time = `Every ${stepMinuteMatch[1]} min`;
  } else if (hours.length === 24 && minutes.length === 1) {
    time = `Hourly at :${pad(minutes[0])}`;
  } else if (hours.length === 1 && minutes.length === 1) {
    time = `At ${pad(hours[0])}:${pad(minutes[0])}`;
  }
  if (!time) return '';

  const domDesc = p.dom.star ? '' : formatGroups(groups(setIndices(p.dom.values, 1)), String);
  const dowDesc = p.dow.star
    ? ''
    : formatGroups(groups(setIndices(p.dow.values.slice(0, 7))), (n) => DOW_DISPLAY[n]);
  let days = '';
  if (domDesc && dowDesc) days = ` on day ${domDesc} of the month or ${dowDesc}`;
  else if (domDesc) days = ` on day ${domDesc} of the month`;
  else if (dowDesc) days = ` on ${dowDesc}`;
  const months = p.month.star
    ? ''
    : ` in ${formatGroups(groups(setIndices(p.month.values, 1)), (n) => MONTH_DISPLAY[n - 1])}`;

  return time + days + months;
}
