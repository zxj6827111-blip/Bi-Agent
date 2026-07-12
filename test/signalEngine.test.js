import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketSnapshot, filterTradableSymbols, generateSignalsFromSnapshot, rankSignals, screenSignalsForQuality } from "../src/signalEngine.js";

test("filterTradableSymbols removes low liquidity and high spread markets", () => {
  const symbols = [
    { symbol: "BTCUSDT", baseAsset: "BTC", lastPrice: 100, quoteVolume: 100_000_000, spreadPercent: 0.01 },
    { symbol: "USDCUSDT", baseAsset: "USDC", lastPrice: 1, quoteVolume: 100_000_000, spreadPercent: 0.01 },
    { symbol: "LOWUSDT", baseAsset: "LOW", lastPrice: 1, quoteVolume: 10, spreadPercent: 0.01 },
    { symbol: "WIDEUSDT", baseAsset: "WIDE", lastPrice: 1, quoteVolume: 100_000_000, spreadPercent: 2 }
  ];

  const result = filterTradableSymbols(symbols, {
    minQuoteVolume: 1_000_000,
    maxSpreadPercent: 0.5
  });

  assert.deepEqual(result.map((item) => item.symbol), ["BTCUSDT"]);
});

test("screenSignalsForQuality removes low risk/reward signals", () => {
  const signal = {
    id: "spot:BTCUSDT:15m:spot_buy",
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_buy",
    timeframe: "15m",
    score: 82,
    riskReward: 0.8,
    marketSnapshot: { quoteVolume: 100_000_000 }
  };
  const result = screenSignalsForQuality([signal], [], 5);

  assert.equal(result.length, 0);
});

test("screenSignalsForQuality keeps signals with supportive higher timeframe", () => {
  const signal = {
    id: "spot:BTCUSDT:15m:spot_buy",
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_buy",
    timeframe: "15m",
    score: 80,
    riskReward: 2.1,
    marketSnapshot: makeSnapshot({ interval: "15m", supportDistancePercent: 1.5, resistanceDistancePercent: 3.2 })
  };
  const snapshots = [
    {
      symbol: "BTCUSDT",
      marketType: "spot",
      interval: "1h",
      trend: "up",
      indicators: { rsi: 55, macdHistogram: 1, volumeRatio: 1.3 }
    }
  ];

  const result = screenSignalsForQuality([signal], snapshots, 5);

  assert.equal(result.length, 1);
  assert.equal(result[0].quality.status, "actionable");
  assert.ok(result[0].score > signal.score);
});

test("screenSignalsForQuality rejects 1h spot buy as direct entry", () => {
  const signal = {
    id: "spot:BTCUSDT:1h:spot_buy",
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_buy",
    timeframe: "1h",
    score: 86,
    riskReward: 2.2,
    marketSnapshot: makeSnapshot({ interval: "1h", supportDistancePercent: 1.1, resistanceDistancePercent: 4 })
  };
  const snapshots = [
    makeSnapshot({ interval: "4h", trend: "up" })
  ];

  const result = screenSignalsForQuality([signal], snapshots, 5);

  assert.equal(result.length, 0);
});

test("generateSignalsFromSnapshot does not create direct 4h entry signals", () => {
  const snapshot = makeSnapshot({
    interval: "4h",
    trend: "up",
    rsi: 56,
    macdHistogram: 0.8,
    volumeRatio: 2
  });

  const signals = generateSignalsFromSnapshot(snapshot);

  assert.equal(signals.length, 0);
});

test("screenSignalsForQuality tightens spot buy without affecting futures long", () => {
  const spotBuy = {
    id: "spot:BTCUSDT:15m:spot_buy",
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_buy",
    timeframe: "15m",
    score: 82,
    riskReward: 1.3,
    marketSnapshot: makeSnapshot({ interval: "15m", supportDistancePercent: 1.2, priceChangePercent24h: 2 })
  };
  const futuresLong = {
    ...spotBuy,
    id: "futures:BTCUSDT:15m:long",
    marketType: "futures",
    direction: "long"
  };
  const snapshots = [
    makeSnapshot({ interval: "1h", trend: "up" }),
    makeSnapshot({ interval: "4h", trend: "up" })
  ];

  const spotResult = screenSignalsForQuality([spotBuy], snapshots, 5);
  const futuresResult = screenSignalsForQuality([futuresLong], snapshots, 5);

  assert.equal(spotResult.length, 0);
  assert.equal(futuresResult.length, 1);
});

test("screenSignalsForQuality rejects spot buy when higher timeframe conflicts", () => {
  const signal = {
    id: "spot:BTCUSDT:15m:spot_buy",
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_buy",
    timeframe: "15m",
    score: 84,
    riskReward: 2.2,
    marketSnapshot: makeSnapshot({ interval: "15m", supportDistancePercent: 1.2, priceChangePercent24h: 2 })
  };
  const snapshots = [
    makeSnapshot({ interval: "1h", trend: "down" }),
    makeSnapshot({ interval: "4h", trend: "up" })
  ];

  const result = screenSignalsForQuality([signal], snapshots, 5);

  assert.equal(result.length, 0);
});

test("screenSignalsForQuality prefers 15m when score ties", () => {
  const shared = {
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_sell",
    score: 75,
    riskReward: 1.6,
    marketSnapshot: makeSnapshot({
      trend: "down",
      rsi: 72,
      supportDistancePercent: 3,
      volumeRatio: 1.5
    })
  };
  const signals = [
    { ...shared, id: "spot:BTCUSDT:1h:spot_sell", timeframe: "1h" },
    { ...shared, id: "spot:BTCUSDT:15m:spot_sell", timeframe: "15m" }
  ];
  const snapshots = [
    makeSnapshot({ interval: "1h", trend: "down" }),
    makeSnapshot({ interval: "4h", trend: "down" })
  ];

  const result = screenSignalsForQuality(signals, snapshots, 2);

  assert.equal(result[0].timeframe, "15m");
});

test("generateSignalsFromSnapshot can produce ranked spot buy signals", () => {
  const candles = Array.from({ length: 120 }, (_, index) => {
    const base = index < 70 ? 100 + index * 0.12 : 108 - (index - 70) * 0.06;
    const recovery = index > 95 ? (index - 95) * 0.22 : 0;
    const close = base + recovery + Math.sin(index / 5) * 0.6;
    return {
      open: close - 0.3,
      high: close + 1,
      low: close - 1,
      close,
      volume: index > 110 ? 3000 : 1000,
      quoteVolume: close * 1000
    };
  });
  const market = {
    symbol: "BTCUSDT",
    marketType: "spot",
    quoteVolume: 500_000_000,
    spreadPercent: 0.02,
    priceChangePercent: 4,
    fundingRate: null
  };
  const snapshot = buildMarketSnapshot({ market, interval: "1h", candles });
  const signals = generateSignalsFromSnapshot(snapshot);
  const ranked = rankSignals(signals, 5);
  const buySignal = ranked.find((signal) => signal.direction === "spot_buy");

  assert.ok(ranked.length >= 1);
  assert.ok(buySignal);
  assert.equal(buySignal.symbol, "BTCUSDT");
  assert.ok(buySignal.entryRange.length === 2);
  assert.ok(buySignal.stopLoss > 0);
  const entryMid = (buySignal.entryRange[0] + buySignal.entryRange[1]) / 2;
  assert.ok(buySignal.stopLoss < entryMid);
  assert.ok(buySignal.takeProfit.tp1 > entryMid);
  assert.ok(buySignal.takeProfit.tp2 > buySignal.takeProfit.tp1);
});

test("buildMarketSnapshot ignores an unclosed live candle", () => {
  const nowMs = 1_700_000_000_000;
  const candles = Array.from({ length: 25 }, (_, index) => {
    const close = 100 + index;
    return {
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: index === 24 ? 2000 : 1000,
      quoteVolume: close * 1000,
      closeTime: nowMs - (25 - index) * 60_000
    };
  });
  candles.push({
    open: 200,
    high: 205,
    low: 195,
    close: 204,
    volume: 1,
    quoteVolume: 204,
    closeTime: nowMs + 60_000
  });
  const market = {
    symbol: "BTCUSDT",
    marketType: "spot",
    quoteVolume: 500_000_000,
    spreadPercent: 0.02,
    priceChangePercent: 1,
    fundingRate: null
  };

  const snapshot = buildMarketSnapshot({ market, interval: "5m", candles, nowMs });

  assert.equal(snapshot.price, 124);
  assert.equal(snapshot.indicators.volumeRatio, 2);
  assert.equal(snapshot.candleWindow.inputCandles, 26);
  assert.equal(snapshot.candleWindow.usedClosedCandles, 25);
  assert.equal(snapshot.candleWindow.droppedUnclosedCandles, 1);
});

function makeSnapshot({
  symbol = "BTCUSDT",
  marketType = "spot",
  interval = "15m",
  trend = "up",
  rsi = 55,
  macdHistogram = 0.5,
  volumeRatio = 1.6,
  supportDistancePercent = 1.5,
  resistanceDistancePercent = 3,
  priceChangePercent24h = 2,
  quoteVolume = 100_000_000
} = {}) {
  return {
    symbol,
    marketType,
    interval,
    price: 100,
    quoteVolume,
    spreadPercent: 0.02,
    priceChangePercent24h,
    fundingRate: marketType === "futures" ? 0 : null,
    indicators: {
      rsi,
      macdHistogram,
      atr: 1,
      volumeRatio
    },
    supportResistance: {
      support: 98.5,
      resistance: 103,
      supportDistancePercent,
      resistanceDistancePercent
    },
    trend,
    volatilityPercent: 1.5,
    candleChangePercent: 0.8
  };
}
