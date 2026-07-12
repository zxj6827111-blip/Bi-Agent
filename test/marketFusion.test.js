import test from "node:test";
import assert from "node:assert/strict";
import { enrichMarketWithFusion, fusionBlocksSignal, fusionScoreAdjustment } from "../src/marketFusion.js";

test("market fusion rewards aligned futures long context", () => {
  const market = enrichMarketWithFusion({
    market: makeFuturesMarket({ priceChangePercent: 2 }),
    catalog: {
      spot: [makeSpotMarket({ orderBookImbalance: 0.22 })],
      futures: [makeFuturesMarket({ orderBookImbalance: 0.18, priceChangePercent: 2 })]
    },
    derivatives: {
      status: "ok",
      fundingRate: 0.0001,
      openInterestChangePercent: 1.2,
      longShortAccountRatio: 1.2,
      topLongShortPositionRatio: 1.1
    }
  });

  assert.equal(market.fusion.bias, "bullish");
  assert.ok(fusionScoreAdjustment(market.fusion, "long", { marketType: "futures" }) > 0);
});

test("market fusion blocks proxy futures formal signals", () => {
  const blockers = fusionBlocksSignal(
    { status: "proxy", longScore: 0, shortScore: 0, derivatives: {} },
    "long",
    { marketType: "futures", isFuturesProxy: true }
  );

  assert.ok(blockers.some((item) => item.includes("合约接口不可用")));
});

function makeSpotMarket(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    marketType: "spot",
    lastPrice: 100,
    priceChangePercent: 1,
    quoteVolume: 500_000_000,
    spreadPercent: 0.02,
    orderBookImbalance: 0,
    topOfBookNotional: 1_000_000,
    ...overrides
  };
}

function makeFuturesMarket(overrides = {}) {
  return {
    ...makeSpotMarket(overrides),
    marketType: "futures",
    fundingRate: 0.0001
  };
}
