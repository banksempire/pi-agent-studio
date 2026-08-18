import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { AgentRegistry } from './registry.mjs';
import { execSlash, listSkills, slashCatalog } from './slash.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, '..', 'proto', 'pi_nest.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  defaults: true,
  oneofs: true,
});

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 11_200_000;
const MAX_IMAGES_JSON = 50_000_000;

export function parseImagesJson(json) {
  if (typeof json !== 'string' || !json || json.length > MAX_IMAGES_JSON) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (i) =>
          i &&
          typeof i.data === 'string' &&
          i.data.length > 0 &&
          i.data.length <= MAX_IMAGE_BASE64 &&
          typeof i.mimeType === 'string' &&
          i.mimeType.startsWith('image/'),
      )
      .slice(0, MAX_IMAGES);
  } catch {
    return [];
  }
}

const piNest = grpc.loadPackageDefinition(packageDefinition).pi_nest;

export function createServer({ registry = new AgentRegistry(), onStateChange: _onStateChange } = {}) {
  const server = new grpc.Server();
  const handlers = {
    Ping: (_call, cb) => cb(null, { ok: true }),

    CreateSession: (call, cb) => {
      try {
        const { file } = registry.createSession(call.request.cwd);
        cb(null, { file });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    OpenAgent: async (call, cb) => {
      try {
        await registry.open(call.request.agentId);
        cb(null, { ok: true, state: registry.state(call.request.agentId) });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    CloseAgent: async (call, cb) => {
      try {
        await registry.close(call.request.agentId);
        cb(null, { ok: true });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    Prompt: async (call, cb) => {
      try {
        registry.broadcast('ack', call.request.agentId, {
          reqId: call.request.reqId ?? '',
          kind: 'message',
        });
        const images = parseImagesJson(call.request.imagesJson);
        await registry.prompt(call.request.agentId, call.request.message, {
          interrupt: call.request.interrupt !== false,
          images,
        });
        cb(null, { ok: true });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    Abort: async (call, cb) => {
      try {
        await registry.abort(call.request.agentId);
        cb(null, { ok: true });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    Slash: async (call, cb) => {
      try {
        registry.broadcast('ack', call.request.agentId ?? '', {
          reqId: call.request.reqId ?? '',
          kind: 'slash',
          command: call.request.command ?? '',
        });
        let extra = {};
        try {
          extra = call.request.extraJson ? JSON.parse(call.request.extraJson) : {};
        } catch {}
        const r = await execSlash(registry, {
          agentId: call.request.agentId,
          command: call.request.command,
          args: call.request.args,
          extra,
        });
        cb(null, {
          ok: !!r.ok,
          notice: r.notice ?? '',
          error: r.error ?? '',
          dataJson: r.data !== undefined ? JSON.stringify(r.data) : '',
        });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    GetSlashCatalog: (_call, cb) => {
      try {
        cb(null, {
          commandsJson: JSON.stringify(slashCatalog()),
          skillsJson: JSON.stringify(listSkills()),
        });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    ListStates: (_call, cb) => {
      try {
        cb(null, { states: registry.states() });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    GetAgentState: (call, cb) => {
      try {
        cb(null, { state: registry.state(call.request.agentId) });
      } catch (e) {
        cb({ code: grpc.status.INTERNAL, message: String(e?.message ?? e) });
      }
    },

    Subscribe: (call) => {
      const filter = call.request.agentId || null;
      const handler = (ev) => {
        if (filter && ev.file !== filter) return;
        try {
          call.write({ type: ev.type, file: ev.file, json: ev.json });
        } catch {}
      };
      registry.on('event', handler);
      for (const snap of registry.snapshot(filter)) {
        try {
          call.write(snap);
        } catch {}
      }
      call.on('cancelled', () => registry.off('event', handler));
      call.on('error', () => registry.off('event', handler));
    },
  };

  server.addService(piNest.PiNest.service, handlers);
  return server;
}
