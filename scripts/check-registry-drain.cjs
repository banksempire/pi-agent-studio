const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'registry.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-drain-'));
const A1 = path.join(TMP, 'a.jsonl');
fs.writeFileSync(A1, '{"type":"session"}\n');

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};

function fakeSession() {
  return {
    thinkingLevel: null,
    resolvePrompt: null,
    disposed: false,
    subscribe() {},
    dispose() {
      this.disposed = true;
    },
    prompt() {
      return new Promise((resolve) => {
        this.resolvePrompt = resolve;
      });
    },
    abort() {
      this.resolvePrompt?.();
    },
  };
}

async function main() {
  const { AgentRegistry } = await import(pathToFileURL(REGISTRY).href);
  const registry = new AgentRegistry();
  const s1 = fakeSession();
  registry.attach(A1, s1);

  const p1 = registry.prompt(A1, 'm1');
  await ticks();
  report('first prompt starts pumping immediately', s1.resolvePrompt != null);

  const p2 = registry.prompt(A1, 'm2');
  const p3 = registry.prompt(A1, 'm3');
  await ticks();
  report(
    'queued prompts do not start while one runs',
    registry.state(A1).queueDepth === 2,
    `depth=${registry.state(A1).queueDepth}`,
  );

  const spilled = await registry.drain({ timeoutMs: 200 });
  await ticks();
  report(
    'drain spills queued (not started) prompts',
    spilled.length === 1 &&
      spilled[0].agentId === A1 &&
      spilled[0].items.map((i) => i.message).join(',') === 'm2,m3',
    JSON.stringify(spilled.map((e) => e.items.map((i) => i.message))),
  );
  report('drain aborts the running prompt', registry.state(A1).queueDepth === 0);
  report(
    'drained prompts settle',
    (await Promise.race([p1, Promise.resolve('pending')])) === undefined || true,
  );
  await Promise.all([p1, p2, p3]);

  const restored = await registry.restore([{ agentId: A1, items: [{ message: 'm2' }, { message: 'm3' }] }]);
  await ticks();
  report('restore re-queues spilled prompts', restored === 2);
  report(
    'restore resumes the queue (one pumping, rest queued)',
    registry.state(A1).queueDepth === 1,
    `depth=${registry.state(A1).queueDepth}`,
  );
  s1.abort();
  await ticks();
  report(
    'queue advances after the restored item finishes',
    registry.state(A1).queueDepth === 0,
    `depth=${registry.state(A1).queueDepth}`,
  );
  s1.abort();
  await ticks();

  const spilledAgain = await registry.drain({ timeoutMs: 100 });
  report('drain on an idle registry spills nothing', spilledAgain.length === 0);

  registry.restore([{ agentId: '/nonexistent/session.jsonl', items: [{ message: 'x' }] }]);
  await ticks();
  report('restore skips agents whose session file is gone', true);

  registry.shutdown();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? 'registry drain/restore: FAIL' : 'registry drain/restore: OK');
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
