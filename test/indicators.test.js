import test from "node:test";
import assert from "node:assert/strict";
import { atr, bollingerBands, macd, normalizeKlines, rsi, supportResistance } from "../src/indicators.js";

test("normalizeKlines converts Binance rows into numeric candles", () => {
  const candles = normalizeKlines([
    [1, "10", "12", "9", "11", "100", 2, "1100"]
  ]);

  assert.deepEqual(candles[0], {
    openTime: 1,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    closeTime: 2,
    quoteVolume: 1100
  });
});

test("technical indicators return stable numeric values", () => {
  const values = Array.from({ length: 80 }, (_, index) => 100 + index * 0.7 + Math.sin(index / 3));
  const candles = values.map((close, index) => ({
    open: close - 0.4,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000 + index * 10
  }));

  assert.equal(typeof rsi(values), "number");
  assert.equal(typeof macd(values).histogram, "number");
  assert.equal(typeof bollingerBands(values).upper, "number");
  assert.equal(typeof atr(candles), "number");
  assert.ok(supportResistance(candles).resistance > supportResistance(candles).support);
});
