import { existsSync } from 'node:fs';

const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 11_200_000;
const MAX_TOTAL_BASE64 = 8 * 1024 * 1024;

export function normalizeAttachments(images) {
  if (images === undefined) return { images: [] };
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    return { error: 'images must be an array of at most 4 attachments' };
  }
  let totalBytes = 0;
  for (const im of images) {
    if (!im || typeof im.data !== 'string' || typeof im.mimeType !== 'string') {
      return { error: 'each image needs { mimeType, data }' };
    }
    if (!/^image\//.test(im.mimeType)) {
      return { error: 'only image/* attachments are allowed' };
    }
    if (im.data.length > MAX_IMAGE_BASE64) {
      return { error: 'image attachment too large' };
    }
    totalBytes += im.data.length;
  }
  if (totalBytes > MAX_TOTAL_BASE64) {
    return { error: 'attached images exceed 8 MB (base64)' };
  }
  return { images };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMessageQueue({
  client,
  journal = null,
  emit = () => {},
  holdMs = Number(process.env.PI_STUDIO_QUEUE_HOLD_MS ?? 15_000),
  retryBaseMs = 5_000,
  retryMaxMs = 60_000,
}) {
  const sessions = new Map();
  let memorySeq = -1;

  function stateOf(file) {
    let st = sessions.get(file);
    if (!st) {
      st = {
        items: [],
        hold: null,
        lastStatus: '',
        inflight: false,
        failStreak: 0,
        retryAt: 0,
        timers: { expiry: null, retry: null },
      };
      sessions.set(file, st);
    }
    return st;
  }

  function clearTimer(st, key) {
    if (st && st.timers[key] !== null) {
      clearTimeout(st.timers[key]);
      st.timers[key] = null;
    }
  }

  function broadcast(file) {
    const st = sessions.get(file);
    if (!st) return;
    emit({
      type: 'queue_update',
      file,
      items: st.items.map((m) => ({
        id: m.id,
        text: m.text,
        images: m.images,
        kind: m.kind,
        ...(m.data ? { data: m.data } : {}),
      })),
      held: isHeld(st),
    });
  }

  function isHeld(st) {
    return !!st.hold && Date.now() - st.hold.at < holdMs;
  }

  function armExpiry(file, st) {
    clearTimer(st, 'expiry');
    if (!st.hold) return;
    const left = Math.max(50, st.hold.at + holdMs - Date.now());
    st.timers.expiry = setTimeout(() => {
      st.timers.expiry = null;
      if (!st.hold) return;
      st.hold = null;
      broadcast(file);
      flushIfIdle(file);
    }, left);
  }

  function armRetry(file, st) {
    clearTimer(st, 'retry');
    const left = st.retryAt - Date.now();
    if (left <= 0) return;
    st.timers.retry = setTimeout(() => {
      st.timers.retry = null;
      void maybeFlush(file);
    }, left);
  }

  function noteStatus(file, status) {
    const st = stateOf(file);
    st.lastStatus = status;
    if (status === 'idle') {
      st.inflight = false;
      void maybeFlush(file);
    }
  }

  function enqueue(file, { kind = 'message', message, images = [], data = null }) {
    const st = stateOf(file);
    const id = journal ? journal.addUiQueue(file, { kind, message, images, data }) : memorySeq--;
    if (id === null || id === undefined) return null;
    st.items.push({ id, text: message, images, kind, data });
    st.retryAt = 0;
    st.failStreak = 0;
    broadcast(file);
    flushIfIdle(file);
    return id;
  }

  function list(file) {
    const st = sessions.get(file);
    if (!st) return [];
    return st.items.map((m) => ({
      id: m.id,
      text: m.text,
      images: m.images,
      kind: m.kind,
      ...(m.data ? { data: m.data } : {}),
    }));
  }

  function all() {
    const out = {};
    for (const [file, st] of sessions) {
      if (st.items.length) out[file] = list(file);
    }
    return out;
  }

  function heldFiles() {
    const out = [];
    for (const [file, st] of sessions) {
      if (isHeld(st)) out.push(file);
    }
    return out;
  }

  function size() {
    let n = 0;
    for (const st of sessions.values()) n += st.items.length;
    return n;
  }

  function updateText(file, id, text) {
    const st = sessions.get(file);
    if (!st) return false;
    const item = st.items.find((m) => m.id === id);
    if (item?.kind !== 'message') return false;
    item.text = text;
    if (journal) journal.updateUiQueue(id, file, text);
    broadcast(file);
    return true;
  }

  function itemOf(file, id) {
    const st = sessions.get(file);
    if (!st) return null;
    return st.items.find((m) => m.id === id) ?? null;
  }

  function remove(file, id) {
    const st = sessions.get(file);
    if (!st) return false;
    const i = st.items.findIndex((m) => m.id === id);
    if (i < 0) return false;
    st.items.splice(i, 1);
    if (journal) journal.deleteUiQueue(id, file);
    broadcast(file);
    return true;
  }

  function removeAll(file) {
    const st = sessions.get(file);
    clearTimer(st, 'expiry');
    clearTimer(st, 'retry');
    if (st) {
      st.items = [];
      st.hold = null;
      st.retryAt = 0;
      st.failStreak = 0;
    }
    if (journal) journal.deleteUiQueueSession(file);
    if (st) broadcast(file);
  }

  function hold(file) {
    const st = stateOf(file);
    st.hold = { at: Date.now() };
    armExpiry(file, st);
    broadcast(file);
  }

  function release(file) {
    const st = sessions.get(file);
    if (!st?.hold) return;
    st.hold = null;
    clearTimer(st, 'expiry');
    broadcast(file);
    flushIfIdle(file);
  }

  function flushIfIdle(file) {
    const st = sessions.get(file);
    if (!st || st.lastStatus === 'running') return;
    void maybeFlush(file);
  }

  async function maybeFlush(file) {
    const st = sessions.get(file);
    if (!st || st.inflight || !st.items.length) return;
    if (isHeld(st)) {
      armExpiry(file, st);
      return;
    }
    if (st.retryAt && Date.now() < st.retryAt) {
      armRetry(file, st);
      return;
    }
    const item = st.items[0];
    st.inflight = true;
    try {
      const delivery =
        item.kind === 'compact'
          ? client.slash({ agentId: file, command: 'compact' }).then((r) => {
              if (!r?.ok) throw new Error(r?.error || 'compaction refused');
              return r;
            })
          : item.kind === 'model'
            ? client
                .setModel({
                  file,
                  model: item.data?.model ?? '',
                  thinkLevel: item.data?.thinking ?? '',
                })
                .then((r) => {
                  if (!r?.ok) throw new Error(r?.error || 'model change refused');
                  return r;
                })
            : client.prompt({
                agentId: file,
                message: item.text,
                interrupt: false,
                images: item.images ?? [],
              });
      const p = Promise.resolve(delivery);
      st.items.shift();
      broadcast(file);
      p.then(
        () => {
          st.failStreak = 0;
          st.retryAt = 0;
          if (journal) journal.deleteUiQueue(item.id, file);
          if (item.kind !== 'message') {
            st.inflight = false;
            flushIfIdle(file);
          }
        },
        () => {
          st.inflight = false;
          st.failStreak += 1;
          st.retryAt = Date.now() + Math.min(retryBaseMs * 2 ** (st.failStreak - 1), retryMaxMs);
          st.items.unshift(item);
          broadcast(file);
          armRetry(file, st);
        },
      );
    } catch {
      st.inflight = false;
      st.failStreak += 1;
      st.retryAt = Date.now() + Math.min(retryBaseMs * 2 ** (st.failStreak - 1), retryMaxMs);
      armRetry(file, st);
    }
  }

  function restore() {
    if (!journal) return 0;
    let n = 0;
    for (const [file, items] of journal.reconcileUiQueue()) {
      if (!existsSync(file)) {
        journal.deleteUiQueueSession(file);
        continue;
      }
      const st = stateOf(file);
      st.items = items;
      n += items.length;
      void maybeFlush(file);
    }
    return n;
  }

  async function waitIdle(file) {
    const st = stateOf(file);
    for (let i = 0; i < 4000 && (st.items.length || st.inflight); i++) {
      if (!st.inflight && st.items.length && !isHeld(st) && Date.now() >= st.retryAt) {
        await maybeFlush(file);
      }
      await delay(25);
    }
  }

  return {
    holdMs,
    enqueue,
    list,
    all,
    itemOf,
    updateText,
    remove,
    removeAll,
    hold,
    release,
    noteStatus,
    restore,
    size,
    heldFiles,
    waitIdle,
  };
}
