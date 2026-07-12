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
});
