import test from "node:test";
import assert from "node:assert/strict";
import { MarketMetadataCache } from "../src/marketData/marketMetadataCache.js";

test("MarketMetadataCache reuses fresh metadata and deduplicates concurrent loads", async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new MarketMetadataCache({ ttlMs: 1_000, staleMs: 5_000, now: () => now });
  const loader = async () => {
    loads += 1;
    return { symbols: ["BTCUSDT"] };
  };

  const [first, concurrent] = await Promise.all([
    cache.getOrLoad("futures", loader),
    cache.getOrLoad("futures", loader)
  ]);
  now += 500;
  const cached = await cache.getOrLoad("futures", loader);

  assert.equal(loads, 1);
  assert.equal(first.source, "network");
  assert.deepEqual(concurrent.value, first.value);
  assert.equal(cached.source, "cache");
});

test("MarketMetadataCache serves bounded stale metadata when refresh fails", async () => {
  let now = 1_000;
  const cache = new MarketMetadataCache({ ttlMs: 100, staleMs: 1_000, now: () => now });
  await cache.getOrLoad("spot", async () => ({ version: 1 }));
  now += 200;

  const stale = await cache.getOrLoad("spot", async () => {
    throw new Error("temporary timeout");
  });

  assert.equal(stale.source, "stale-cache");
  assert.equal(stale.stale, true);
  assert.equal(stale.value.version, 1);
  assert.match(stale.fallbackError.message, /timeout/);
});
