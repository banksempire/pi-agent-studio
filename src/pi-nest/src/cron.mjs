const FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_NAMES = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function tokenToNumber(token, fieldIndex) {
  const n = Number(token);
  if (Number.isInteger(n)) return n;
  const lower = token.toLowerCase();
  if (fieldIndex === 4 && lower in DOW_NAMES) return DOW_NAMES[lower];
  if (fieldIndex === 3 && lower in MONTH_NAMES) return MONTH_NAMES[lower];
  return null;
}

function expandToken(token, fieldIndex) {
  const { min, max } = FIELD_RANGES[fieldIndex];
  const slash = token.indexOf('/');
  const range = slash >= 0 ? token.slice(0, slash) : token;
  const step = slash >= 0 ? Number(token.slice(slash + 1)) : 1;
  if (slash >= 0 && (!Number.isInteger(step) || step < 1)) return null;
  let lo = min;
  let hi = max;
  let star = false;
  if (range === '*') {
    star = true;
  } else if (range.includes('-')) {
    const [a, b] = range.split('-');
    lo = tokenToNumber(a, fieldIndex);
    hi = tokenToNumber(b, fieldIndex);
    if (lo === null || hi === null || lo > hi) return null;
  } else {
    const v = tokenToNumber(range, fieldIndex);
    if (v === null) return null;
    if (slash >= 0) {
      lo = v;
    } else {
      lo = v;
      hi = v;
    }
  }
  const out = new Set();
  for (let v = lo; v <= hi; v += step) {
    let norm = v;
    if (fieldIndex === 4 && norm === 7) norm = 0;
    if (norm < min || norm > max) continue;
    out.add(norm);
  }
  if (out.size === 0) return null;
  return { values: out, star: star && slash < 0 };
}

export function parseCron(expr) {
  if (typeof expr !== 'string') return { error: 'cron expression must be a string' };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    return { error: 'cron expression must have exactly 5 fields (min hour dom month dow)' };
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const values = new Set();
    let star = true;
    for (const token of parts[i].split(',')) {
      if (!token) return { error: `field ${i + 1}: empty token` };
      const r = expandToken(token, i);
      if (!r) return { error: `field ${i + 1}: invalid token '${token}'` };
      if (!r.star) star = false;
      for (const v of r.values) values.add(v);
    }
    fields.push({ values, star });
  }
  const [minutes, hours, doms, months, dows] = fields;
  return { minutes, hours, doms, months, dows };
}

export function cronError(expr) {
  const r = parseCron(expr);
  return r.error ?? null;
}

function dayMatches(c, day, dow) {
  const domOk = c.doms.values.has(day);
  const dowOk = c.dows.values.has(dow);
  if (!c.doms.star && !c.dows.star) return domOk || dowOk;
  return domOk && dowOk;
}

export function cronMatches(expr, date) {
  const c = parseCron(expr);
  if (c.error) return false;
  if (!c.months.values.has(date.getMonth() + 1)) return false;
  if (!dayMatches(c, date.getDate(), date.getDay())) return false;
  if (!c.hours.values.has(date.getHours())) return false;
  return c.minutes.values.has(date.getMinutes());
}

export function nextCronTime(expr, afterMs) {
  const c = parseCron(expr);
  if (c.error) return null;
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = d.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (!c.months.values.has(d.getMonth() + 1)) {
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      d.setMonth(d.getMonth() + 1);
      continue;
    }
    if (!dayMatches(c, d.getDate(), d.getDay())) {
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      continue;
    }
    if (!c.hours.values.has(d.getHours())) {
      d.setMinutes(0);
      d.setHours(d.getHours() + 1);
      continue;
    }
    if (!c.minutes.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d.getTime();
  }
  return null;
}

export function countCronMatches(expr, fromMs, toMs) {
  const c = parseCron(expr);
  if (c.error) return 0;
  let count = 0;
  let t = nextCronTime(expr, fromMs);
  while (t !== null && t <= toMs) {
    count += 1;
    t = nextCronTime(expr, t);
  }
  return count;
}

export function describeCron(expr) {
  return expr;
}
