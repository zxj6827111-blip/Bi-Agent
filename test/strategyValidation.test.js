import test from "node:test";
import assert from "node:assert/strict";
import { strategyGroupKey, summarizeEvaluationSet, validationStatus } from "../src/strategyValidation.js";

const validation = {
  minCompletedTrades: 2,
  minWinRate: 0.5,
  minExpectancyPercent: 0,
  maxDrawdownPercent: 5
};

test("strategyGroupKey groups market, direction, timeframe and horizon", () => {
  assert.equal(strategyGroupKey({
    marketType: "spot",
    direction: "spot_sell",
    timeframe: "15m",
    horizonHours: 4
  }), "spot:spot_sell:15m:4h");
});

test("summarizeEvaluationSet exposes formal candidates by strategy group", () => {
  const summary = summarizeEvaluationSet([
    evaluation({ id: "a", direction: "spot_sell", timeframe: "15m", netResultPercent: 1.2, outcome: "tp1" }),
    evaluation({ id: "b", direction: "spot_sell", timeframe: "15m", netResultPercent: -0.4, outcome: "stop" }),
    evaluation({ id: "c", direction: "spot_buy", timeframe: "1h", netResultPercent: -1.1, outcome: "expired" }),
    evaluation({ id: "d", direction: "spot_buy", timeframe: "1h", netResultPercent: -0.6, outcome: "expired" })
  ], { validation });

  assert.equal(summary.completed, 4);
  assert.equal(summary.byStrategyGroup["spot:spot_sell:15m:4h"].validation.status, "passed");
  assert.equal(summary.byStrategyGroup["spot:spot_buy:1h:4h"].validation.status, "insufficient_or_failed");
  assert.deepEqual(summary.formalCandidates.map((item) => item.key), ["spot:spot_sell:15m:4h"]);
});

test("validationStatus fails when sample count is too small", () => {
  const status = validationStatus([
    evaluation({ id: "a", netResultPercent: 1.2, outcome: "tp1" })
  ], undefined, validation);

  assert.equal(status.status, "insufficient_or_failed");
  assert.equal(status.completedTrades, 1);
});

function evaluation(overrides = {}) {
  return {
    id: overrides.id || "item",
    status: "completed",
    marketType: "spot",
    direction: overrides.direction || "spot_sell",
    timeframe: overrides.timeframe || "15m",
    horizonHours: 4,
    outcome: overrides.outcome || "tp1",
    netResultPercent: overrides.netResultPercent ?? 1,
    ...overrides
  };
}
