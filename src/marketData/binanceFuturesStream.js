import { EventEmitter } from "node:events";
import WebSocket from "ws";

export class BinanceFuturesStream extends EventEmitter {
  constructor({
    baseUrl = "wss://fstream.binance.com",
    WebSocketClass = WebSocket,
    maxDetailedSymbols = 12,
    marketEmitIntervalMs = 750,
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 30_000,
    heartbeatMs = 15_000
  } = {}) {
    super();
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.WebSocketClass = WebSocketClass;
    this.maxDetailedSymbols = maxDetailedSymbols;
    this.marketEmitIntervalMs = Math.max(100, Number(marketEmitIntervalMs) || 750);
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.heartbeatMs = heartbeatMs;
    this.running = false;
    this.marketSocket = null;
    this.detailSocket = null;
    this.detailSymbols = new Set();
    this.subscribedDetailStreams = new Set();
    this.requestId = 1;
    this.lastMarketEmitAt = new Map();
    this.reconnectTimers = new Map();
    this.heartbeatTimers = new Map();
    this.status = {
      market: createSocketStatus(),
      detail: createSocketStatus()
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#connect("market");
    this.#connect("detail");
  }

  stop() {
    this.running = false;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.reconnectTimers.clear();
    this.heartbeatTimers.clear();
    for (const socket of [this.marketSocket, this.detailSocket]) {
      if (socket && socket.readyState < 2) socket.close(1000, "radar shutdown");
    }
  }

  setDetailedSymbols(symbols = []) {
    const next = new Set(
      symbols
        .map((symbol) => String(symbol || "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, this.maxDetailedSymbols)
    );
    this.detailSymbols = next;
    this.#syncDetailSubscriptions();
  }

  getStatus() {
    return {
      market: { ...this.status.market },
      detail: { ...this.status.detail },
      detailedSymbols: [...this.detailSymbols].map((symbol) => symbol.toUpperCase())
    };
  }

  #connect(kind) {
    if (!this.running) return;
    const status = this.status[kind];
    status.connecting = true;
    status.lastConnectAttemptAt = new Date().toISOString();
    const url = kind === "market"
      ? `${this.baseUrl}/ws/!bookTicker`
      : `${this.baseUrl}/ws`;
    const socket = new this.WebSocketClass(url);
    if (kind === "market") this.marketSocket = socket;
    else this.detailSocket = socket;

    socket.on("open", () => {
      status.connected = true;
      status.connecting = false;
      status.connectedAt = new Date().toISOString();
      status.lastError = null;
      status.reconnectAttempt = 0;
      socket.__lastPongAt = Date.now();
      if (kind === "detail") {
        this.subscribedDetailStreams.clear();
        this.#syncDetailSubscriptions();
      }
      this.#startHeartbeat(kind, socket);
      this.emit("status", this.getStatus());
    });

    socket.on("message", (raw) => {
      status.lastMessageAt = new Date().toISOString();
      status.messageCount += 1;
      this.#handleMessage(kind, raw);
    });
    socket.on("pong", () => {
      socket.__lastPongAt = Date.now();
    });
    socket.on("error", (error) => {
      status.lastError = error.message;
      this.emit("streamError", { kind, error });
    });
    socket.on("close", (code, reason) => {
      status.connected = false;
      status.connecting = false;
      status.disconnectedAt = new Date().toISOString();
      status.lastClose = `${code}${reason?.length ? ` ${reason.toString()}` : ""}`;
      this.#clearHeartbeat(kind);
      this.emit("status", this.getStatus());
      this.#scheduleReconnect(kind);
    });
  }

  #handleMessage(kind, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.result === null && message.id != null) return;

    const payload = kind === "market" ? message.data ?? message : message;
    if (kind === "market" && payload?.e === "bookTicker") {
      const ticker = normalizeBookAsTicker(payload);
      const previousAt = this.lastMarketEmitAt.get(ticker.symbol) || 0;
      if (ticker.eventTime - previousAt >= this.marketEmitIntervalMs) {
        this.lastMarketEmitAt.set(ticker.symbol, ticker.eventTime);
        this.emit("ticker", ticker);
      }
      return;
    }
    if (Array.isArray(payload)) {
      for (const ticker of payload) this.emit("ticker", normalizeTicker(ticker));
      return;
    }
    if (payload?.e === "24hrMiniTicker") this.emit("ticker", normalizeTicker(payload));
    else if (payload?.e === "bookTicker" || !payload?.e && payload?.b != null && payload?.a != null && payload?.s) {
      this.emit("book", normalizeBook(payload));
    } else if (payload?.e === "aggTrade") {
      this.emit("trade", normalizeTrade(payload));
    } else if (payload?.e === "depthUpdate") {
      this.emit("depth", normalizeDepth(payload));
    }
  }

  #syncDetailSubscriptions() {
    const socket = this.detailSocket;
    if (!socket || socket.readyState !== this.WebSocketClass.OPEN) return;
    const desired = new Set();
    for (const symbol of this.detailSymbols) {
      desired.add(`${symbol}@bookTicker`);
      desired.add(`${symbol}@aggTrade`);
      desired.add(`${symbol}@depth20@100ms`);
    }
    const subscribe = [...desired].filter((stream) => !this.subscribedDetailStreams.has(stream));
    const unsubscribe = [...this.subscribedDetailStreams].filter((stream) => !desired.has(stream));
    if (subscribe.length) this.#sendSubscription(socket, "SUBSCRIBE", subscribe);
    if (unsubscribe.length) this.#sendSubscription(socket, "UNSUBSCRIBE", unsubscribe);
    this.subscribedDetailStreams = desired;
  }

  #sendSubscription(socket, method, params) {
    socket.send(JSON.stringify({ method, params, id: this.requestId++ }));
  }

  #startHeartbeat(kind, socket) {
    this.#clearHeartbeat(kind);
    const timer = setInterval(() => {
      if (socket.readyState !== this.WebSocketClass.OPEN) return;
      if (Date.now() - Number(socket.__lastPongAt || 0) > this.heartbeatMs * 2.5) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, this.heartbeatMs);
    timer.unref?.();
    this.heartbeatTimers.set(kind, timer);
  }

  #clearHeartbeat(kind) {
    const timer = this.heartbeatTimers.get(kind);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(kind);
  }

  #scheduleReconnect(kind) {
    if (!this.running || this.reconnectTimers.has(kind)) return;
    const status = this.status[kind];
    status.reconnectAttempt += 1;
    status.reconnectCount += 1;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(6, status.reconnectAttempt - 1)));
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(kind);
      this.#connect(kind);
    }, jittered);
    timer.unref?.();
    this.reconnectTimers.set(kind, timer);
  }
}

function normalizeTicker(row = {}) {
  return {
    symbol: row.s,
    eventTime: Number(row.E || Date.now()),
    closePrice: Number(row.c),
    openPrice: Number(row.o),
    highPrice: Number(row.h),
    lowPrice: Number(row.l),
    baseVolume: Number(row.v),
    quoteVolume: Number(row.q)
  };
}

function normalizeBookAsTicker(row = {}) {
  const book = normalizeBook(row);
  const closePrice = book.bidPrice > 0 && book.askPrice > 0
    ? (book.bidPrice + book.askPrice) / 2
    : book.bidPrice || book.askPrice;
  return {
    symbol: book.symbol,
    eventTime: book.eventTime,
    closePrice,
    quoteVolume: null,
    bidPrice: book.bidPrice,
    bidQty: book.bidQty,
    askPrice: book.askPrice,
    askQty: book.askQty,
    source: "bookTicker"
  };
}

function normalizeBook(row = {}) {
  return {
    symbol: row.s,
    eventTime: Number(row.E || row.T || Date.now()),
    transactionTime: Number(row.T || 0),
    updateId: Number(row.u || 0),
    bidPrice: Number(row.b),
    bidQty: Number(row.B),
    askPrice: Number(row.a),
    askQty: Number(row.A)
  };
}

function normalizeTrade(row = {}) {
  const price = Number(row.p);
  const quantity = Number(row.q);
  return {
    symbol: row.s,
    eventTime: Number(row.E || row.T || Date.now()),
    tradeTime: Number(row.T || 0),
    aggregateTradeId: row.a,
    price,
    quantity,
    quoteQuantity: price * quantity,
    isBuyerMaker: Boolean(row.m),
    buy: !row.m
  };
}

function normalizeDepth(row = {}) {
  const bids = normalizeDepthSide(row.b);
  const asks = normalizeDepthSide(row.a);
  const bidNotional = bids.reduce((sum, item) => sum + item.notional, 0);
  const askNotional = asks.reduce((sum, item) => sum + item.notional, 0);
  const total = bidNotional + askNotional;
  return {
    symbol: row.s,
    eventTime: Number(row.E || row.T || Date.now()),
    transactionTime: Number(row.T || 0),
    firstUpdateId: Number(row.U || 0),
    finalUpdateId: Number(row.u || 0),
    bids,
    asks,
    bidNotional,
    askNotional,
    imbalance: total ? (bidNotional - askNotional) / total : null
  };
}

function normalizeDepthSide(rows = []) {
  return rows.map(([price, quantity]) => ({
    price: Number(price),
    quantity: Number(quantity),
    notional: Number(price) * Number(quantity)
  }));
}

function createSocketStatus() {
  return {
    connected: false,
    connecting: false,
    connectedAt: null,
    disconnectedAt: null,
    lastConnectAttemptAt: null,
    lastMessageAt: null,
    messageCount: 0,
    reconnectAttempt: 0,
    reconnectCount: 0,
    lastClose: null,
    lastError: null
  };
}
