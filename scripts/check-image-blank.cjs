const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'registry.mjs');

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

function fakeSession() {
  return {
    calls: [],
    disposed: false,
    subscribe() {},
    dispose() {
      this.disposed = true;
    },
    async prompt(message, options) {
      this.calls.push({ message, images: options?.images ?? null });
    },
    async abort() {},
  };
}

const IMG = { data: 'aGVsbG8=', mimeType: 'image/jpeg' };

(async () => {
  const { AgentRegistry, IMAGE_ONLY_PROMPT } = await import(pathToFileURL(REGISTRY).href);
  report('placeholder constant is exported', IMAGE_ONLY_PROMPT === '(see attached image)', IMAGE_ONLY_PROMPT);

  const A = '/tmp/image-blank-fake-session.jsonl';
  const delivered = async (message, images) => {
    const r = new AgentRegistry();
    const f = fakeSession();
    r.attach(A, f);
    const rows = [];
    r.on('event', (e) => {
      if (e.type === 'message') rows.push(JSON.parse(e.json));
    });
    await r.prompt(A, message, images === undefined ? {} : { images });
    r.removeAllListeners('event');
    await r.close(A);
    return { calls: f.calls, rows };
  };

  {
    const { calls } = await delivered('', [IMG]);
    report(
      'empty text + image reaches the session as the image-only placeholder',
      calls.length === 1 &&
        calls[0].message === IMAGE_ONLY_PROMPT &&
        calls[0].images?.length === 1 &&
        calls[0].images[0].mimeType === 'image/jpeg',
      JSON.stringify(calls[0]),
    );
  }

  {
    const { calls } = await delivered('   ', [IMG]);
    report(
      'whitespace-only text + image reaches the session as the image-only placeholder',
      calls.length === 1 && calls[0].message === IMAGE_ONLY_PROMPT && calls[0].images?.length === 1,
      JSON.stringify(calls[0]),
    );
  }

  {
    const { calls } = await delivered('What is on this screenshot?', [IMG]);
    report(
      'real text + image passes through untouched',
      calls.length === 1 &&
        calls[0].message === 'What is on this screenshot?' &&
        calls[0].images?.length === 1,
      JSON.stringify(calls[0]),
    );
  }

  {
    const { calls } = await delivered('', []);
    report(
      'empty text without images is delivered unchanged',
      calls.length === 1 && calls[0].message === '' && calls[0].images === null,
      JSON.stringify(calls[0]),
    );
  }

  {
    const { rows } = await delivered('', [IMG]);
    const row = rows.find((x) => x.role === 'user');
    report(
      'broadcast row keeps the original (empty) text and carries the images',
      !!row && row.text === '' && Array.isArray(row.images) && row.images.length === 1,
      JSON.stringify(row),
    );
  }

  if (failed) {
    console.log('\nIMAGE-BLANK CHECKS FAILED');
    process.exit(1);
  }
  console.log('\nALL IMAGE-BLANK CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
