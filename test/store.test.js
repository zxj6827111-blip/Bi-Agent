import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEvaluationRows } from "../src/store.js";

test("summarizeEvaluationRows groups completed evaluations and pending reasons", () => {
  const summary = summarizeEvaluationRows([
    makeEvaluation({
      marketType: "spot",
      direction: "spot_buy",
      timeframe: "15m",
      horizonHours: 4,
      outcome: "tp1",
      resultPercent: 1.2
    }),
    makeEvaluation({
      marketType: "spot",
      direction: "spot_buy",
      timeframe: "15m",
      horizonHours: 4,
      outcome: "stop",
      resultPercent: -0.8
    }),
    makeEvaluation({
      marketType: "spot",
      direction: "spot_sell",
      timeframe: "1h",
      horizonHours: 24,
      outcome: "no_entry",
      entryTouched: false
    }),
    makeEvaluation({
      status: "pending",
      outcome: "pending",
      details: { reason: "horizon_not_reached" }
    })
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.completed, 3);
  assert.equal(summary.pending, 1);
  assert.equal(summary.pendingByReason.horizon_not_reached, 1);
  assert.equal(summary.byMarketType.spot.total, 3);
  assert.equal(summary.byDirection.spot_buy.winRate, 0.5);
  assert.equal(summary.byTimeframe["15m"].total, 2);
  assert.equal(summary.bySignalGroup["spot:spot_buy:15m:4h"].total, 2);
  assert.equal(summary.bySignalGroup["spot:spot_buy:15m:4h"].avgResultPercent, 0.19999999999999996);
  assert.equal(summary.bySignalGroup["spot:spot_buy:15m:4h"].profitFactor, 1.5);
  assert.equal(summary.performance.profitFactor, 1.5);
  assert.ok(summary.performance.maxDrawdownPercent >= 0);
});

function makeEvaluation(overrides = {}) {
  return {
    id: "eval-1",
    sessionId: "session-1",
    signalId: "signal-1",
    symbol: "BTCUSDT",
    marketType: "spot",
    direction: "spot_buy",
    timeframe: "15m",
    horizonHours: 4,
    status: "completed",
    outcome: "expired",
    entryTouched: true,
    entryTime: null,
    exitTime: null,
    exitPrice: null,
    maxFavorablePercent: 0,
    maxAdversePercent: 0,
    resultPercent: 0,
    details: {},
    evaluatedAt: "2026-06-19T00:00:00.000Z",
    ...overrides
  };
}
