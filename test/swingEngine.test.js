import test from "node:test";
import assert from "node:assert/strict";
import { buildSwingAnalysis } from "../src/swingEngine.js";

const MARKET = {
  symbol: "TESTUSDT",
  marketType: "futures",
  actualMarketType: "futures",
  quoteVolume: 80_000_000,
  spreadPercent: 0.03,
  lastPrice: 1
};

function makeCandles(prices, volumes = []) {
  const start = Date.now() - prices.length * 60_000;
  return prices.map((price, index) => {
    const previous = prices[index - 1] ?? price;
    const open = previous;
    const close = price;
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    const volume = volumes[index] ?? 1000;
    return {
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: close * volume,
      closeTime: start + index * 60_000
    };
  });
}

test("buildSwingAnalysis highlights low-zone rebound with volume", () => {
  const prices = Array.from({ length: 78 }, (_, index) => 1 - index * 0.0032);
  prices.push(0.724, 0.752);
  const volumes = prices.map((_, index) => index >= 78 ? 2600 : 900);
  const candles = makeCandles(prices, volumes);
  candles[candles.length - 1].low = 0.718;
  candles[candles.length - 1].open = 0.732;
  candles[candles.length - 1].close = 0.752;

  const result = buildSwingAnalysis({
    market: MARKET,
    candlesByInterval: { "1m": candles },
    snapshots: [{ interval: "15m", trend: "down" }]
  });

  assert.equal(result.mode, "swing");
  assert.ok(["buy_confirm", "low_watch"].includes(result.bottom.action));
  assert.ok(["buy_confirm", "low_watch", "wait"].includes(result.action));
  assert.ok(result.lowZone[0] < result.lowZone[1]);
  assert.ok(result.bottom.score >= 60);
});

test("buildSwingAnalysis highlights high-zone sell or short setup", () => {
  const prices = Array.from({ length: 78 }, (_, index) => 0.7 + index * 0.003);
  prices.push(0.94, 0.918);
  const volumes = prices.map((_, index) => index >= 78 ? 2800 : 900);
  const candles = makeCandles(prices, volumes);
  candles[candles.length - 1].high = 0.955;
  candles[candles.length - 1].open = 0.945;
  candles[candles.length - 1].close = 0.918;

  const result = buildSwingAnalysis({
    market: MARKET,
    candlesByInterval: { "1m": candles },
    snapshots: [{ interval: "15m", trend: "down" }]
  });

  assert.equal(result.mode, "swing");
  assert.ok(["short_confirm", "sell_confirm", "high_watch"].includes(result.top.action));
  assert.ok(["short_confirm", "sell_confirm", "high_watch", "wait"].includes(result.action));
  assert.ok(result.highZone[0] < result.highZone[1]);
  assert.ok(result.top.score >= 60);
});
