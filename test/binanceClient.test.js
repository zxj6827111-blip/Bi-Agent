import test from "node:test";
import assert from "node:assert/strict";
import { BinanceClient } from "../src/binanceClient.js";

test("BinanceClient retries fallback endpoints before failing a market request", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url.toString());
    if (requestedUrls.length === 1) {
      const error = new Error("connect timeout");
      error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
      throw error;
    }
    return new Response(JSON.stringify({
      lastUpdateId: 1,
      bids: [["100", "2"]],
      asks: [["101", "1"]]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new BinanceClient({
    spotBaseUrls: ["https://bad.example", "https://good.example"],
    futuresBaseUrl: "https://fapi.binance.com",
    requestTimeoutMs: 100
  });

  const book = await client.getOrderBookDepth("spot", "BTCUSDT", 5);

  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls[0].startsWith("https://bad.example/api/v3/depth"));
  assert.ok(requestedUrls[1].startsWith("https://good.example/api/v3/depth"));
  assert.equal(book.bestBid, 100);
  assert.equal(book.bestAsk, 101);
  assert.equal(client.getHealth().spot.status, "degraded");
  assert.equal(client.getHealth().spot.errorKind, "timeout");
  assert.equal(client.getHealth().spot.lastFallbackErrors.length, 1);
});

test("BinanceClient retries a transient timeout once and exposes request health", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      const error = new Error("fetch failed");
      error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
      throw error;
    }
    return new Response(JSON.stringify({ lastUpdateId: 1, bids: [["1", "1"]], asks: [["2", "1"]] }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const client = new BinanceClient({
    spotBaseUrl: "https://data-api.binance.vision",
    futuresBaseUrl: "https://fapi.binance.com",
    requestRetryCount: 1,
    requestRetryBaseDelayMs: 0
  });

  await client.getOrderBookDepth("spot", "BTCUSDT", 5);

  assert.equal(requests, 2);
  assert.equal(client.getHealth().spot.successCount, 1);
  assert.equal(client.getHealth().spot.failureCount, 0);
  assert.equal(client.getHealth().spot.status, "degraded");
});

test("BinanceClient retries EAI_AGAIN and classifies the recovered request as DNS degradation", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      const error = new Error("fetch failed");
      error.cause = { code: "EAI_AGAIN" };
      throw error;
    }
    return new Response(JSON.stringify({ lastUpdateId: 1, bids: [["1", "1"]], asks: [["2", "1"]] }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const client = new BinanceClient({
    spotBaseUrl: "https://data-api.binance.vision",
    futuresBaseUrl: "https://fapi.binance.com",
    requestRetryCount: 1,
    requestRetryBaseDelayMs: 0
  });

  await client.getOrderBookDepth("spot", "BTCUSDT", 5);

  assert.equal(requests, 2);
  assert.equal(client.getHealth().spot.status, "degraded");
  assert.equal(client.getHealth().spot.errorKind, "dns");
  assert.equal(client.getHealth().spot.lastFallbackErrors[0].cause, "EAI_AGAIN");
});

test("BinanceClient does not retry a permanent HTTP 451 response", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("restricted", { status: 451, statusText: "Unavailable For Legal Reasons" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const client = new BinanceClient({
    spotBaseUrl: "https://api.binance.com",
    futuresBaseUrl: "https://fapi.binance.com",
    requestRetryCount: 3,
    requestRetryBaseDelayMs: 0
  });

  await assert.rejects(
    () => client.getOrderBookDepth("spot", "BTCUSDT", 5),
    /path=\/api\/v3\/depth attempts=1/
  );
  assert.equal(requests, 1);
  assert.equal(client.getHealth().spot.failureCount, 1);
  assert.equal(client.getHealth().spot.status, "unavailable");
  assert.equal(client.getHealth().spot.errorKind, "restricted");
  assert.equal(client.getHealth().spot.statusCode, 451);
});

test("BinanceClient caches exchangeInfo while continuing to refresh ticker and book data", async (t) => {
  const originalFetch = globalThis.fetch;
  const counts = new Map();
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    counts.set(path, (counts.get(path) || 0) + 1);
    if (path.endsWith("exchangeInfo")) {
      return new Response(JSON.stringify({ symbols: [{ status: "TRADING", symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" }] }), { status: 200 });
    }
    if (path.endsWith("bookTicker")) {
      return new Response(JSON.stringify([{ symbol: "BTCUSDT", bidPrice: "100", askPrice: "101", bidQty: "1", askQty: "1" }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "100", quoteVolume: "20000000" }]), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const client = new BinanceClient({
    spotBaseUrl: "https://data-api.binance.vision",
    futuresBaseUrl: "https://fapi.binance.com",
    metadataCacheMs: 60_000
  });

  await client.getSpotSymbols();
  await client.getSpotSymbols();

  assert.equal(counts.get("/api/v3/exchangeInfo"), 1);
  assert.equal(counts.get("/api/v3/ticker/24hr"), 2);
  assert.equal(client.getHealth().metadata.spot.source, "cache");
});
