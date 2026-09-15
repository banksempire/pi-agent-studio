export const MAX_SPEC_BYTES = 64 * 1024;
export const MAX_NODES = 32;
export const MAX_FANOUT = 16;
export const MAX_TASKS = 16;
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function validateSpec(spec) {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return { ok: false, error: 'spec must be a JSON object' };
  }
  if (spec.nodes === undefined || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    return { ok: false, error: 'spec.nodes must be a non-empty array' };
  }
  if (spec.nodes.length > MAX_NODES) {
    return { ok: false, error: `too many nodes (${spec.nodes.length}); max ${MAX_NODES}` };
  }
  const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim().slice(0, 80) : 'workflow';
  const byId = new Map();
  for (const raw of spec.nodes) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'each node must be a JSON object' };
    }
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
      return { ok: false, error: `invalid node id ${JSON.stringify(raw?.id)} (must match ${ID_RE.source})` };
    }
    if (byId.has(raw.id)) return { ok: false, error: `duplicate node id '${raw.id}'` };
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
      return { ok: false, error: `node '${raw.id}' needs a non-empty prompt` };
    }
    if (raw.model !== undefined && typeof raw.model !== 'string') {
      return { ok: false, error: `node '${raw.id}': model must be a string` };
    }
    if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd.trim())) {
      return { ok: false, error: `node '${raw.id}': cwd must be a non-empty string` };
    }
    if (raw.role !== undefined && typeof raw.role !== 'string') {
      return { ok: false, error: `node '${raw.id}': role must be a string` };
    }
    if (raw.thinking !== undefined && !THINKING_LEVELS.includes(raw.thinking)) {
      return {
        ok: false,
        error: `node '${raw.id}': thinking must be one of ${THINKING_LEVELS.join('|')}`,
      };
    }
    if (raw.onFailure !== undefined && raw.onFailure !== 'fail' && raw.onFailure !== 'continue') {
      return { ok: false, error: `node '${raw.id}': onFailure must be 'fail' or 'continue'` };
    }
    const needs = raw.needs ?? [];
    if (!Array.isArray(needs) || needs.some((n) => typeof n !== 'string')) {
      return { ok: false, error: `node '${raw.id}': needs must be an array of node ids` };
    }
    if (new Set(needs).size !== needs.length) {
      return { ok: false, error: `node '${raw.id}': duplicate entries in needs` };
    }
    if (needs.includes(raw.id)) {
      return { ok: false, error: `node '${raw.id}' cannot need itself` };
    }
    const forEach = raw.forEach ?? null;
    if (forEach !== null && (typeof forEach !== 'string' || !ID_RE.test(forEach))) {
      return { ok: false, error: `node '${raw.id}': forEach must be a node id` };
    }
    if (forEach === raw.id) {
      return { ok: false, error: `node '${raw.id}' cannot forEach itself` };
    }
    byId.set(raw.id, { raw, needs, forEach });
  }
  for (const [id, { needs, forEach }] of byId) {
    for (const need of needs) {
      if (!byId.has(need)) return { ok: false, error: `node '${id}' needs unknown node '${need}'` };
    }
    if (forEach && !byId.has(forEach)) {
      return { ok: false, error: `node '${id}': forEach references unknown node '${forEach}'` };
    }
  }
  for (const [id, { raw, needs, forEach }] of byId) {
    for (const ref of refsOf(raw.prompt)) {
      if (ref === 'item') {
        if (!forEach) return { ok: false, error: `node '${id}': {{item}} used without forEach` };
        continue;
      }
      if (!byId.has(ref)) {
        return { ok: false, error: `node '${id}': prompt references unknown node '{{${ref}}}'` };
      }
      if (!needs.includes(ref)) {
        return { ok: false, error: `node '${id}': references '{{${ref}}}' but does not list it in needs` };
      }
    }
    if (forEach && !needs.includes(forEach)) {
      return { ok: false, error: `node '${id}': forEach '${forEach}' must also be listed in needs` };
    }
  }
  let waves;
  try {
    waves = planWaves(byId);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  if (spec.output !== undefined && (typeof spec.output !== 'string' || !byId.has(spec.output))) {
    return { ok: false, error: `output must be a node id (unknown '${spec.output}')` };
  }
  const output = spec.output ?? waves[waves.length - 1][waves[waves.length - 1].length - 1];
  return {
    ok: true,
    normalized: {
      name,
      output,
      nodes: [...byId.values()].map(({ raw, needs, forEach }) => ({
        id: raw.id,
        prompt: raw.prompt,
        needs,
        forEach,
        model: raw.model ?? null,
        cwd: raw.cwd ?? null,
        role: raw.role ?? null,
        thinking: raw.thinking ?? null,
        onFailure: raw.onFailure ?? 'fail',
      })),
    },
  };
}

function refsOf(prompt) {
  const out = [];
  for (const m of String(prompt).matchAll(REF_RE)) out.push(m[1]);
  return out;
}

function planWaves(byId) {
  const pending = new Map([...byId.keys()].map((id) => [id, byId.get(id).needs.slice()]));
  const settled = new Set();
  const waves = [];
  while (pending.size > 0) {
    const wave = [];
    for (const [id, needs] of pending) {
      if (needs.every((n) => settled.has(n))) wave.push(id);
    }
    if (wave.length === 0) {
      const rest = [...pending.keys()].join(', ');
      throw new Error(`workflow spec has a dependency cycle involving: ${rest}`);
    }
    for (const id of wave) {
      pending.delete(id);
      settled.add(id);
    }
    waves.push(wave);
  }
  return waves;
}

export function wavesFor(normalized) {
  const byId = new Map(normalized.nodes.map((n) => [n.id, { needs: n.needs }]));
  return planWaves(byId);
}

export function splitForEachEntries(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  let entries = null;
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.map((e) => String(e));
    } catch {}
  }
  if (entries === null) {
    entries = raw
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean);
  }
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    const t = e.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= MAX_FANOUT) break;
  }
  return unique;
}

export function interpolatePrompt(template, results) {
  return String(template).replace(REF_RE, (_, refRaw) => {
    const ref = refRaw.trim();
    if (ref === 'item') return '{{item}}';
    const r = results.get(ref);
    if (!r) return `[no result from ${ref}]`;
    return r.text ?? '';
  });
}

export function applyItem(template, item) {
  return String(template).replaceAll('{{item}}', item);
}

export function collectRefs(template, exclude = new Set()) {
  return refsOf(template).filter((r) => r !== 'item' && !exclude.has(r));
}
