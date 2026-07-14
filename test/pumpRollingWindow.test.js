import test from "node:test";
import assert from "node:assert/strict";
import { RollingPriceWindow, RollingTradeWindow } from "../src/pumpRadar/rollingWindow.js";

test("RollingPriceWindow measures multiple pump horizons and ignores out-of-order points", () => {
  const window = new RollingPriceWindow({ maxAgeMs: 70_000 });
  for (let seconds = 0; seconds <= 60; seconds += 5) {
    window.add(seconds * 1_000, 100 + seconds * 0.1);
  }

  assert.equal(window.add(59_000, 999), false);
  assert.ok(Math.abs(window.changePercent(10_000, 60_000) - 0.95238) < 0.0001);
  assert.equal(window.snapshot(60_000).pointCount, 13);
});

test("RollingTradeWindow calculates aggressive buy ratio over the requested interval", () => {
  const window = new RollingTradeWindow({ maxAgeMs: 20_000 });
  window.add({ eventTime: 1_000, price: 100, quantity: 1, buy: true });
  window.add({ eventTime: 2_000, price: 100, quantity: 0.5, buy: false });
  window.add({ eventTime: 11_000, price: 101, quantity: 2, buy: true });

  const stats = window.stats(10_000, 11_000);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalQuote, 352);
  assert.ok(stats.buyRatio > 0.85);
});
