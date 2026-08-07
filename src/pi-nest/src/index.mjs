/**
 * pi-nest entry point: a standalone daemon owning pi agent sessions.
 * Start it detached (setsid nohup node src/pi-nest/src/index.mjs ...) — it must
 * outlive the front-end services that talk to it.
 */
import grpc from '@grpc/grpc-js';
import { AgentRegistry, WATCHDOG_INTERVAL_MS } from './registry.mjs';
import { createServer } from './server.mjs';
import { slashCatalog, listSkills } from './slash.mjs';
import { sdkDir, SESSIONS_ROOT, NEW_CHAT_CWD } from './sdk-bridge.mjs';

const HOST = process.env.PI_NEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PI_NEST_PORT ?? 7495);

const registry = new AgentRegistry();

// Death forensics: the daemon has died twice with zero log output. stdout/
// stderr go synchronously to the log file, so a crash or process.exit would
// leave a trace. The only silent exits are an external signal — SIGTERM is
// handled below but logs nothing today, SIGKILL is uncatchable. These hooks
// make the next death self-explaining: an abrupt log end without the "exit"
// line means SIGKILL; the SIGTERM line names the signal.
console.log(`[pi-nest] starting pid=${process.pid}`);
process.on('uncaughtException', (e) => {
  console.error('[pi-nest] uncaught exception:', e?.stack ?? e);
});
process.on('exit', (code) => {
  console.log(`[pi-nest] exited code=${code}`);
});

// Stale-run watchdog — force-settle hung runs so they stop blocking /compact
// and new messages (the SDK has no LLM timeout of its own). Only pi-nest can
// own this: it is the process that holds the live agents.
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
    registry.shutdown(); // dispose live agents — pi-nest itself is going down
    server.tryShutdown(() => process.exit(0));
  });
}

// An async error inside an agent op must not silently kill the daemon — log
// and let the per-agent op chain carry on (enqueue already isolates failures).
process.on('unhandledRejection', (reason) => {
  console.error('[pi-nest] unhandled rejection:', reason);
});
