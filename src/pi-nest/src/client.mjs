/**
 * pi-nest gRPC client. Imported by front-end services (pi-agent-studio's
 * backend today, sub-agent tooling later) to drive agents without owning
 * them. All calls are promise-based; Subscribe returns a grpc stream.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, '..', 'proto', 'pi_nest.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  defaults: true,
  oneofs: true,
});
const piNest = grpc.loadPackageDefinition(packageDefinition).pi_nest;

export class PiNestClient {
  constructor({ host = process.env.PI_NEST_HOST ?? '127.0.0.1', port = Number(process.env.PI_NEST_PORT ?? 7495) } = {}) {
    // Keepalive pings make the channel notice a dead connection (e.g. after a
    // pi-nest restart) within keepalive_time_ms + keepalive_timeout_ms, so
    // Subscribe streams fire 'error' and consumers (the gateway relay) can
    // resubscribe instead of silently parking forever with no events.
    this.client = new piNest.PiNest(`${host}:${port}`, grpc.credentials.createInsecure(), {
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
    });
  }

  #unary(method, req) {
    return new Promise((resolve, reject) => {
      this.client[method](req, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  ping() {
    return this.#unary('ping', {});
  }

  createSession({ cwd }) {
    return this.#unary('createSession', { cwd });
  }

  openAgent({ agentId }) {
    return this.#unary('openAgent', { agentId });
  }

  closeAgent({ agentId }) {
    return this.#unary('closeAgent', { agentId });
  }

  prompt({ agentId, message, interrupt = true, reqId = '' }) {
    return this.#unary('prompt', { agentId, message, interrupt, reqId });
  }

  abort({ agentId }) {
    return this.#unary('abort', { agentId });
  }

  slash({ agentId = '', command, args = '', extra = {}, reqId = '' }) {
    return this.#unary('slash', {
      agentId,
      command,
      args,
      extraJson: JSON.stringify(extra ?? {}),
      reqId,
    });
  }

  getSlashCatalog() {
    return this.#unary('getSlashCatalog', {});
  }

  listStates() {
    return this.#unary('listStates', {});
  }

  getAgentState({ agentId }) {
    return this.#unary('getAgentState', { agentId });
  }

  /** Server-stream of agent events ({ type, file, json }). */
  subscribe(agentId = '') {
    return this.client.subscribe({ agentId });
  }
}

/** Create a client, waiting (with backoff) until pi-nest answers Ping. */
export function createClient(options) {
  const c = new PiNestClient(options);
  return c;
}

/** Retry Ping until pi-nest is reachable (or give up after `timeoutMs`). */
export async function waitForNest(client, { timeoutMs = 15000, log = console.error } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await client.ping();
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log(`[pi-nest] unreachable after ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
  return false;
}
