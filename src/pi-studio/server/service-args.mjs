function readFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    const name = (eq === -1 ? t : t.slice(0, eq)).slice(2);
    const value = eq === -1 ? argv[++i] : t.slice(eq + 1);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export const serviceArgs = readFlags(process.argv);

export function flagOrEnv(flag, envKey, fallback) {
  return serviceArgs[flag] ?? process.env[envKey] ?? fallback;
}
