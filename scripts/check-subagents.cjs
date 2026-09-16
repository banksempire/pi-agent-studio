const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const NEST = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-'));
const SESSIONS_ROOT = path.join(TMP, 'sessions');
const STUB_STATE_DIR = path.join(TMP, 'stub-state');
const DB_PATH = path.join(TMP, 'studio.db');

process.env.PI_SDK_DIR = STUB_SDK;
process.env.PI_STUDIO_SESSIONS = SESSIONS_ROOT;
process.env.STUB_STATE_DIR = STUB_STATE_DIR;

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', reject);
  });
}

function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(out) });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function appendChildRule(rule) {
  fs.mkdirSync(STUB_STATE_DIR, { recursive: true });
  fs.appendFileSync(path.join(STUB_STATE_DIR, 'subagent-script.jsonl'), `${JSON.stringify(rule)}\n`);
}

function childPrompts() {
  const file = path.join(STUB_STATE_DIR, 'subagent-prompts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function subagentDirs(parent) {
  const dir = path.join(SESSIONS_ROOT, '_subagents', parent);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((e) => fs.existsSync(path.join(dir, e, 'result.json')));
}

function existsSyncSafe(parent, childId) {
  return fs.existsSync(path.join(SESSIONS_ROOT, '_subagents', parent, childId, 'result.json'));
}

function readChildResults(parent) {
  const dir = path.join(SESSIONS_ROOT, '_subagents', parent);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir)) {
    const f = path.join(dir, e, 'result.json');
    if (!fs.existsSync(f)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch {}
  }
  return out;
}

async function engineTests() {
  console.log('workflow engine (pure)');
  const engine = await import(pathToFileURL(path.join(NEST, 'workflow-engine.mjs')).href);
  const good = {
    name: 't',
    nodes: [
      { id: 'a', prompt: 'do a', model: 'stub-pro', thinking: 'off' },
      { id: 'b', needs: ['a'], prompt: 'use {{a}}', model: 'stub-pro', thinking: 'off' },
      { id: 'c', needs: ['a'], prompt: 'also {{a}}', model: 'stub-pro', thinking: 'off' },
      { id: 'd', needs: ['b', 'c'], prompt: 'final {{b}} {{c}}', model: 'stub-pro', thinking: 'off' },
    ],
  };
  const v = engine.validateSpec(good);
  report('valid spec accepted', v.ok, v.error ?? '');
  if (v.ok) {
    const waves = engine.wavesFor(v.normalized);
    report(
      'waves respect needs',
      JSON.stringify(waves) === JSON.stringify([['a'], ['b', 'c'], ['d']]),
      JSON.stringify(waves),
    );
    report('output defaults to final node', v.normalized.output === 'd', v.normalized.output);
  }
  const cases = [
    [
      'duplicate id',
      {
        nodes: [
          { id: 'a', prompt: 'x', model: 'm', thinking: 'off' },
          { id: 'a', prompt: 'y', model: 'm', thinking: 'off' },
        ],
      },
      'duplicate',
    ],
    [
      'unknown need',
      { nodes: [{ id: 'a', prompt: 'x', needs: ['zz'], model: 'm', thinking: 'off' }] },
      "unknown node 'zz'",
    ],
    [
      'cycle',
      {
        nodes: [
          { id: 'a', prompt: 'x', needs: ['b'], model: 'm', thinking: 'off' },
          { id: 'b', prompt: 'y', needs: ['a'], model: 'm', thinking: 'off' },
        ],
      },
      'cycle',
    ],
    [
      'unknown ref',
      { nodes: [{ id: 'a', prompt: 'see {{ghost}}', model: 'm', thinking: 'off' }] },
      "unknown node '{{ghost}}'",
    ],
    [
      'ref without needs',
      {
        nodes: [
          { id: 'a', prompt: 'x', model: 'm', thinking: 'off' },
          { id: 'b', prompt: 'use {{a}}', model: 'm', thinking: 'off' },
        ],
      },
      'does not list it in needs',
    ],
    [
      'item without forEach',
      { nodes: [{ id: 'a', prompt: 'item {{item}}', model: 'm', thinking: 'off' }] },
      'without forEach',
    ],
    [
      'forEach not in needs',
      {
        nodes: [
          { id: 'a', prompt: 'x', model: 'm', thinking: 'off' },
          { id: 'b', forEach: 'a', prompt: 'go {{item}}', model: 'm', thinking: 'off' },
        ],
      },
      'must also be listed in needs',
    ],
    [
      'bad output',
      { nodes: [{ id: 'a', prompt: 'x', model: 'm', thinking: 'off' }], output: 'zz' },
      'unknown',
    ],
    [
      'self need',
      { nodes: [{ id: 'a', prompt: 'x', needs: ['a'], model: 'm', thinking: 'off' }] },
      'cannot need itself',
    ],
    [
      'bad thinking level',
      { nodes: [{ id: 'a', prompt: 'x', model: 'm', thinking: 'banana' }] },
      'thinking must be one of',
    ],
    ['missing model', { nodes: [{ id: 'a', prompt: 'x', thinking: 'off' }] }, 'model is required'],
    ['missing thinking', { nodes: [{ id: 'a', prompt: 'x', model: 'm' }] }, 'thinking is required'],
  ];
  for (const [name, spec, expect] of cases) {
    const r = engine.validateSpec(spec);
    report(`rejects: ${name}`, !r.ok && r.error.includes(expect), r.error ?? 'accepted');
  }
  const vThink = engine.validateSpec({ nodes: [{ id: 'a', prompt: 'x', model: 'm', thinking: 'high' }] });
  report(
    'thinking level normalized to node',
    vThink.ok && vThink.normalized.nodes[0].thinking === 'high',
    JSON.stringify(vThink.normalized?.nodes?.[0]?.thinking),
  );
  const vPlain = engine.validateSpec({ nodes: [{ id: 'a', prompt: 'x' }] });
  report(
    'bare node rejected: no defaults',
    !vPlain.ok && vPlain.error.includes('model is required'),
    vPlain.error ?? 'accepted',
  );
  const split = engine.splitForEachEntries('a.ts\n- b.ts\n2. c.ts\n\na.ts');
  report(
    'forEach split: lines, markers, dedupe',
    JSON.stringify(split) === JSON.stringify(['a.ts', 'b.ts', 'c.ts']),
    JSON.stringify(split),
  );
  const splitJson = engine.splitForEachEntries('["x","y"]');
  report(
    'forEach split: json array',
    JSON.stringify(splitJson) === JSON.stringify(['x', 'y']),
    JSON.stringify(splitJson),
  );
  const long = engine.splitForEachEntries(Array.from({ length: 30 }, (_, i) => `n${i}`).join('\n'));
  report('forEach split: capped at 16', long.length === 16, String(long.length));

  const results = new Map([['a', { status: 'completed', text: 'RESULT-A' }]]);
  report(
    'interpolation replaces refs',
    engine.interpolatePrompt('before {{a}} after', results) === 'before RESULT-A after',
  );
  report(
    'interpolation keeps {{item}} for later',
    engine.interpolatePrompt('item {{item}} ref {{a}}', results) === 'item {{item}} ref RESULT-A',
  );
  report(
    'missing ref yields placeholder',
    engine.interpolatePrompt('{{zz}}', results) === '[no result from zz]',
  );
  report('applyItem', engine.applyItem('audit {{item}} now', 'f.ts') === 'audit f.ts now');

  const { finalAnswerFromTurns } = await import(pathToFileURL(path.join(NEST, 'subagents.mjs')).href);
  const fa = finalAnswerFromTurns([
    { text: 'thinking out loud', hasToolCalls: false },
    { text: '', hasToolCalls: true },
    { text: 'partial', hasToolCalls: false },
    { text: 'final answer', hasToolCalls: false },
  ]);
  report('final answer = text after last tool call', fa === 'partial\nfinal answer', JSON.stringify(fa));
  const faNoTools = finalAnswerFromTurns([{ text: 'direct', hasToolCalls: false }]);
  report('final answer without tool calls', faNoTools === 'direct');
  const faEmpty = finalAnswerFromTurns([{ text: '', hasToolCalls: true }]);
  report('empty after tool call -> empty', faEmpty === '');

  const { createAnswerCollector } = await import(pathToFileURL(path.join(NEST, 'subagents.mjs')).href);
  const coll = createAnswerCollector();
  coll.push({ role: 'assistant', content: [{ type: 'text', text: 'pre-tool thinking' }] });
  coll.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] });
  coll.push({ role: 'assistant', content: [{ type: 'text', text: 'post-tool' }] });
  report('collector drops pre-tool-call text', coll.answer() === 'post-tool', JSON.stringify(coll.answer()));
  coll.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: {} }] });
  coll.push({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] });
  report('collector resets on every tool call', coll.answer() === 'recovered');
  coll.push({ role: 'user', content: [{ type: 'text', text: 'ignore me' }] });
  report('collector ignores non-assistant messages', coll.answer() === 'recovered');
}

async function managerTests() {
  console.log('sub-agent manager (stub sdk)');
  const { createSubagentManager, SUBAGENTS_DIRNAME } = await import(
    pathToFileURL(path.join(NEST, 'subagents.mjs')).href
  );
  const stub = await import(pathToFileURL(path.join(STUB_SDK, 'dist', 'index.js')).href);
  report('SUBAGENTS_DIRNAME', SUBAGENTS_DIRNAME === '_subagents');

  const parent = 'parent-1.jsonl';
  const parentId = path.join(SESSIONS_ROOT, '--tmp--', parent);
  const parentSession = {
    model: stub.STUB_RUNTIME_MODELS[0],
    thinkingLevel: 'off',
    modelRuntime: {
      getAvailableSnapshot: () => stub.STUB_RUNTIME_MODELS,
      getAvailable: async () => stub.STUB_RUNTIME_MODELS,
    },
    sessionManager: { getCwd: () => TMP },
  };
  const manager = createSubagentManager({
    sessionsRoot: SESSIONS_ROOT,
    getSession: (id) => (id === parentId ? parentSession : null),
    limits: { globalMax: 4, providerMax: 4, modelMax: 2 },
  });

  const tools = manager.toolsFor(parentId);
  report('tools: subagent + workflow registered', tools.map((t) => t.name).join(',') === 'subagent,workflow');

  appendChildRule({ match: 'list the routes', reply: 'src/a.ts\nsrc/b.ts' });
  const runs = await manager.runTasks(parentId, [
    { prompt: 'list the routes' },
    { prompt: 'audit the config file' },
  ]);
  report(
    'both tasks completed',
    runs.every((r) => r.status === 'completed'),
    JSON.stringify(runs.map((r) => [r.label, r.status, r.error])),
  );
  report('task result = stub reply', runs[1].result === 'stub sub-agent result: audit the config file');
  const dirs = subagentDirs('parent-1');
  report('result.json written per child', dirs.length === 2, String(dirs.length));
  const transcriptOk = dirs.every((d) =>
    fs.existsSync(path.join(SESSIONS_ROOT, '_subagents', 'parent-1', d, 'transcript.jsonl')),
  );
  report('transcript.jsonl written per child', transcriptOk);
  const listed = manager.list({});
  report('list() finds runs', listed.length === 2, String(listed.length));
  report(
    'list() status completed',
    listed.every((r) => r.status === 'completed'),
  );

  appendChildRule({ match: 'repair me', behavior: 'tool-then-empty' });
  const [repairRun] = await manager.runTasks(parentId, [{ prompt: 'repair me' }]);
  report(
    'repair re-prompt recovers result',
    repairRun.status === 'completed' && repairRun.result.startsWith('stub sub-agent result'),
    `${repairRun.status}:${repairRun.error}`,
  );
  const repairChildPrompts = childPrompts().filter(
    (p) => p.message.includes('repair me') || p.message.includes('final answer'),
  );
  report(
    'child was prompted twice (task + repair)',
    repairChildPrompts.length === 2,
    String(repairChildPrompts.length),
  );

  appendChildRule({ match: 'explode', behavior: 'fail' });
  const [failRun] = await manager.runTasks(parentId, [{ prompt: 'explode now' }]);
  report(
    'failing child surfaces error',
    failRun.status === 'failed' && failRun.error === 'stub child failure',
  );

  console.log('tool result disk paths');
  const subTool = tools.find((t) => t.name === 'subagent');
  const shortExec = await subTool.execute('exec-1', { tasks: [{ prompt: 'path probe short' }] });
  const shortText = shortExec.content[0].text;
  const shortMeta = readChildResults('parent-1').find((r) => r.prompt === 'path probe short');
  const shortPath = path.join(SESSIONS_ROOT, '_subagents', 'parent-1', shortMeta.id, 'result.json');
  report('tool result names absolute result path', shortText.includes(shortPath), shortPath);
  report('named path exists on disk', fs.existsSync(shortPath));

  appendChildRule({ match: 'path probe long', reply: 'x'.repeat(6000) });
  const longExec = await subTool.execute('exec-2', { tasks: [{ prompt: 'path probe long' }] });
  const longText = longExec.content[0].text;
  const longMeta = readChildResults('parent-1').find((r) => r.prompt === 'path probe long');
  const longPath = path.join(SESSIONS_ROOT, '_subagents', 'parent-1', longMeta.id, 'result.json');
  report(
    'truncation marker carries the path',
    longText.includes(`[truncated - full result: ${longPath}]`),
    `len=${longText.length}`,
  );
  report(
    'full result persisted beyond cap',
    fs.existsSync(longPath) && (JSON.parse(fs.readFileSync(longPath, 'utf8')).result ?? '').length > 4000,
  );

  const unknownExec = await subTool
    .execute('exec-3', {
      tasks: [{ prompt: 'path probe unknown-model', model: 'nope/missing' }],
    })
    .then(
      (v) => v,
      (e) => e,
    );
  const unknownText = String(unknownExec.message ?? unknownExec?.content?.[0]?.text ?? '');
  report(
    'total failure throws error result for red display',
    unknownExec instanceof Error && unknownText.includes("[task-1] failed: unknown model 'nope/missing'"),
    unknownText.slice(0, 80),
  );
  report(
    'run without disk artifact omits phantom path',
    !unknownText.includes('result.json'),
    unknownText.slice(0, 80),
  );
  report('completed runs do not throw', shortExec && !shortExec.isError, '');

  console.log('subagent live feed');
  const feedUpdates = [];
  appendChildRule({ match: 'feed probe stream', behavior: 'stream', reply: 'streamed final answer' });
  const [feedRun] = await manager.runTasks(parentId, [{ prompt: 'feed probe stream' }], {
    onUpdate: (u) => {
      const t = u?.content?.[0]?.text;
      if (t) feedUpdates.push(t);
    },
  });
  report(
    'feed child completes without feed leaking into answer',
    feedRun.status === 'completed' && feedRun.result === 'streamed final answer',
    `${feedRun.status}:${feedRun.error}:${feedRun.result}`,
  );
  report(
    'feed carries status transitions',
    feedUpdates.some((t) => t.startsWith('[task-1] queued')) &&
      feedUpdates.some((t) => t.startsWith('[task-1] running')) &&
      feedUpdates.some((t) => t.startsWith('[task-1] completed')),
    JSON.stringify(feedUpdates.map((t) => t.split('\n')[0])),
  );
  report(
    'feed streams live child thinking',
    feedUpdates.some((t) => t.includes('thinking: thinking part')),
    (feedUpdates.find((t) => t.includes('thinking')) ?? '').split('\n').slice(0, 2).join(' | '),
  );
  const lastFeed = feedUpdates[feedUpdates.length - 1] ?? '';
  report(
    'feed commits child activity lines cumulatively',
    lastFeed.includes('thinking: thinking part two longer') &&
      lastFeed.includes('text: streamed final answer'),
    lastFeed.slice(-140),
  );

  const wfTool = tools.find((t) => t.name === 'workflow');
  appendChildRule({ match: 'explode quietly', behavior: 'fail' });
  const wfFail = await wfTool
    .execute('exec-4', {
      spec: {
        name: 'failspec',
        nodes: [{ id: 'a', prompt: 'explode quietly', model: 'stub-pro', thinking: 'off' }],
      },
    })
    .then(
      (v) => v,
      (e) => e,
    );
  const wfFailText = String(wfFail.message ?? wfFail?.content?.[0]?.text ?? '');
  report(
    'failed workflow throws error result for red display',
    wfFail instanceof Error && wfFailText.includes("workflow 'failspec' did not complete"),
    wfFailText.slice(0, 80),
  );

  const wf = {
    name: 'audit',
    nodes: [
      { id: 'scan', prompt: 'list the routes', model: 'stub-pro', thinking: 'off' },
      {
        id: 'audit',
        needs: ['scan'],
        forEach: 'scan',
        prompt: 'audit {{item}} closely',
        model: 'stub-pro',
        thinking: 'off',
      },
      {
        id: 'verify',
        needs: ['audit'],
        prompt: 'verify these findings: {{audit}}',
        model: 'stub-pro',
        thinking: 'off',
      },
    ],
  };
  const result = await manager.runWorkflow(parentId, wf, {});
  report('workflow completes', result.ok, result.error);
  report(
    'workflow output is the verify node result',
    result.output.includes('verify these findings'),
    result.output.slice(0, 80),
  );
  report('workflow node lines', result.nodes.length === 3, JSON.stringify(result.nodes));
  report(
    'workflow reports output file on disk',
    (result.outputFiles ?? []).length === 1 && fs.existsSync(result.outputFiles[0]),
    JSON.stringify(result.outputFiles),
  );
  const wfResults = readChildResults('parent-1');
  const auditResults = wfResults.filter((r) => String(r.label).startsWith('audit:audit#'));
  report(
    'forEach fanned out to 2 audit children',
    auditResults.length === 2,
    JSON.stringify(auditResults.map((r) => r.label)),
  );
  report(
    'audit children carried {{item}} from scan',
    auditResults.some((r) => r.result.includes('src/a.ts')) &&
      auditResults.some((r) => r.result.includes('src/b.ts')),
    JSON.stringify(auditResults.map((r) => r.result)),
  );

  let threw = '';
  try {
    await manager.runWorkflow(
      parentId,
      { nodes: [{ id: 'a', prompt: 'x', needs: ['a'], model: 'stub-pro', thinking: 'off' }] },
      {},
    );
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  report('invalid workflow spec rejected before spawn', threw.includes('cannot need itself'), threw);

  appendChildRule({ match: 'hang tight', behavior: 'hang' });
  const hangPromise = manager.runTasks(parentId, [{ prompt: 'hang tight forever' }]);
  await delay(300);
  const liveList = manager.list({});
  report(
    'running child visible in list',
    liveList.some((r) => r.label === 'task-1' && r.status === 'running'),
    JSON.stringify(liveList.map((r) => [r.label, r.status])),
  );
  const runningIds = liveList.filter((r) => r.status === 'running').map((r) => r.id);
  report('exactly one running child', runningIds.length === 1, JSON.stringify(runningIds));
  const gcRunning = manager.gc({ all: true, dryRun: true });
  report(
    'gc skips running children',
    gcRunning.removed.every((r) => !runningIds.includes(r.id)),
    JSON.stringify(gcRunning.removed.map((r) => r.id)),
  );
  manager.abortForParent(parentId);
  const [hangRun] = await hangPromise;
  report('abort marks child aborted', hangRun.status === 'aborted', `${hangRun.status}:${hangRun.error}`);

  const dry = manager.gc({ session: parentId, dryRun: true });
  const totalDisk = subagentDirs('parent-1').length;
  report(
    'gc dry-run counts all terminal runs',
    dry.ok && dry.removed.length === totalDisk,
    `${dry.removed.length}/${totalDisk}`,
  );
  report('gc dry-run leaves files', subagentDirs('parent-1').length === totalDisk);
  const wipe = manager.gc({ session: parentId });
  report('gc removes session subtree', wipe.ok && wipe.removed.length === dry.removed.length);
  report(
    'gc actually freed the dirs',
    subagentDirs('parent-1').length === 0,
    String(subagentDirs('parent-1').length),
  );
  report('journal-free list after gc', manager.list({}).length === 0);

  const noTarget = manager.gc({});
  report('gc without target refused', !noTarget.ok);

  console.log('optimization hardening');
  const queuedManager = createSubagentManager({
    sessionsRoot: SESSIONS_ROOT,
    getSession: (id) => (id === parentId || id === parent2Id ? parentSession : null),
    limits: { globalMax: 1, providerMax: 1, modelMax: 1 },
  });
  appendChildRule({ match: 'hang tight', behavior: 'hang' });
  const parent2Id = parentId.replace('parent-1', 'parent-2');
  const twoSlow = queuedManager.runTasks(parent2Id, [
    { prompt: 'hang tight forever' },
    { prompt: 'quick reply please' },
  ]);
  await delay(300);
  const queuedList = queuedManager.list({});
  report(
    'second child queued behind governor cap',
    queuedList.some((r) => r.label === 'task-2' && r.status === 'queued'),
    JSON.stringify(queuedList.map((r) => [r.label, r.status])),
  );
  queuedManager.abortForParent(parent2Id);
  const [hangSlow, queuedRun] = await twoSlow;
  report('running child aborted', hangSlow.status === 'aborted', hangSlow.status);
  report(
    'queued child aborted without spawning',
    queuedRun.status === 'aborted' && !existsSyncSafe(parent2Id, queuedRun.id),
    `${queuedRun.status} dir=${existsSyncSafe(parent2Id, queuedRun.id)}`,
  );
  const promptsForParent2 = childPrompts().filter((p) => p.file.includes('parent-2'));
  report(
    'queued child consumed zero model prompts',
    promptsForParent2.length === 1,
    String(promptsForParent2.length),
  );

  appendChildRule({ match: 'unknown model probe', behavior: 'reply' });
  const [badModel] = await manager.runTasks(parentId, [
    { prompt: 'unknown model probe', model: 'nope/missing' },
  ]);
  report(
    'unknown model fails fast without child',
    badModel.status === 'failed' && badModel.error.includes('unknown model'),
    badModel.error,
  );

  const wipe2 = queuedManager.gc({ session: parent2Id });
  report(
    'gc prunes empty parent dir',
    wipe2.removed.length === 1 && !fs.existsSync(path.join(SESSIONS_ROOT, '_subagents', 'parent-2')),
    JSON.stringify(wipe2.removed.map((r) => r.id)),
  );

  console.log('thinking levels');
  const childSessions = () => {
    const file = path.join(STUB_STATE_DIR, 'subagent-sessions.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  };
  appendChildRule({ match: 'think hard', behavior: 'reply', reply: 'thought about it' });
  const rHigh = await manager.runWorkflow(parentId, {
    name: 'think',
    nodes: [{ id: 'a', prompt: 'think hard', model: 'stub-pro', thinking: 'high' }],
  });
  report('node thinking=high runs', rHigh.ok, rHigh.error);
  report(
    'child session created with thinking high',
    childSessions().some((s) => s.thinkingLevel === 'high'),
    JSON.stringify(childSessions().map((s) => s.thinkingLevel)),
  );
  const highMeta = readChildResults('parent-1').find((r) => r.label === 'think:a');
  report('result.json records thinking level', highMeta?.thinking === 'high', String(highMeta?.thinking));

  const rXhigh = await manager.runWorkflow(parentId, {
    name: 'tx',
    nodes: [{ id: 'a', prompt: 'never runs', model: 'stub-pro', thinking: 'xhigh' }],
  });
  report(
    'unsupported level fails with model id in error',
    !rXhigh.ok && rXhigh.error.includes("unsupported thinking level 'xhigh' for model stub-pro"),
    rXhigh.error,
  );
  report(
    'unsupported level spawned zero sessions',
    !childSessions().some((s) => s.thinkingLevel === 'xhigh'),
  );

  const [miniLow] = await manager.runTasks(parentId, [
    { prompt: 'mini low probe', model: 'stub/stub-mini', thinking: 'low' },
  ]);
  report(
    'non-reasoning model rejects low',
    miniLow.status === 'failed' && miniLow.error === "unsupported thinking level 'low' for model stub-mini",
    miniLow.error,
  );
  const [miniOff] = await manager.runTasks(parentId, [
    { prompt: 'mini off probe', model: 'stub/stub-mini', thinking: 'off' },
  ]);
  report('explicit off accepted on non-reasoning model', miniOff.status === 'completed', miniOff.error);

  const [defaultTask] = await manager.runTasks(parentId, [{ prompt: 'default thinking probe' }]);
  const defaultMeta = readChildResults('parent-1').find((r) => r.id === defaultTask.id);
  report('thinking unset records null', defaultMeta?.thinking === null, String(defaultMeta?.thinking));
  report(
    'no child ever created at unsupported level',
    childSessions().length > 0 && childSessions().every((s) => s.thinkingLevel !== 'xhigh'),
  );

  manager.gc({ session: parentId });
  report('thinking test runs cleaned up', !fs.existsSync(path.join(SESSIONS_ROOT, '_subagents', 'parent-1')));

  return { manager, parentId };
}

async function httpTests() {
  console.log('backend http surface');
  const port = await freePort();
  const child = spawn('node', ['src/pi-studio/server/index.mjs'], {
    cwd: PRODUCT_ROOT,
    env: {
      ...process.env,
      PI_STUDIO_PORT: String(port),
      PI_STUDIO_HOST: '127.0.0.1',
      PI_STUDIO_SESSIONS: SESSIONS_ROOT,
      PI_STUDIO_CWD: TMP,
      PI_STUDIO_DB_PATH: DB_PATH,
      PI_SDK_DIR: STUB_SDK,
      STUB_STATE_DIR,
    },
    stdio: [
      'ignore',
      fs.openSync(path.join(TMP, 'http-backend.log'), 'a'),
      fs.openSync(path.join(TMP, 'http-backend.log'), 'a'),
    ],
  });
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      try {
        const h = await getJson(port, '/api/health');
        up = h?.ok === true;
      } catch {}
      if (!up) await delay(250);
    }
    report('backend healthy', up);
    if (!up) return;
    fs.mkdirSync(path.join(SESSIONS_ROOT, '--tmp--'), { recursive: true });
    fs.writeFileSync(
      path.join(SESSIONS_ROOT, '--tmp--', '2025-real-session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 's', timestamp: new Date().toISOString(), cwd: TMP })}\n`,
    );
    fs.mkdirSync(path.join(SESSIONS_ROOT, '_subagents', 'hidden', 'child-1'), { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_ROOT, '_subagents', 'hidden', 'child-1', 'transcript.jsonl'), '{}\n');
    fs.writeFileSync(
      path.join(SESSIONS_ROOT, '_subagents', 'hidden', 'child-1', 'result.json'),
      `${JSON.stringify({ id: 'child-1', status: 'completed', label: 'hidden-run', result: 'secret', prompt: 'p', startedAt: Date.now(), finishedAt: Date.now() })}\n`,
    );

    const sessions = await getJson(port, '/api/sessions');
    const files = (sessions?.sessions ?? []).map((s) => s.file ?? '');
    report(
      'chat list hides _subagents, shows real sessions',
      files.some((f) => f.includes('2025-real-session')) && files.every((f) => !f.includes('_subagents')),
      JSON.stringify(files),
    );

    const runs = await getJson(port, '/api/subagents');
    report(
      'GET /api/subagents lists disk runs',
      runs?.runs?.length === 1 && runs.runs[0].label === 'hidden-run',
      JSON.stringify(runs?.runs?.map((r) => r.label)),
    );

    const filtered = await getJson(port, '/api/subagents?session=--tmp--%2Fnone.jsonl');
    report('GET /api/subagents?session filters', filtered?.runs?.length === 0);

    const refused = await postJson(port, '/api/subagents/gc', {});
    report('gc without target → 400', refused.status === 400, String(refused.status));

    const dry = await postJson(port, '/api/subagents/gc', { all: true, dryRun: true });
    report(
      'gc dry-run via http',
      dry.status === 200 && dry.json.removed.length === 1,
      JSON.stringify(dry.json?.removed),
    );
    report(
      'dry run did not delete',
      fs.existsSync(path.join(SESSIONS_ROOT, '_subagents', 'hidden', 'child-1', 'result.json')),
    );

    const wiped = await postJson(port, '/api/subagents/gc', { all: true });
    report('gc via http deletes', wiped.status === 200 && wiped.json.removed.length === 1);
    report(
      'subagents dir empty after gc',
      !fs.existsSync(path.join(SESSIONS_ROOT, '_subagents', 'hidden', 'child-1')),
    );
  } finally {
    child.kill('SIGTERM');
    await delay(300);
    if (!child.killed) child.kill('SIGKILL');
  }
}

(async () => {
  console.log('check:subagents');
  await engineTests();
  await managerTests();
  await httpTests();
  console.log(failed ? 'check:subagents FAILED' : 'check:subagents OK');
  process.exit(failed ? 1 : 0);
})();
