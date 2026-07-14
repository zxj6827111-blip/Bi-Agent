import test from "node:test";
import assert from "node:assert/strict";
import { closePaperPosition, openPaperPosition, updatePaperPosition } from "../src/pumpRadar/paperExecution.js";

test("paper execution enters at ask, exits at bid, and charges slippage plus both fees", () => {
  const position = openPaperPosition({
    symbol: "LABUSDT",
    book: { askPrice: 10, bidPrice: 9.99 },
    now: 1_000,
    notional: 1_000,
    feeRate: 0.0005,
    slippagePercent: 0.05
  });
  const closed = closePaperPosition(position, { bidPrice: 10.2, reason: "manual", now: 11_000 });

  assert.ok(Math.abs(position.entryPrice - 10.005) < 1e-12);
  assert.ok(closed.exitPrice < 10.2);
  assert.ok(closed.netPnl < closed.grossPnl);
  assert.equal(closed.holdSeconds, 10);
});

test("paper execution activates trailing protection and waits for two momentum failures", () => {
  const position = openPaperPosition({
    symbol: "BTCUSDT",
    book: { askPrice: 100 },
    now: 0,
    slippagePercent: 0,
    trailingActivationPercent: 0.5,
    trailingDistancePercent: 0.4
  });
  const rising = updatePaperPosition(position, { bidPrice: 101, now: 1_000, move5sPercent: 1, buyRatio: 0.7 });
  const weakOnce = updatePaperPosition(rising.position, { bidPrice: 100.8, now: 2_000, move5sPercent: -0.3, buyRatio: 0.4 });
  const weakTwice = updatePaperPosition(weakOnce.position, { bidPrice: 100.7, now: 3_000, move5sPercent: -0.3, buyRatio: 0.4 });

  assert.ok(rising.position.trailingStopPrice > 100);
  assert.equal(weakOnce.exit, null);
  assert.equal(weakTwice.exit, "momentum_reversal");
});
