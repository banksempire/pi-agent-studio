const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-nm-'));

let failed = false;
let forceRm = (p) => fs.rmSync(p, { recursive: true, force: true });
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};

function buildSrc(root) {
  const nm = path.join(root, 'node_modules');
  for (const d of ['pkg-a/dist', 'pkg-b/lib/deep', '@scope/pkg-c', '.bin']) {
    fs.mkdirSync(path.join(nm, d), { recursive: true });
  }
  fs.writeFileSync(path.join(nm, 'pkg-a', 'package.json'), '{"name":"pkg-a"}\n');
  fs.writeFileSync(path.join(nm, 'pkg-a', 'dist', 'index.js'), 'console.log("a");\n');
  const big = Buffer.alloc(100_000, 0x5a);
  fs.writeFileSync(path.join(nm, 'pkg-b', 'lib', 'deep', 'blob.bin'), big);
  fs.writeFileSync(path.join(nm, 'pkg-b', 'lib', 'deep', 'nested.txt'), 'nested\n');
  fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}\n');
  fs.symlinkSync('../pkg-a/dist/index.js', path.join(nm, '.bin', 'pkg-a'));
  fs.symlinkSync('/nonexistent-target', path.join(nm, 'pkg-b', 'broken-link'));
  return nm;
}

async function main() {
  const {
    copyModulesFrom,
    modulesComplete,
    modulesStats,
    forceRm: forceRmImpl,
  } = await import(pathToFileURL(path.join(PRODUCT_ROOT, 'bin', 'lib', 'copy-modules.mjs')));
  forceRm = forceRmImpl;
  const lines = [];
  const out = { line: (s) => lines.push(s) };
  const srcRepo = path.join(RUN_ROOT, 'src-repo');
  const dstRepo = path.join(RUN_ROOT, 'dst-repo');
  fs.mkdirSync(srcRepo, { recursive: true });
  fs.mkdirSync(dstRepo, { recursive: true });
  const src = buildSrc(srcRepo);
  const dst = path.join(dstRepo, 'node_modules');
  const srcStats = modulesStats(src);

  lines.length = 0;
  let res = copyModulesFrom(srcRepo, dstRepo, out);
  report(
    'fresh hardlink copy completes and verifies',
    res === 'copied' && modulesComplete(src, dst),
    `res=${res}`,
  );
  const nested = path.join(dst, 'pkg-b', 'lib', 'deep', 'nested.txt');
  report(
    'copied tree keeps nested content, dotfiles, and symlinks (including broken)',
    fs.readFileSync(nested, 'utf8') === 'nested\n' &&
      fs.existsSync(path.join(dst, '.package-lock.json')) &&
      fs.lstatSync(path.join(dst, '.bin', 'pkg-a')).isSymbolicLink() &&
      fs.lstatSync(path.join(dst, 'pkg-b', 'broken-link')).isSymbolicLink(),
  );

  lines.length = 0;
  res = copyModulesFrom(srcRepo, dstRepo, out);
  report('an already-complete destination is skipped untouched', res === 'skipped', `res=${res}`);

  fs.rmSync(path.join(dst, 'pkg-a'), { recursive: true, force: true });
  fs.rmSync(path.join(dst, '.package-lock.json'), { force: true });
  lines.length = 0;
  res = copyModulesFrom(srcRepo, dstRepo, out);
  report(
    'a partially-copied destination is detected, warned about, and healed',
    res === 'copied' && modulesComplete(src, dst) && lines.join('\n').includes('incomplete node_modules'),
    `res=${res}`,
  );

  fs.unlinkSync(path.join(dst, 'pkg-b', 'lib', 'deep', 'nested.txt'));
  fs.unlinkSync(path.join(dst, 'pkg-a', 'dist', 'index.js'));
  report(
    'the verifier catches a destination missing files (source intact — hardlinks not aliased)',
    modulesComplete(src, dst) === false && modulesStats(src).files === srcStats.files,
    `src=${JSON.stringify(srcStats)} dst=${JSON.stringify(modulesStats(dst))}`,
  );
  res = copyModulesFrom(srcRepo, dstRepo, out);
  report(
    'recopying after file loss restores a complete tree',
    res === 'copied' && modulesComplete(src, dst),
    `res=${res}`,
  );

  fs.chmodSync(src, 0o000);
  lines.length = 0;
  let threw = '';
  try {
    res = copyModulesFrom(srcRepo, dstRepo, out);
  } catch (e) {
    threw = e.message;
  } finally {
    fs.chmodSync(src, 0o755);
  }
  report(
    'an unreadable source fails loudly with cleanup, never a silent skip',
    res === 'failed' && !fs.existsSync(dst) && lines.join('\n').includes('did not complete'),
    `res=${res} threw=${threw}`,
  );

  res = copyModulesFrom(path.join(RUN_ROOT, 'no-such-repo'), dstRepo, out);
  report('a source without node_modules is a silent skip', res === 'skipped', `res=${res}`);
}

main()
  .catch((e) => {
    report('suite crashed', false, e.stack || e.message);
  })
  .finally(() => {
    forceRm(RUN_ROOT);
    if (failed) {
      console.log('\nWORKTREE-NM CHECKS FAILED');
      process.exit(1);
    }
    console.log('\nALL WORKTREE-NM CHECKS PASSED');
    process.exit(0);
  });
