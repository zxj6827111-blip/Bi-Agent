import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFromCandles } from "../src/signalEvaluator.js";

const session = {
  id: "session-1",
  startTime: "2026-06-19T00:00:00.000Z",
  endTime: "2026-06-19T00:00:00.000Z"
};

test("evaluateFromCandles marks long signal as tp1 when target is reached first", () => {
  const signal = makeSignal({
    direction: "long",
    entryRange: [99, 101],
    stopLoss: 95,
    takeProfit: { tp1: 105, tp2: 110 }
  });
  const evaluation = evaluateFromCandles({
    id: "eval-1",
    session,
    signal,
    horizonHours: 4,
    candles: [
      candle({ high: 101, low: 99, close: 100, closeTime: 1 }),
      candle({ high: 105.5, low: 100, close: 105, closeTime: 2 })
    ]
  });

  assert.equal(evaluation.status, "completed");
  assert.equal(evaluation.outcome, "tp1");
  assert.equal(evaluation.entryTouched, true);
  assert.ok(evaluation.resultPercent > 0);
  assert.ok(evaluation.netResultPercent < evaluation.resultPercent);
  assert.equal(evaluation.feePercent, 0.1);
  assert.equal(evaluation.slippagePercent, 0.1);
});

test("evaluateFromCandles marks short signal as stop when stop is reached first", () => {
  const signal = makeSignal({
    direction: "short",
    entryRange: [99, 101],
    stopLoss: 104,
    takeProfit: { tp1: 94, tp2: 90 }
  });
  const evaluation = evaluateFromCandles({
    id: "eval-2",
    session,
    signal,
    horizonHours: 4,
    candles: [
      candle({ high: 101, low: 99, close: 100, closeTime: 1 }),
      candle({ high: 104.5, low: 98, close: 104, closeTime: 2 })
    ]
  });

  assert.equal(evaluation.outcome, "stop");
  assert.ok(evaluation.resultPercent < 0);
});

test("evaluateFromCandles uses conservative stop when one candle hits stop and target", () => {
  const signal = makeSignal({
    direction: "spot_buy",
    marketType: "spot",
    entryRange: [99, 101],
    stopLoss: 95,
    takeProfit: { tp1: 105, tp2: 110 }
  });
  const evaluation = evaluateFromCandles({
    id: "eval-same-candle",
    session,
    signal,
    horizonHours: 4,
    candles: [
      candle({ high: 101, low: 99, close: 100, closeTime: 1 }),
      candle({ high: 106, low: 94, close: 102, closeTime: 2 })
    ]
  });

  assert.equal(evaluation.outcome, "stop");
  assert.ok(evaluation.resultPercent < 0);
});

test("evaluateFromCandles handles spot sell as short-like evaluation", () => {
  const signal = makeSignal({
    direction: "spot_sell",
    marketType: "spot",
    entryRange: [99, 101],
    stopLoss: 104,
    takeProfit: { tp1: 94, tp2: 90 }
  });
  const evaluation = evaluateFromCandles({
    id: "eval-spot-sell",
    session,
    signal,
    horizonHours: 4,
    candles: [
      candle({ high: 101, low: 99, close: 100, closeTime: 1 }),
      candle({ high: 100, low: 93.5, close: 94, closeTime: 2 })
    ]
  });

  assert.equal(evaluation.outcome, "tp1");
  assert.ok(evaluation.resultPercent > 0);
});

test("evaluateFromCandles marks no_entry when entry range is never touched", () => {
  const signal = makeSignal({
    direction: "long",
    entryRange: [99, 101],
    stopLoss: 95,
    takeProfit: { tp1: 105, tp2: 110 }
  });
  const evaluation = evaluateFromCandles({
    id: "eval-3",
    session,
    signal,
    horizonHours: 4,
    candles: [
      candle({ high: 110, low: 106, close: 108, closeTime: 1 }),
      candle({ high: 112, low: 107, close: 111, closeTime: 2 })
    ]
  });

  assert.equal(evaluation.outcome, "no_entry");
  assert.equal(evaluation.entryTouched, false);
  assert.equal(evaluation.netResultPercent, 0);
  assert.equal(evaluation.feePercent, 0);
});

function makeSignal(overrides) {
  return {
    id: "signal-1",
    symbol: "BTCUSDT",
    marketType: "futures",
    timeframe: "15m",
    ...overrides
  };
}

function candle({ high, low, close, closeTime }) {
  return {
    open: close,
    high,
    low,
    close,
    volume: 1000,
    closeTime
  };
}
