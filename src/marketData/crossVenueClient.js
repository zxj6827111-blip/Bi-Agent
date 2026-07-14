export class CrossVenueClient {
  constructor({ fetchFn = globalThis.fetch, timeoutMs = 4_000, minMovePercent = 0.03 } = {}) {
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.minMovePercent = minMovePercent;
    this.baselines = new Map();
    this.health = {
      gate: createVenueHealth(),
      bitget: createVenueHealth()
    };
  }

  async prime(symbol, now = Date.now()) {
    const snapshot = await this.#fetchAll(symbol, now);
    this.baselines.set(symbol, snapshot);
    return snapshot;
  }

  async confirm(symbol, { binancePrice = null, now = Date.now() } = {}) {
    const baseline = this.baselines.get(symbol) || null;
    const current = await this.#fetchAll(symbol, now);
    const sources = [];
    let availableCount = 0;
    let confirmedCount = 0;

    for (const venue of ["gate", "bitget"]) {
      const before = baseline?.venues?.[venue];
      const after = current.venues[venue];
      if (!after?.available) {
        sources.push({ venue, available: false, error: after?.error || "unavailable" });
        continue;
      }
      availableCount += 1;
      const movePercent = before?.available && before.price > 0
        ? ((after.price - before.price) / before.price) * 100
        : null;
      const confirmed = movePercent != null && movePercent >= this.minMovePercent;
      if (confirmed) confirmedCount += 1;
      sources.push({
        venue,
        available: true,
        price: after.price,
        movePercent,
        confirmed,
        divergencePercent: Number(binancePrice) > 0
          ? ((after.price - Number(binancePrice)) / Number(binancePrice)) * 100
          : null
      });
    }

    return {
      symbol,
      sampledAt: current.sampledAt,
      baselineAt: baseline?.sampledAt || null,
      availableCount,
      confirmedCount,
      sources
    };
  }

  getHealth() {
    return structuredClone(this.health);
  }

  async #fetchAll(symbol, now) {
    const results = await Promise.all([
      this.#fetchVenue("gate", () => this.#fetchGate(symbol)),
      this.#fetchVenue("bitget", () => this.#fetchBitget(symbol))
    ]);
    return {
      symbol,
      sampledAt: new Date(now).toISOString(),
      venues: Object.fromEntries(results.map((item) => [item.venue, item]))
    };
  }

  async #fetchVenue(venue, loader) {
    const health = this.health[venue];
    health.requestCount += 1;
    const startedAt = Date.now();
    try {
      const value = await loader();
      health.successCount += 1;
      health.lastSuccessAt = new Date().toISOString();
      health.lastDurationMs = Date.now() - startedAt;
      health.lastError = null;
      return { venue, available: true, ...value };
    } catch (error) {
      health.failureCount += 1;
      health.lastFailureAt = new Date().toISOString();
      health.lastDurationMs = Date.now() - startedAt;
      health.lastError = error.message;
      return { venue, available: false, error: error.message };
    }
  }

  async #fetchGate(symbol) {
    const contract = toGateContract(symbol);
    const data = await this.#requestJson(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${encodeURIComponent(contract)}`);
    const ticker = Array.isArray(data) ? data[0] : data;
    const price = Number(ticker?.last);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Gate symbol unavailable");
    return { price, change24hPercent: finiteOrNull(Number(ticker.change_percentage)) };
  }

  async #fetchBitget(symbol) {
    const url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES`;
    const data = await this.#requestJson(url);
    const ticker = Array.isArray(data?.data) ? data.data[0] : data?.data;
    const price = Number(ticker?.lastPr);
    if (String(data?.code || "00000") !== "00000" || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Bitget symbol unavailable${data?.msg ? `: ${data.msg}` : ""}`);
    }
    return { price, change24hPercent: finiteOrNull(Number(ticker.change24h) * 100) };
  }

  async #requestJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "bi-agent-pump-radar/0.1" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`timeout after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toGateContract(symbol) {
  return String(symbol).toUpperCase().replace(/USDT$/, "_USDT");
}

function createVenueHealth() {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastDurationMs: null,
    lastError: null
  };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
