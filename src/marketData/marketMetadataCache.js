export class MarketMetadataCache {
  constructor({ ttlMs = 6 * 60 * 60_000, staleMs = 24 * 60 * 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.staleMs = Math.max(this.ttlMs, Number(staleMs) || this.ttlMs);
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  peek(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const ageMs = Math.max(0, this.now() - entry.loadedAt);
    return {
      value: entry.value,
      loadedAt: entry.loadedAt,
      ageMs,
      stale: ageMs > this.ttlMs
    };
  }

  async getOrLoad(key, loader, { force = false } = {}) {
    const cached = this.peek(key);
    if (!force && cached && !cached.stale) {
      return { ...cached, source: "cache", fallbackError: null };
    }

    if (this.inflight.has(key)) return this.inflight.get(key);

    const pending = this.#load(key, loader, cached);
    this.inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(key);
    }
  }

  async #load(key, loader, cached) {
    try {
      const value = await loader();
      const loadedAt = this.now();
      this.entries.set(key, { value, loadedAt });
      return {
        value,
        loadedAt,
        ageMs: 0,
        stale: false,
        source: "network",
        fallbackError: null
      };
    } catch (error) {
      if (cached && cached.ageMs <= this.staleMs) {
        return {
          ...cached,
          stale: true,
          source: "stale-cache",
          fallbackError: error
        };
      }
      throw error;
    }
  }
}
