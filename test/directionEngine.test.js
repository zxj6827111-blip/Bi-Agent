import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectionAnalysis,
  buildMarketRegime,
  computeCVD,
  computeOIDivergence,
  directionBlocksSignal,
  directionScoreAdjustment,
  enrichMarketWithDirection
} from "../src/directionEngine.js";

test("computeOIDivergence uses positive scores for bullish bias and negative scores for bearish bias", () => {
  assert.equal(computeOIDivergence(3, 2).score, 8);
  assert.equal(computeOIDivergence(3, -2).score, -8);
  assert.equal(computeOIDivergence(-3, 2).score, -8);
  assert.equal(computeOIDivergence(-3, -2).score, 5);
});

test("computeCVD normalizes order flow and keeps a stable empty result contract", () => {
  const now = Date.now();
  assert.deepEqual(computeCVD([]), { cvd: 0, cvdPerMinute: 0, score: 0, divergence: "neutral" });
  const result = computeCVD([
    { side: "buy", quoteQuantity: 75, time: now - 2000 },
    { side: "sell", quoteQuantity: 25, time: now - 1000 },
    { side: "invalid", quoteQuantity: 999, time: now }
  ]);
  assert.equal(result.cvd, 50);
  assert.equal(result.score, 50);
});

test("computeCVD only reports divergence when price and order flow disagree", () => {
  const now = Date.now();
  const bullishDivergence = computeCVD([
    { side: "sell", quoteQuantity: 100, price: 102, time: now - 240_000 },
    { side: "buy", quoteQuantity: 120, price: 100, time: now - 10_000 }
  ]);
  const noDivergence = computeCVD([
    { side: "sell", quoteQuantity: 100, price: 100, time: now - 240_000 },
    { side: "buy", quoteQuantity: 120, price: 102, time: now - 10_000 }
  ]);

  assert.equal(bullishDivergence.divergence, "bullish_reversal");
  assert.equal(noDivergence.divergence, "bullish");
});

test("direction engine marks aligned order flow and market regime as up", () => {
  const regime = buildMarketRegime({
    spotMarkets: [
      makeMarket({ symbol: "BTCUSDT", priceChangePercent: 2, quoteVolume: 1_000_000_000 }),
      makeMarket({ symbol: "ETHUSDT", priceChangePercent: 1.5, quoteVolume: 800_000_000 }),
      makeMarket({ symbol: "SOLUSDT", priceChangePercent: 4, quoteVolume: 500_000_000 })
    ]
  });
  const market = makeMarket({ symbol: "SOLUSDT", priceChangePercent: 4 });
  const analysis = buildDirectionAnalysis({
    market,
    regime,
    microstructure: {
      status: "ok",
      orderBook: makeOrderBook({ imbalance: 0.42 }),
      aggressiveTrades: makeTrades({ buy: 800_000, sell: 200_000 })
    }
  });

  assert.equal(analysis.direction, "up");
  assert.ok(analysis.edgeScore >= 35);
  assert.ok(analysis.probabilityUp > 0.5);
  assert.ok(directionScoreAdjustment(analysis, "long") > 0);
});

test("direction engine blocks long signals when live edge is bearish", () => {
  const analysis = buildDirectionAnalysis({
    market: makeMarket({ priceChangePercent: -4 }),
    regime: buildMarketRegime({
      spotMarkets: [
        makeMarket({ symbol: "BTCUSDT", priceChangePercent: -2 }),
        makeMarket({ symbol: "ETHUSDT", priceChangePercent: -3 }),
        makeMarket({ symbol: "SOLUSDT", priceChangePercent: -4 })
      ]
    }),
    microstructure: {
      status: "ok",
      orderBook: makeOrderBook({ imbalance: -0.5 }),
      aggressiveTrades: makeTrades({ buy: 100_000, sell: 900_000 })
    }
  });

  assert.equal(analysis.direction, "down");
  assert.ok(directionBlocksSignal(analysis, "long").length > 0);
  assert.ok(directionScoreAdjustment(analysis, "short") > 0);
});

test("enrichMarketWithDirection attaches compact microstructure and analysis", () => {
  const result = enrichMarketWithDirection({
    market: makeMarket(),
    regime: buildMarketRegime({ spotMarkets: [makeMarket()] }),
    microstructure: {
      status: "partial",
      orderBook: makeOrderBook({ imbalance: 0.1 }),
      aggressiveTrades: []
    }
  });

  assert.ok(result.directionAnalysis);
  assert.ok(result.microstructure);
  assert.equal(result.microstructure.status, "partial");
});

function makeMarket(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    marketType: "spot",
    priceChangePercent: 1,
    quoteVolume: 100_000_000,
    ...overrides
  };
}

function makeOrderBook({ imbalance = 0 } = {}) {
  const bidNotional = 1_000_000 * (1 + Math.max(imbalance, 0));
  const askNotional = 1_000_000 * (1 + Math.max(-imbalance, 0));
  return {
    bids: [],
    asks: [],
    bidNotional,
    askNotional,
    totalNotional: bidNotional + askNotional,
    imbalance: (bidNotional - askNotional) / (bidNotional + askNotional),
    bestBid: 99.9,
    bestAsk: 100.1,
    spreadPercent: 0.02,
    largestBidWall: { price: 99.5, quantity: 100, notional: bidNotional * 0.4, distancePercent: -0.5 },
    largestAskWall: { price: 100.5, quantity: 80, notional: askNotional * 0.25, distancePercent: 0.5 }
  };
}

function makeTrades({ buy, sell }) {
  return [
    { side: "buy", quoteQuantity: buy, price: 100, quantity: buy / 100 },
    { side: "sell", quoteQuantity: sell, price: 100, quantity: sell / 100 }
  ];
}
