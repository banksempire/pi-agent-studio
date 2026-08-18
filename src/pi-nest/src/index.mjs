import grpc from '@grpc/grpc-js';
import { AgentRegistry, WATCHDOG_INTERVAL_MS } from './registry.mjs';
import { NEW_CHAT_CWD, SESSIONS_ROOT, sdkDir } from './sdk-bridge.mjs';
import { createServer } from './server.mjs';
import { listSkills, slashCatalog } from './slash.mjs';

const HOST = process.env.PI_NEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PI_NEST_PORT ?? 7495);

const registry = new AgentRegistry();

console.log(`[pi-nest] starting pid=${process.pid}`);
process.on('uncaughtException', (e) => {
  console.error('[pi-nest] uncaught exception:', e?.stack ?? e);
});
process.on('exit', (code) => {
  console.log(`[pi-nest] exited code=${code}`);
});

setInterval(() => registry.scanStaleRuns(), WATCHDOG_INTERVAL_MS).unref();

const server = createServer({ registry });
console.log(`[pi-nest] slash catalog: ${slashCatalog().length} commands, ${listSkills().length} skills`);
server.bindAsync(`${HOST}:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error('[pi-nest] bind failed:', err.message);
    process.exit(1);
  }
  console.log(`[pi-nest] listening on ${HOST}:${port} (sdk: ${sdkDir})`);
  console.log(`[pi-nest] sessions: ${SESSIONS_ROOT}`);
  console.log(`[pi-nest] new chats cwd: ${NEW_CHAT_CWD}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[pi-nest] received ${sig} — shutting down`);
    registry.shutdown();
    server.tryShutdown(() => process.exit(0));
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[pi-nest] unhandled rejection:', reason);
});
