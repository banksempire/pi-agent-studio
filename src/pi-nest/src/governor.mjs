function normLimit(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function normKey(key) {
  if (!key) return null;
  const provider = typeof key.provider === 'string' ? key.provider.toLowerCase() : null;
  const model = typeof key.model === 'string' ? key.model.toLowerCase() : null;
  if (!provider || !model) return null;
  return { provider, model };
}

export class SlotGovernor {
  #limits;
  #inflight = new Set();
  #changeWaiters = new Set();

  constructor(limits = {}) {
    this.#limits = {
      globalMax: normLimit(limits.globalMax, 2),
      providerMax: normLimit(limits.providerMax, 2),
      modelMax: normLimit(limits.modelMax, 1),
    };
  }

  get limits() {
    return { ...this.#limits };
  }

  get size() {
    return this.#inflight.size;
  }

  setLimits(next = {}) {
    this.#limits = {
      globalMax: normLimit(next.globalMax, this.#limits.globalMax),
      providerMax: normLimit(next.providerMax, this.#limits.providerMax),
      modelMax: normLimit(next.modelMax, this.#limits.modelMax),
    };
    this.#notify();
  }

  tryAcquire(key) {
    const norm = normKey(key);
    if (this.#inflight.size >= this.#limits.globalMax) return null;
    if (norm) {
      let perProvider = 0;
      let perModel = 0;
      for (const slot of this.#inflight) {
        if (!slot.key) continue;
        if (slot.key.provider === norm.provider) perProvider++;
        if (slot.key.model === norm.model) perModel++;
      }
      if (perProvider >= this.#limits.providerMax || perModel >= this.#limits.modelMax) return null;
    }
    const slot = { key: norm };
    this.#inflight.add(slot);
    return slot;
  }

  release(slot) {
    if (!slot) return;
    this.#inflight.delete(slot);
    this.#notify();
  }

  async waitForSlot(key) {
    for (;;) {
      const slot = this.tryAcquire(key);
      if (slot) return slot;
      await new Promise((resolve) => this.#changeWaiters.add(resolve));
    }
  }

  async idle() {
    for (;;) {
      if (this.#inflight.size === 0) return;
      const changed = new Promise((resolve) => this.#changeWaiters.add(resolve));
      const nudge = new Promise((resolve) => setTimeout(resolve, 25));
      await Promise.race([changed, nudge]);
    }
  }

  onChange(waiter) {
    this.#changeWaiters.add(waiter);
  }

  #notify() {
    if (this.#changeWaiters.size === 0) return;
    const waiters = [...this.#changeWaiters];
    this.#changeWaiters.clear();
    for (const w of waiters) w();
  }
}
