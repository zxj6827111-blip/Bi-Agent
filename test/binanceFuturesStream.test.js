import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BinanceFuturesStream } from "../src/marketData/binanceFuturesStream.js";

test("BinanceFuturesStream throttles the available all-market book stream and uses dynamic candidate subscriptions", async () => {
  FakeWebSocket.instances = [];
  const stream = new BinanceFuturesStream({
    baseUrl: "wss://example.test",
    WebSocketClass: FakeWebSocket,
    heartbeatMs: 60_000
  });
  const tickers = [];
  const books = [];
  const trades = [];
  const depths = [];
  stream.on("ticker", (value) => tickers.push(value));
  stream.on("book", (value) => books.push(value));
  stream.on("trade", (value) => trades.push(value));
  stream.on("depth", (value) => depths.push(value));

  stream.start();
  assert.match(FakeWebSocket.instances[0].url, /!bookTicker$/);
  FakeWebSocket.instances.forEach((socket) => socket.open());
  stream.setDetailedSymbols(["LABUSDT"]);

  const detail = FakeWebSocket.instances[1];
  const subscribe = JSON.parse(detail.sent.at(-1));
  assert.deepEqual(subscribe.params.sort(), [
    "labusdt@aggTrade",
    "labusdt@bookTicker",
    "labusdt@depth20@100ms"
  ]);

  FakeWebSocket.instances[0].message({ e: "bookTicker", E: 1_000, s: "LABUSDT", b: "9.99", B: "10", a: "10.01", A: "11" });
  detail.message({ e: "bookTicker", E: 1_001, s: "LABUSDT", b: "9.99", B: "10", a: "10", A: "11" });
  detail.message({ e: "aggTrade", E: 1_002, T: 1_002, s: "LABUSDT", p: "10", q: "5", m: false });
  detail.message({ e: "depthUpdate", E: 1_003, T: 1_003, s: "LABUSDT", b: [["9.99", "10"]], a: [["10", "5"]] });

  assert.equal(tickers[0].closePrice, 10);
  assert.equal(tickers[0].source, "bookTicker");
  assert.equal(books[0].askPrice, 10);
  assert.equal(trades[0].buy, true);
  assert.ok(depths[0].imbalance > 0);
  stream.stop();
});

test("BinanceFuturesStream reconnects a dropped socket and rejects out-of-band JSON safely", async () => {
  FakeWebSocket.instances = [];
  const stream = new BinanceFuturesStream({
    baseUrl: "wss://example.test",
    WebSocketClass: FakeWebSocket,
    reconnectBaseMs: 1,
    reconnectMaxMs: 1,
    heartbeatMs: 60_000
  });
  stream.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  FakeWebSocket.instances[0].emit("message", Buffer.from("not-json"));
  FakeWebSocket.instances[0].drop();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(FakeWebSocket.instances.length >= 3);
  assert.ok(stream.getStatus().market.reconnectCount >= 1);
  stream.stop();
});

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(value) {
    this.sent.push(value);
  }

  message(value) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  ping() {}

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.drop();
  }

  drop() {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.alloc(0));
  }
}
