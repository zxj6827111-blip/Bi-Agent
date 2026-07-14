import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PumpRadarMonitor } from "../src/pumpRadar/pumpRadarMonitor.js";

test("PumpRadarMonitor discovers, confirms, paper-enters and risk-exits on Futures stream data", async () => {
  let now = 0;
  const stream = new FakeStream(() => now);
  const store = new MemoryStore();
  const monitor = new PumpRadarMonitor({
    options: radarOptions(),
    binanceClient: fakeBinanceClient(),
    stream,
    crossVenueClient: fakeCrossVenueClient(),
    eventStore: store,
    now: () => now,
    logger: { log() {}, warn() {} }
  });
  await monitor.start();

  stream.pushTicker({ symbol: "LABUSDT", eventTime: 0, closePrice: 100, quoteVolume: 20_000_000 });
  now = 10_000;
  stream.pushTicker({ symbol: "LABUSDT", eventTime: now, closePrice: 101.8, quoteVolume: 22_000_000 });
  await turn();
  assert.ok(stream.detailedSymbols.includes("LABUSDT"));

  now = 15_000;
  stream.pushBook({ symbol: "LABUSDT", eventTime: now, bidPrice: 101.79, bidQty: 300, askPrice: 101.8, askQty: 250 });
  stream.emit("depth", { symbol: "LABUSDT", eventTime: now, imbalance: 0.2 });
  stream.emit("trade", { symbol: "LABUSDT", eventTime: now, price: 101.8, quantity: 1_000, quoteQuantity: 101_800, buy: true });
  await turn();
  await turn();

  assert.equal(monitor.getState().positions.length, 1);
  assert.ok(store.events.some((event) => event.type === "paper_entry"));

  now = 16_000;
  stream.pushBook({ symbol: "LABUSDT", eventTime: now, bidPrice: 100, bidQty: 300, askPrice: 100.01, askQty: 250 });
  await turn();
  await turn();

  const state = monitor.getState();
  assert.equal(state.positions.length, 0);
  assert.equal(state.trades.length, 1);
  assert.equal(state.trades[0].exitReason, "hard_stop");
  await monitor.stop("test_complete");
});

test("PumpRadarMonitor blocks a new paper entry when the Binance primary stream is unavailable", async () => {
  let now = 0;
  const stream = new FakeStream(() => now);
  const store = new MemoryStore();
  const monitor = new PumpRadarMonitor({
    options: radarOptions(),
    binanceClient: fakeBinanceClient(),
    stream,
    crossVenueClient: fakeCrossVenueClient(),
    eventStore: store,
    now: () => now,
    logger: { log() {}, warn() {} }
  });
  await monitor.start();
  stream.pushTicker({ symbol: "LABUSDT", eventTime: 0, closePrice: 100, quoteVolume: 20_000_000 });
  now = 10_000;
  stream.pushTicker({ symbol: "LABUSDT", eventTime: now, closePrice: 101.8, quoteVolume: 22_000_000 });
  await turn();

  now = 15_000;
  stream.pushBook({ symbol: "LABUSDT", eventTime: now, bidPrice: 101.79, bidQty: 300, askPrice: 101.8, askQty: 250 });
  stream.emit("depth", { symbol: "LABUSDT", eventTime: now, imbalance: 0.2 });
  stream.emit("trade", { symbol: "LABUSDT", eventTime: now, price: 101.8, quantity: 1_000, quoteQuantity: 101_800, buy: true });
  stream.connected = false;
  await turn();
  await turn();

  assert.equal(monitor.getState().positions.length, 0);
  assert.ok(store.events.some((event) => event.type === "entry_blocked" && event.reason === "binance_source_unhealthy"));
  await monitor.stop("test_complete");
});

test("PumpRadarMonitor builds a Binance Futures universe from bookTicker when REST metadata is restricted", async () => {
  let now = 1_000;
  const stream = new FakeStream(() => now);
  const monitor = new PumpRadarMonitor({
    options: radarOptions(),
    binanceClient: {
      async getExchangeInfo() {
        throw new Error("HTTP 451");
      },
      async requestFutures() {
        throw new Error("HTTP 451");
      },
      getHealth() {
        return { futures: { failureCount: 1 } };
      }
    },
    stream,
    crossVenueClient: fakeCrossVenueClient(),
    eventStore: new MemoryStore(),
    now: () => now,
    logger: { log() {}, warn() {} }
  });
  await monitor.start();
  stream.pushTicker({
    symbol: "LABUSDT",
    eventTime: now,
    closePrice: 10,
    quoteVolume: null,
    bidPrice: 9.99,
    bidQty: 100,
    askPrice: 10.01,
    askQty: 100
  });

  const state = monitor.getState();
  assert.equal(state.universe.totalPerpetualUsdt, 1);
  assert.equal(state.universe.metadataSource, "stream_book_fallback");
  assert.equal(state.universe.streamDiscoveredSymbols, 1);
  await monitor.stop("test_complete");
});

function radarOptions() {
  return {
    outputDir: "unused",
    durationSeconds: 0,
    snapshotSeconds: 30,
    candidateRefreshSeconds: 30,
    streamUrl: "wss://example.test",
    streamStaleSeconds: 8,
    maxUniverseSymbols: 1_000,
    minQuoteVolume: 1_000_000,
    minDiscoveryBookNotional: 500,
    maxCandidates: 12,
    move10sPercent: 1.2,
    move30sPercent: 2,
    move60sPercent: 3,
    watchMinSeconds: 3,
    watchMaxSeconds: 20,
    minConfirmScore: 60,
    maxSpreadPercent: 0.25,
    minTopBookNotional: 15_000,
    minTradeQuote: 10_000,
    minBuyRatio: 0.58,
    minDepthImbalance: -0.2,
    maxEntryChasePercent: 1.5,
    cooldownSeconds: 600,
    crossVenueEnabled: true,
    crossVenueStrict: false,
    crossVenueRequired: 1,
    crossVenueMinMovePercent: 0.03,
    paperNotional: 1_000,
    maxOpenPositions: 3,
    initialStopPercent: 0.7,
    takeProfitPercent: 2.5,
    trailingActivationPercent: 0.8,
    trailingDistancePercent: 0.45,
    momentumExitPercent: -0.25,
    maxHoldSeconds: 300,
    notifyEvents: []
  };
}

function fakeBinanceClient() {
  return {
    async getExchangeInfo() {
      return {
        symbols: [{ symbol: "LABUSDT", status: "TRADING", quoteAsset: "USDT", contractType: "PERPETUAL" }]
      };
    },
    async requestFutures() {
      return [{ symbol: "LABUSDT", lastPrice: "100", quoteVolume: "20000000" }];
    },
    getHealth() {
      return { futures: { lastSuccessAt: new Date(0).toISOString() } };
    }
  };
}

function fakeCrossVenueClient() {
  return {
    async prime() {
      return { availableCount: 2 };
    },
    async confirm() {
      return { availableCount: 2, confirmedCount: 1, sources: [] };
    },
    getHealth() {
      return { gate: {}, bitget: {} };
    }
  };
}

class FakeStream extends EventEmitter {
  constructor(now) {
    super();
    this.now = now;
    this.connected = false;
    this.lastMessageAt = null;
    this.detailedSymbols = [];
  }

  start() {
    this.connected = true;
    this.lastMessageAt = new Date(this.now()).toISOString();
  }

  stop() {
    this.connected = false;
  }

  setDetailedSymbols(symbols) {
    this.detailedSymbols = [...symbols];
  }

  getStatus() {
    return {
      market: { connected: this.connected, lastMessageAt: this.lastMessageAt },
      detail: { connected: this.connected, lastMessageAt: this.lastMessageAt },
      detailedSymbols: this.detailedSymbols
    };
  }

  pushTicker(ticker) {
    this.lastMessageAt = new Date(ticker.eventTime).toISOString();
    this.emit("ticker", ticker);
  }

  pushBook(book) {
    this.lastMessageAt = new Date(book.eventTime).toISOString();
    this.emit("book", book);
  }
}

class MemoryStore {
  constructor() {
    this.events = [];
    this.snapshots = [];
  }

  async initialize() {}

  async append(type, payload, timestamp) {
    const event = { type, timestamp: new Date(timestamp).toISOString(), ...payload };
    this.events.push(event);
    return event;
  }

  async writeSnapshot(snapshot) {
    this.snapshots.push(snapshot);
  }

  async flush() {}
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}
