import { EventEmitter } from 'node:events';
import { execSlash, listSkills, slashCatalog } from './slash.mjs';

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

export function createLocalClient(registry) {
  return {
    async ping() {
      return { ok: true };
    },

    async createSession({ cwd }) {
      return registry.createSession(cwd);
    },

    async openAgent({ agentId }) {
      await registry.open(agentId);
      return { ok: true, state: registry.state(agentId) };
    },

    async closeAgent({ agentId }) {
      return registry.close(agentId);
    },

    async prompt({ agentId, message, interrupt = true, reqId = '', images = [] }) {
      registry.broadcast('ack', agentId ?? '', { reqId: reqId ?? '', kind: 'message' });
      const imgs = Array.isArray(images) && images.length > 0 ? images : parseImagesJson(images);
      await registry.prompt(agentId, message, { interrupt: interrupt !== false, images: imgs });
      return { ok: true };
    },

    async abort({ agentId }) {
      return registry.abort(agentId);
    },

    async slash({ agentId = '', command, args = '', extra = {}, reqId = '' }) {
      registry.broadcast('ack', agentId ?? '', { reqId: reqId ?? '', kind: 'slash', command: command ?? '' });
      const r = await execSlash(registry, { agentId, command, args, extra });
      return {
        ok: !!r.ok,
        notice: r.notice ?? '',
        error: r.error ?? '',
        dataJson: r.data !== undefined ? JSON.stringify(r.data) : '',
      };
    },

    async getSlashCatalog() {
      return {
        commandsJson: JSON.stringify(slashCatalog()),
        skillsJson: JSON.stringify(listSkills()),
      };
    },

    async listStates() {
      return { states: registry.states() };
    },

    async getAgentState({ agentId }) {
      return { state: registry.state(agentId) };
    },

    subscribe(filter = '') {
      const bus = new EventEmitter();
      const handler = (ev) => {
        if (filter && ev.file !== filter) return;
        bus.emit('data', { type: ev.type, file: ev.file, json: ev.json });
      };
      registry.on('event', handler);
      for (const snap of registry.snapshot(filter || null)) {
        queueMicrotask(() => bus.emit('data', snap));
      }
      bus.destroy = () => registry.off('event', handler);
      return bus;
    },

    close() {},
  };
}
