const TRANSITIONS = {
  watching: new Set(["confirmed", "rejected", "cooldown"]),
  confirmed: new Set(["paper_open", "rejected", "cooldown"]),
  paper_open: new Set(["cooldown"]),
  rejected: new Set(["cooldown"]),
  cooldown: new Set(["watching"])
};

export class PumpStateMachine {
  constructor({ cooldownMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.now = now;
    this.records = new Map();
  }

  canWatch(symbol, at = this.now()) {
    const record = this.records.get(symbol);
    if (!record) return true;
    return record.state === "cooldown" && Number(record.cooldownUntil || 0) <= at;
  }

  startWatching(symbol, discovery, at = this.now()) {
    if (!this.canWatch(symbol, at)) return null;
    return this.#set(symbol, "watching", { discovery, reason: null }, at);
  }

  confirm(symbol, confirmation, at = this.now()) {
    return this.#transition(symbol, "confirmed", { confirmation }, at);
  }

  open(symbol, positionId, at = this.now()) {
    return this.#transition(symbol, "paper_open", { positionId }, at);
  }

  reject(symbol, reason, details = null, at = this.now()) {
    const record = this.#transition(symbol, "rejected", { reason, details }, at);
    return this.#transition(symbol, "cooldown", {
      cooldownUntil: at + this.cooldownMs
    }, at);
  }

  close(symbol, reason, at = this.now()) {
    return this.#transition(symbol, "cooldown", {
      reason,
      cooldownUntil: at + this.cooldownMs
    }, at);
  }

  get(symbol) {
    return this.records.get(symbol) || null;
  }

  list(states = null) {
    const allowed = states ? new Set(Array.isArray(states) ? states : [states]) : null;
    return [...this.records.values()].filter((record) => !allowed || allowed.has(record.state));
  }

  detailedSymbols() {
    return this.list(["watching", "confirmed", "paper_open"]).map((record) => record.symbol);
  }

  cleanup(at = this.now()) {
    for (const [symbol, record] of this.records.entries()) {
      if (record.state === "cooldown" && Number(record.cooldownUntil || 0) <= at) this.records.delete(symbol);
    }
  }

  #transition(symbol, nextState, patch, at) {
    const current = this.records.get(symbol);
    if (!current) throw new Error(`Cannot transition unknown symbol ${symbol} to ${nextState}`);
    if (!TRANSITIONS[current.state]?.has(nextState)) {
      throw new Error(`Invalid pump state transition ${current.state} -> ${nextState} for ${symbol}`);
    }
    return this.#set(symbol, nextState, patch, at);
  }

  #set(symbol, state, patch, at) {
    const current = this.records.get(symbol);
    const reset = state === "watching" && (!current || current.state === "cooldown");
    const record = {
      ...(reset ? {} : current || {}),
      symbol,
      state,
      enteredAt: at,
      updatedAt: at,
      ...patch
    };
    this.records.set(symbol, record);
    return record;
  }
}
