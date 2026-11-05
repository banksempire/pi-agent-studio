const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'registry.mjs');
const JOURNAL = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'journal.mjs');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-open-race-'));
const SESSIONS = path.join(TMP, 'sessions');
const CWD = path.join(TMP, 'cwd');
const STUB_STATE = path.join(TMP, 'stub-state');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(STUB_STATE, { recursive: true });

process.env.PI_SDK_DIR = STUB_SDK;
process.env.PI_STUDIO_SESSIONS = SESSIONS;
process.env.PI_STUDIO_CWD = CWD;
process.env.STUB_STATE_DIR = STUB_STATE;
fs.writeFileSync(path.join(STUB_STATE, 'release'), 'go\n');

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

async function main() {
  const { AgentRegistry } = await import(pathToFileURL(REGISTRY).href);
  const { openJournal } = await import(pathToFileURL(JOURNAL).href);

  const j = openJournal(path.join(TMP, 'race.db'), {});
  const r = new AgentRegistry({ journal: j });

  const { file } = r.createSession(CWD);

  const p1 = r.open(file);
  report(
    'in-flight open reports pending state',
    r.state(file).status === 'pending',
    `status=${r.state(file).status}`,
  );
  const p2 = r.open(file);
  const [a, b] = await Promise.all([p1, p2]);
  report('concurrent opens share one live session', a === b, `same=${a === b}`);

  report('race settles to idle', r.state(file).status === 'idle', `status=${r.state(file).status}`);
  report('exactly one live session after the race', r.states().length === 1, `states=${r.states().length}`);

  await r.prompt(file, 'hello once', { interrupt: false });
  const promptsLog = path.join(STUB_STATE, 'prompts.jsonl');
  const prompts = fs.existsSync(promptsLog)
    ? fs
        .readFileSync(promptsLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((p) => p.file === file && p.message === 'hello once')
    : [];
  report('prompt after the race delivers exactly once', prompts.length === 1, `count=${prompts.length}`);

  const again = await r.open(file);
  report('reopen of a live session returns it unchanged', again === a, `same=${again === a}`);

  const existing = path.join(SESSIONS, 'existing.jsonl');
  fs.writeFileSync(
    existing,
    `${JSON.stringify({ type: 'session', id: 'existing', cwd: CWD })}\n${JSON.stringify({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'old' }], timestamp: Date.now() },
    })}\n`,
  );
  const q1 = r.open(existing);
  const q2 = r.open(existing);
  const [x, y] = await Promise.all([q1, q2]);
  report('concurrent opens of an existing session share one live session', x === y, `same=${x === y}`);

  j.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? 'registry open-race check: FAIL' : 'registry open-race check: OK');
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
